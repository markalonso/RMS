-- Manual cashier ordering + edit/void rules + print new items

alter table public.order_items
  add column if not exists kitchen_printed_at timestamptz;

create table if not exists public.manager_pin_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.void_logs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete restrict,
  order_id uuid not null references public.orders(id) on delete restrict,
  order_item_id uuid not null references public.order_items(id) on delete restrict,
  reason text not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  approved_via text not null,
  created_at timestamptz not null default timezone('utc', now())
);

alter table public.manager_pin_codes enable row level security;
alter table public.void_logs enable row level security;

create policy manager_pin_codes_staff_all on public.manager_pin_codes
for all using (app.is_staff()) with check (app.is_staff());

create policy void_logs_staff_all on public.void_logs
for all using (app.is_staff()) with check (app.is_staff());

create trigger trg_no_delete_manager_pin_codes before delete on public.manager_pin_codes
for each row execute function app.prevent_delete();

create trigger trg_no_delete_void_logs before delete on public.void_logs
for each row execute function app.prevent_delete();

create index if not exists idx_void_logs_session_created on public.void_logs(session_id, created_at desc);
create index if not exists idx_void_logs_item on public.void_logs(order_item_id);
create index if not exists idx_order_items_printed on public.order_items(order_id, kitchen_printed_at) where deleted_at is null;

create or replace function app.is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(app.current_role() = 'owner', false);
$$;

create or replace function app.is_valid_manager_pin(p_pin text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.manager_pin_codes m
    where m.is_active = true
      and crypt(p_pin, m.code_hash) = m.code_hash
  );
$$;

create or replace function public.pos_get_my_role()
returns app_role
language sql
stable
security definer
set search_path = public
as $$
  select app.current_role();
$$;

revoke all on function public.pos_get_my_role() from public;
grant execute on function public.pos_get_my_role() to authenticated;

