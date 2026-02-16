-- POS QR approval/print workflow

alter table public.orders
  add column if not exists rejection_reason text;

create table if not exists public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  ingredient_id uuid not null references public.inventory_ingredients(id) on delete restrict,
  order_id uuid references public.orders(id) on delete restrict,
  movement_type text not null,
  qty_delta numeric(14,3) not null,
  note text,
  created_at timestamptz not null default timezone('utc', now())
);

alter table public.inventory_movements enable row level security;

create policy inventory_movements_staff_all on public.inventory_movements
for all using (app.is_staff()) with check (app.is_staff());

create index if not exists idx_inventory_movements_order_created
  on public.inventory_movements(order_id, created_at desc);

create index if not exists idx_inventory_movements_ingredient_created
  on public.inventory_movements(ingredient_id, created_at desc);

create trigger trg_no_delete_inventory_movements
before delete on public.inventory_movements
for each row execute function app.prevent_delete();

create or replace function public.pos_recompute_bill(p_session_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_subtotal numeric(12,2);
  v_bill_id uuid;
  v_existing_discount numeric(12,2);
  v_existing_delivery_fee numeric(12,2);
begin
  if not app.is_staff() then
    raise exception 'Unauthorized';
  end if;

  select coalesce(sum((mi.price + coalesce(mods.mod_total, 0)) * oi.qty), 0)::numeric(12,2)
    into v_subtotal
  from public.orders o
  join public.order_items oi on oi.order_id = o.id and oi.deleted_at is null
  join public.menu_items mi on mi.id = oi.menu_item_id
  left join lateral (
    select coalesce(sum(m.price_delta), 0)::numeric(12,2) as mod_total
    from jsonb_array_elements(coalesce(oi.selected_modifiers, '[]'::jsonb)) sm
    join public.modifiers m
      on m.id = (sm->>'id')::uuid
     and m.deleted_at is null
  ) mods on true
  where o.session_id = p_session_id
    and o.status in ('accepted', 'printed', 'paid')
    and o.deleted_at is null;

  select b.id, b.discount_amount, b.delivery_fee
    into v_bill_id, v_existing_discount, v_existing_delivery_fee
  from public.bills b
  where b.session_id = p_session_id
    and b.deleted_at is null
  limit 1;

  if v_bill_id is null then
    insert into public.bills(session_id, subtotal, discount_amount, delivery_fee)
    values (p_session_id, v_subtotal, 0, 0)
    returning id into v_bill_id;
  else
    update public.bills b
    set subtotal = v_subtotal,
        discount_amount = coalesce(v_existing_discount, 0),
        delivery_fee = coalesce(v_existing_delivery_fee, 0),
        updated_at = timezone('utc', now())
    where b.id = v_bill_id;
  end if;

  return v_bill_id;
end;
$$;

revoke all on function public.pos_recompute_bill(uuid) from public;
grant execute on function public.pos_recompute_bill(uuid) to authenticated;

create or replace function public.pos_get_pending_qr_queue(p_session_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payload jsonb;
begin
  if not app.is_staff() then
    raise exception 'Unauthorized';
  end if;

  select coalesce(jsonb_agg(row_to_json(x) order by x.created_at asc), '[]'::jsonb)
    into v_payload
  from (
    select o.id as order_id,
           o.session_id,
           s.table_number,
           o.created_at,
           o.customer_note,
           (
             select coalesce(jsonb_agg(row_to_json(oi)), '[]'::jsonb)
             from (
               select oi.id,
                      oi.menu_item_id,
                      mi.name as menu_item_name,
                      oi.qty,
                      oi.notes,
                      oi.selected_modifiers
               from public.order_items oi
               join public.menu_items mi on mi.id = oi.menu_item_id
               where oi.order_id = o.id
                 and oi.deleted_at is null
             ) oi
           ) as items
    from public.orders o
    join public.sessions s on s.id = o.session_id
    where o.status = 'pending'
      and o.source = 'qr'
      and o.deleted_at is null
      and s.deleted_at is null
      and (p_session_id is null or o.session_id = p_session_id)
  ) x;

  return v_payload;
end;
$$;

revoke all on function public.pos_get_pending_qr_queue(uuid) from public;
grant execute on function public.pos_get_pending_qr_queue(uuid) to authenticated;

create or replace function public.pos_accept_qr_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_id uuid;
  v_bill_id uuid;
begin
  if not app.is_staff() then
    raise exception 'Unauthorized';
  end if;

  select o.session_id
    into v_session_id
  from public.orders o
  where o.id = p_order_id
    and o.status = 'pending'
    and o.source = 'qr'
    and o.deleted_at is null;

  if v_session_id is null then
    raise exception 'Pending QR order not found';
  end if;

  update public.orders
  set status = 'accepted',
      rejection_reason = null,
      updated_at = timezone('utc', now())
  where id = p_order_id;

  select public.pos_recompute_bill(v_session_id) into v_bill_id;

  insert into public.audit_logs(actor_user_id, action_type, entity_type, entity_id, details)
  values (
    auth.uid(),
    'qr_order_accepted',
    'orders',
    p_order_id,
    jsonb_build_object('session_id', v_session_id, 'bill_id', v_bill_id)
  );

  return jsonb_build_object('order_id', p_order_id, 'session_id', v_session_id, 'bill_id', v_bill_id);
end;
$$;

revoke all on function public.pos_accept_qr_order(uuid) from public;
grant execute on function public.pos_accept_qr_order(uuid) to authenticated;

create or replace function public.pos_reject_qr_order(
  p_order_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_id uuid;
  v_reason text;
begin
  if not app.is_staff() then
    raise exception 'Unauthorized';
  end if;

  v_reason := nullif(trim(p_reason), '');
  if v_reason is null then
    raise exception 'Rejection reason is required';
  end if;

  select o.session_id
    into v_session_id
  from public.orders o
  where o.id = p_order_id
    and o.status = 'pending'
    and o.source = 'qr'
    and o.deleted_at is null;

  if v_session_id is null then
    raise exception 'Pending QR order not found';
  end if;

  update public.orders
  set status = 'rejected',
      rejection_reason = v_reason,
      updated_at = timezone('utc', now())
  where id = p_order_id;

  insert into public.audit_logs(actor_user_id, action_type, entity_type, entity_id, details)
  values (
    auth.uid(),
    'qr_order_rejected',
    'orders',
    p_order_id,
    jsonb_build_object('session_id', v_session_id, 'reason', v_reason)
  );

  return jsonb_build_object('order_id', p_order_id, 'session_id', v_session_id, 'reason', v_reason);
end;
$$;

revoke all on function public.pos_reject_qr_order(uuid, text) from public;
grant execute on function public.pos_reject_qr_order(uuid, text) to authenticated;

create or replace function public.pos_print_order_to_kitchen(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_id uuid;
  v_order_status order_status;
begin
  if not app.is_staff() then
    raise exception 'Unauthorized';
  end if;

  select o.session_id, o.status
    into v_session_id, v_order_status
  from public.orders o
  where o.id = p_order_id
    and o.deleted_at is null;

  if v_session_id is null then
    raise exception 'Order not found';
  end if;

  if v_order_status <> 'accepted' then
    raise exception 'Only accepted orders can be printed';
  end if;

  update public.orders
  set status = 'printed',
      updated_at = timezone('utc', now())
  where id = p_order_id;

  insert into public.inventory_movements(ingredient_id, order_id, movement_type, qty_delta, note)
  select r.ingredient_id,
         p_order_id,
         'kitchen_print_deduction',
         (sum(r.qty_per_item * oi.qty) * -1)::numeric(14,3),
         'Deducted on kitchen print'
  from public.order_items oi
  join public.recipes r
    on r.menu_item_id = oi.menu_item_id
   and r.deleted_at is null
  where oi.order_id = p_order_id
    and oi.deleted_at is null
  group by r.ingredient_id;

  insert into public.audit_logs(actor_user_id, action_type, entity_type, entity_id, details)
  values (
    auth.uid(),
    'order_printed_to_kitchen',
    'orders',
    p_order_id,
    jsonb_build_object('session_id', v_session_id)
  );

  return jsonb_build_object('order_id', p_order_id, 'session_id', v_session_id, 'status', 'printed');
end;
$$;

revoke all on function public.pos_print_order_to_kitchen(uuid) from public;
grant execute on function public.pos_print_order_to_kitchen(uuid) to authenticated;

create or replace function public.pos_get_kitchen_ticket(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payload jsonb;
begin
  if not app.is_staff() then
    raise exception 'Unauthorized';
  end if;

  select jsonb_build_object(
    'order_id', o.id,
    'status', o.status,
    'created_at', o.created_at,
    'source', o.source,
    'table_number', s.table_number,
    'order_type', s.order_type,
    'items', (
      select coalesce(jsonb_agg(row_to_json(i)), '[]'::jsonb)
      from (
        select mi.name as item_name,
               oi.qty,
               oi.notes,
               oi.selected_modifiers
        from public.order_items oi
        join public.menu_items mi on mi.id = oi.menu_item_id
        where oi.order_id = o.id
          and oi.deleted_at is null
      ) i
    )
  ) into v_payload
  from public.orders o
  join public.sessions s on s.id = o.session_id
  where o.id = p_order_id
    and o.deleted_at is null
  limit 1;

  if v_payload is null then
    raise exception 'Order not found';
  end if;

  return v_payload;
end;
$$;

revoke all on function public.pos_get_kitchen_ticket(uuid) from public;
grant execute on function public.pos_get_kitchen_ticket(uuid) to authenticated;
