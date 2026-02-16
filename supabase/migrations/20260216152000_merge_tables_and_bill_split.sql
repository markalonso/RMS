-- Table merge + bill split engine

create table if not exists public.bill_splits (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete restrict,
  split_method text not null check (split_method in ('items', 'even')),
  portion_index integer not null,
  portions_count integer not null,
  subtotal numeric(12,2) not null default 0,
  discount_amount numeric(12,2) not null default 0,
  new_subtotal numeric(12,2) not null default 0,
  tax_amount numeric(12,2) not null default 0,
  delivery_fee numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

alter table public.bill_splits enable row level security;
create policy bill_splits_staff_all on public.bill_splits for all using (app.is_staff()) with check (app.is_staff());
create index if not exists idx_bill_splits_session_created on public.bill_splits(session_id, created_at desc) where deleted_at is null;
create trigger trg_no_delete_bill_splits before delete on public.bill_splits for each row execute function app.prevent_delete();

create or replace function public.pos_merge_tables(
  p_target_table_number integer,
  p_source_table_number integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_session uuid;
  v_source_session uuid;
  v_target_type order_type;
  v_source_type order_type;
begin
  if not app.is_staff() then
    raise exception 'Unauthorized';
  end if;

  if p_target_table_number = p_source_table_number then
    raise exception 'Target and source table must differ';
  end if;

  select s.id, s.order_type into v_target_session, v_target_type
  from public.sessions s
  where s.table_number = p_target_table_number
    and s.status = 'open'
    and s.deleted_at is null
  order by s.created_at desc
  limit 1;

  select s.id, s.order_type into v_source_session, v_source_type
  from public.sessions s
  where s.table_number = p_source_table_number
    and s.status = 'open'
    and s.deleted_at is null
  order by s.created_at desc
  limit 1;

  if v_target_session is null or v_source_session is null then
    raise exception 'Both tables must have open sessions';
  end if;

  if v_target_type <> 'dine_in' or v_source_type <> 'dine_in' then
    raise exception 'Table merge is dine-in only';
  end if;

  update public.orders
  set session_id = v_target_session,
      updated_at = timezone('utc', now())
  where session_id = v_source_session
    and deleted_at is null;

  update public.sessions
  set status = 'closed',
      updated_at = timezone('utc', now())
  where id = v_source_session;

  perform public.pos_recompute_bill(v_target_session);

  insert into public.audit_logs(actor_user_id, action_type, entity_type, entity_id, details)
  values (
    auth.uid(),
    'tables_merged',
    'sessions',
    v_target_session,
    jsonb_build_object(
      'target_table_number', p_target_table_number,
      'source_table_number', p_source_table_number,
      'target_session_id', v_target_session,
      'source_session_id', v_source_session
    )
  );

  return jsonb_build_object('target_session_id', v_target_session, 'source_session_id', v_source_session);
end;
$$;

revoke all on function public.pos_merge_tables(integer, integer) from public;
grant execute on function public.pos_merge_tables(integer, integer) to authenticated;

create or replace function public.pos_split_bill_by_items(
  p_session_id uuid,
  p_order_item_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_type order_type;
  v_subtotal numeric(12,2);
  v_discount numeric(12,2);
  v_discount_ratio numeric(12,8);
  v_discount_portion numeric(12,2);
  v_new_subtotal numeric(12,2);
  v_tax numeric(12,2);
  v_delivery numeric(12,2);
  v_total numeric(12,2);
  v_split_id uuid;
begin
  if not app.is_staff() then
    raise exception 'Unauthorized';
  end if;

  if p_order_item_ids is null or coalesce(array_length(p_order_item_ids, 1), 0) = 0 then
    raise exception 'At least one order item required';
  end if;

  select s.order_type into v_session_type
  from public.sessions s
  where s.id = p_session_id
    and s.deleted_at is null;

  if v_session_type is null then
    raise exception 'Session not found';
  end if;

  select public.pos_recompute_bill(p_session_id) into v_split_id;

  select b.subtotal, b.discount_amount, b.delivery_fee
    into v_subtotal, v_discount, v_delivery
  from public.bills b
  where b.session_id = p_session_id
    and b.deleted_at is null
  limit 1;

  select coalesce(sum((mi.price + coalesce(mods.mod_total, 0)) * oi.qty), 0)::numeric(12,2)
    into v_subtotal
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  join public.menu_items mi on mi.id = oi.menu_item_id
  left join lateral (
    select coalesce(sum(m.price_delta), 0)::numeric(12,2) as mod_total
    from jsonb_array_elements(coalesce(oi.selected_modifiers, '[]'::jsonb)) sm
    join public.modifiers m on m.id = (sm->>'id')::uuid and m.deleted_at is null
  ) mods on true
  where o.session_id = p_session_id
    and oi.id = any(p_order_item_ids)
    and oi.deleted_at is null
    and o.deleted_at is null;

  select b.discount_amount, b.delivery_fee
    into v_discount, v_delivery
  from public.bills b
  where b.session_id = p_session_id
    and b.deleted_at is null
  limit 1;

  if v_discount > 0 then
    select b.subtotal into v_new_subtotal from public.bills b where b.session_id = p_session_id and b.deleted_at is null limit 1;
    if coalesce(v_new_subtotal,0) > 0 then
      v_discount_ratio := v_discount / v_new_subtotal;
    else
      v_discount_ratio := 0;
    end if;
  else
    v_discount_ratio := 0;
  end if;

  v_discount_portion := round(v_subtotal * v_discount_ratio, 2);
  v_new_subtotal := greatest(v_subtotal - v_discount_portion, 0);
  if v_session_type = 'dine_in' then
    v_tax := round(v_new_subtotal * 0.14, 2);
  else
    v_tax := 0;
  end if;

  if v_session_type = 'delivery' then
    v_delivery := coalesce(v_delivery, 0);
  else
    v_delivery := 0;
  end if;

  v_total := v_new_subtotal + v_tax + v_delivery;

  insert into public.bill_splits(
    session_id, split_method, portion_index, portions_count,
    subtotal, discount_amount, new_subtotal, tax_amount, delivery_fee, total, metadata
  )
  values (
    p_session_id, 'items', 0, 1,
    v_subtotal, v_discount_portion, v_new_subtotal, v_tax, v_delivery, v_total,
    jsonb_build_object('order_item_ids', p_order_item_ids)
  )
  returning id into v_split_id;

  insert into public.audit_logs(actor_user_id, action_type, entity_type, entity_id, details)
  values (auth.uid(), 'bill_split_items', 'bill_splits', v_split_id, jsonb_build_object('session_id', p_session_id, 'order_item_ids', p_order_item_ids));

  return jsonb_build_object('split_id', v_split_id, 'total', v_total);
end;
$$;

revoke all on function public.pos_split_bill_by_items(uuid, uuid[]) from public;
grant execute on function public.pos_split_bill_by_items(uuid, uuid[]) to authenticated;

create or replace function public.pos_split_bill_evenly(
  p_session_id uuid,
  p_portions integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_type order_type;
  v_subtotal numeric(12,2);
  v_discount numeric(12,2);
  v_delivery numeric(12,2);
  i integer;
  v_piece_sub numeric(12,2);
  v_piece_disc numeric(12,2);
  v_piece_new_sub numeric(12,2);
  v_piece_tax numeric(12,2);
  v_piece_delivery numeric(12,2);
  v_piece_total numeric(12,2);
  v_ids uuid[] := '{}';
  v_split_id uuid;
begin
  if not app.is_staff() then
    raise exception 'Unauthorized';
  end if;
  if p_portions < 2 then
    raise exception 'Portions must be >= 2';
  end if;

  select s.order_type into v_session_type
  from public.sessions s
  where s.id = p_session_id
    and s.deleted_at is null;

  if v_session_type is null then
    raise exception 'Session not found';
  end if;

  select public.pos_recompute_bill(p_session_id) into v_split_id;

  select b.subtotal, b.discount_amount, b.delivery_fee
    into v_subtotal, v_discount, v_delivery
  from public.bills b
  where b.session_id = p_session_id
    and b.deleted_at is null
  limit 1;

  for i in 0..(p_portions-1) loop
    v_piece_sub := round(v_subtotal / p_portions, 2);
    v_piece_disc := round(v_discount / p_portions, 2);
    v_piece_new_sub := greatest(v_piece_sub - v_piece_disc, 0);
    if v_session_type = 'dine_in' then
      v_piece_tax := round(v_piece_new_sub * 0.14, 2);
    else
      v_piece_tax := 0;
    end if;

    if v_session_type = 'delivery' then
      v_piece_delivery := round(coalesce(v_delivery,0) / p_portions, 2);
    else
      v_piece_delivery := 0;
    end if;

    v_piece_total := v_piece_new_sub + v_piece_tax + v_piece_delivery;

    insert into public.bill_splits(
      session_id, split_method, portion_index, portions_count,
      subtotal, discount_amount, new_subtotal, tax_amount, delivery_fee, total, metadata
    ) values (
      p_session_id, 'even', i, p_portions,
      v_piece_sub, v_piece_disc, v_piece_new_sub, v_piece_tax, v_piece_delivery, v_piece_total,
      '{}'::jsonb
    ) returning id into v_split_id;

    v_ids := array_append(v_ids, v_split_id);
  end loop;

  insert into public.audit_logs(actor_user_id, action_type, entity_type, entity_id, details)
  values (auth.uid(), 'bill_split_even', 'sessions', p_session_id, jsonb_build_object('portions', p_portions, 'split_ids', v_ids));

  return jsonb_build_object('session_id', p_session_id, 'portions', p_portions, 'split_ids', v_ids);
end;
$$;

revoke all on function public.pos_split_bill_evenly(uuid, integer) from public;
grant execute on function public.pos_split_bill_evenly(uuid, integer) to authenticated;