create or replace function public.pos_add_manual_item(
  p_session_id uuid,
  p_menu_item_id uuid,
  p_qty integer,
  p_notes text default null,
  p_selected_modifiers jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
  v_item_id uuid;
begin
  if not app.is_staff() then
    raise exception 'Unauthorized';
  end if;

  if p_qty <= 0 then
    raise exception 'Quantity must be > 0';
  end if;

  if not exists (
    select 1
    from public.sessions s
    where s.id = p_session_id
      and s.status = 'open'
      and s.deleted_at is null
  ) then
    raise exception 'Open session not found';
  end if;

  insert into public.orders(session_id, source, status)
  values (p_session_id, 'manual', 'accepted')
  returning id into v_order_id;

  insert into public.order_items(order_id, menu_item_id, qty, notes, selected_modifiers)
  values (v_order_id, p_menu_item_id, p_qty, nullif(trim(p_notes), ''), coalesce(p_selected_modifiers, '[]'::jsonb))
  returning id into v_item_id;

  perform public.pos_recompute_bill(p_session_id);

  insert into public.audit_logs(actor_user_id, action_type, entity_type, entity_id, details)
  values (
    auth.uid(),
    'manual_item_added',
    'order_items',
    v_item_id,
    jsonb_build_object('session_id', p_session_id, 'order_id', v_order_id)
  );

  return jsonb_build_object('order_id', v_order_id, 'order_item_id', v_item_id);
end;
$$;

revoke all on function public.pos_add_manual_item(uuid, uuid, integer, text, jsonb) from public;
grant execute on function public.pos_add_manual_item(uuid, uuid, integer, text, jsonb) to authenticated;

create or replace function public.pos_update_manual_item(
  p_order_item_id uuid,
  p_qty integer,
  p_notes text default null,
  p_selected_modifiers jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_id uuid;
begin
  if not app.is_staff() then
    raise exception 'Unauthorized';
  end if;

  if p_qty <= 0 then
    raise exception 'Quantity must be > 0';
  end if;

  select o.session_id
    into v_session_id
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  where oi.id = p_order_item_id
    and oi.deleted_at is null
    and oi.kitchen_printed_at is null
    and o.source = 'manual'
    and o.status = 'accepted'
    and o.deleted_at is null;

  if v_session_id is null then
    raise exception 'Editable manual item not found';
  end if;

  update public.order_items
  set qty = p_qty,
      notes = nullif(trim(p_notes), ''),
      selected_modifiers = coalesce(p_selected_modifiers, '[]'::jsonb),
      updated_at = timezone('utc', now())
  where id = p_order_item_id;

  perform public.pos_recompute_bill(v_session_id);

  insert into public.audit_logs(actor_user_id, action_type, entity_type, entity_id, details)
  values (auth.uid(), 'manual_item_updated', 'order_items', p_order_item_id, jsonb_build_object('session_id', v_session_id));

  return jsonb_build_object('order_item_id', p_order_item_id, 'session_id', v_session_id);
end;
$$;

revoke all on function public.pos_update_manual_item(uuid, integer, text, jsonb) from public;
grant execute on function public.pos_update_manual_item(uuid, integer, text, jsonb) to authenticated;

create or replace function public.pos_remove_manual_item(p_order_item_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_id uuid;
begin
  if not app.is_staff() then
    raise exception 'Unauthorized';
  end if;

  select o.session_id
    into v_session_id
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  where oi.id = p_order_item_id
    and oi.deleted_at is null
    and oi.kitchen_printed_at is null
    and o.source = 'manual'
    and o.status = 'accepted'
    and o.deleted_at is null;

  if v_session_id is null then
    raise exception 'Removable manual item not found';
  end if;

  update public.order_items
  set deleted_at = timezone('utc', now()),
      updated_at = timezone('utc', now())
  where id = p_order_item_id;

  perform public.pos_recompute_bill(v_session_id);

  insert into public.audit_logs(actor_user_id, action_type, entity_type, entity_id, details)
  values (auth.uid(), 'manual_item_removed', 'order_items', p_order_item_id, jsonb_build_object('session_id', v_session_id));

  return jsonb_build_object('order_item_id', p_order_item_id, 'session_id', v_session_id);
end;
$$;

revoke all on function public.pos_remove_manual_item(uuid) from public;
grant execute on function public.pos_remove_manual_item(uuid) to authenticated;

create or replace function public.pos_print_new_items(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
  v_order_ids uuid[];
begin
  if not app.is_staff() then
    raise exception 'Unauthorized';
  end if;

  with target as (
    select oi.id, oi.order_id
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    where o.session_id = p_session_id
      and o.status = 'accepted'
      and o.deleted_at is null
      and oi.deleted_at is null
      and oi.kitchen_printed_at is null
  ),
  upd as (
    update public.order_items oi
    set kitchen_printed_at = timezone('utc', now()),
        updated_at = timezone('utc', now())
    from target t
    where oi.id = t.id
    returning t.order_id
  )
  select coalesce(count(*), 0), coalesce(array_agg(distinct order_id), '{}')
    into v_count, v_order_ids
  from upd;

  if coalesce(v_count, 0) = 0 then
    raise exception 'No new items to print';
  end if;

  update public.orders o
  set status = 'printed',
      updated_at = timezone('utc', now())
  where o.id = any(v_order_ids)
    and not exists (
      select 1
      from public.order_items oi
      where oi.order_id = o.id
        and oi.deleted_at is null
        and oi.kitchen_printed_at is null
    );

  insert into public.inventory_movements(ingredient_id, order_id, movement_type, qty_delta, note)
  select r.ingredient_id,
         oi.order_id,
         'kitchen_print_deduction',
         (sum(r.qty_per_item * oi.qty) * -1)::numeric(14,3),
         'Deducted on print new items'
  from public.order_items oi
  join public.recipes r
    on r.menu_item_id = oi.menu_item_id
   and r.deleted_at is null
  where oi.order_id = any(v_order_ids)
    and oi.deleted_at is null
    and oi.kitchen_printed_at is not null
  group by r.ingredient_id, oi.order_id;

  insert into public.audit_logs(actor_user_id, action_type, entity_type, entity_id, details)
  values (
    auth.uid(),
    'print_new_items',
    'sessions',
    p_session_id,
    jsonb_build_object('printed_order_ids', v_order_ids, 'items_count', v_count)
  );

  return jsonb_build_object('session_id', p_session_id, 'printed_order_ids', v_order_ids, 'printed_items_count', v_count);
end;
$$;

revoke all on function public.pos_print_new_items(uuid) from public;
grant execute on function public.pos_print_new_items(uuid) to authenticated;

create or replace function public.pos_void_order_item(
  p_order_item_id uuid,
  p_reason text,
  p_manager_pin text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_id uuid;
  v_order_id uuid;
  v_void_id uuid;
  v_reason text;
  v_approved_via text;
begin
  if not app.is_staff() then
    raise exception 'Unauthorized';
  end if;

  v_reason := nullif(trim(p_reason), '');
  if v_reason is null then
    raise exception 'Void reason is required';
  end if;

  if app.is_owner() then
    v_approved_via := 'owner_role';
  elsif p_manager_pin is not null and app.is_valid_manager_pin(p_manager_pin) then
    v_approved_via := 'manager_pin';
  else
    raise exception 'Owner role or valid manager PIN required for void';
  end if;

  select o.session_id, o.id
    into v_session_id, v_order_id
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  where oi.id = p_order_item_id
    and oi.deleted_at is null
    and oi.kitchen_printed_at is not null
    and o.deleted_at is null;

  if v_session_id is null then
    raise exception 'Printed item not found';
  end if;

  update public.order_items
  set deleted_at = timezone('utc', now()),
      updated_at = timezone('utc', now())
  where id = p_order_item_id;

  insert into public.void_logs(session_id, order_id, order_item_id, reason, actor_user_id, approved_via)
  values (v_session_id, v_order_id, p_order_item_id, v_reason, auth.uid(), v_approved_via)
  returning id into v_void_id;

  perform public.pos_recompute_bill(v_session_id);

  insert into public.audit_logs(actor_user_id, action_type, entity_type, entity_id, details)
  values (
    auth.uid(),
    'order_item_voided',
    'order_items',
    p_order_item_id,
    jsonb_build_object('session_id', v_session_id, 'void_log_id', v_void_id, 'reason', v_reason, 'approved_via', v_approved_via)
  );

  return jsonb_build_object('void_log_id', v_void_id, 'session_id', v_session_id, 'order_id', v_order_id);
end;
$$;

revoke all on function public.pos_void_order_item(uuid, text, text) from public;
grant execute on function public.pos_void_order_item(uuid, text, text) to authenticated;

create or replace function public.pos_get_void_ticket(p_void_log_id uuid)
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
    'void_log_id', v.id,
    'created_at', v.created_at,
    'reason', v.reason,
    'approved_via', v.approved_via,
    'order_id', v.order_id,
    'session_id', v.session_id,
    'table_number', s.table_number,
    'item', jsonb_build_object(
      'menu_item_name', mi.name,
      'qty', oi.qty,
      'notes', oi.notes,
      'selected_modifiers', oi.selected_modifiers
    )
  ) into v_payload
  from public.void_logs v
  join public.order_items oi on oi.id = v.order_item_id
  join public.orders o on o.id = v.order_id
  join public.sessions s on s.id = v.session_id
  join public.menu_items mi on mi.id = oi.menu_item_id
  where v.id = p_void_log_id
  limit 1;

  if v_payload is null then
    raise exception 'Void log not found';
  end if;

  return v_payload;
end;
$$;

revoke all on function public.pos_get_void_ticket(uuid) from public;
grant execute on function public.pos_get_void_ticket(uuid) to authenticated;

create or replace function public.pos_get_session_details(p_session_id uuid)
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
    'session', (
      select to_jsonb(s)
      from (
        select id, table_number, order_type, status, business_day_id, customer_name, customer_phone, customer_address, created_at
        from public.sessions
        where id = p_session_id
          and deleted_at is null
      ) s
    ),
    'orders', (
      select coalesce(jsonb_agg(row_to_json(o) order by o.created_at desc), '[]'::jsonb)
      from (
        select o.id, o.source, o.status, o.created_at,
               (
                 select coalesce(jsonb_agg(row_to_json(oi) order by oi.created_at asc), '[]'::jsonb)
                 from (
                   select oi.id,
                          oi.menu_item_id,
                          mi.name as menu_item_name,
                          oi.qty,
                          oi.notes,
                          oi.selected_modifiers,
                          oi.kitchen_printed_at,
                          (oi.kitchen_printed_at is null and o.source = 'manual' and o.status = 'accepted') as editable_before_print
                   from public.order_items oi
                   join public.menu_items mi on mi.id = oi.menu_item_id
                   where oi.order_id = o.id
                     and oi.deleted_at is null
                 ) oi
               ) as items
        from public.orders o
        where o.session_id = p_session_id
          and o.deleted_at is null
      ) o
    ),
    'bill', (
      select to_jsonb(b)
      from (
        select id, subtotal, discount_amount, tax_amount, delivery_fee, total, payment_status, updated_at
        from public.bills
        where session_id = p_session_id
          and deleted_at is null
        limit 1
      ) b
    )
  ) into v_payload;

  return v_payload;
end;
$$;
