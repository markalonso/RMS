-- POS management helpers (cashier/owner)

-- Session metadata for delivery orders
alter table public.sessions
  add column if not exists customer_name text,
  add column if not exists customer_phone text,
  add column if not exists customer_address text;

-- one open session per table
create unique index if not exists ux_sessions_one_open_per_table
  on public.sessions(table_number)
  where table_number is not null
    and status = 'open'
    and deleted_at is null;

create or replace function public.pos_get_dashboard()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business_day jsonb;
  v_tables jsonb;
begin
  if not app.is_staff() then
    raise exception 'Unauthorized';
  end if;

  select to_jsonb(x)
    into v_business_day
  from (
    select bd.id, bd.status, bd.opened_at, bd.opening_cash
    from public.business_days bd
    where bd.status = 'open'
      and bd.deleted_at is null
    order by bd.opened_at desc
    limit 1
  ) x;

  select coalesce(jsonb_agg(row_to_json(t) order by t.table_number), '[]'::jsonb)
    into v_tables
  from (
    select rt.table_number,
           rt.name,
           rt.is_active,
           rt.qr_enabled,
           exists (
             select 1
             from public.sessions s
             where s.table_number = rt.table_number
               and s.status = 'open'
               and s.deleted_at is null
           ) as has_open_session,
           coalesce((
             select count(*)::int
             from public.orders o
             join public.sessions s2 on s2.id = o.session_id
             where s2.table_number = rt.table_number
               and s2.status = 'open'
               and s2.deleted_at is null
               and o.status = 'pending'
               and o.source = 'qr'
               and o.deleted_at is null
           ), 0) as pending_qr_count
    from public.restaurant_tables rt
    where rt.deleted_at is null
    order by rt.table_number
  ) t;

  return jsonb_build_object(
    'open_business_day', v_business_day,
    'tables', v_tables
  );
end;
$$;

revoke all on function public.pos_get_dashboard() from public;
grant execute on function public.pos_get_dashboard() to authenticated;

create or replace function public.pos_start_business_day(p_opening_cash numeric)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not app.is_staff() then
    raise exception 'Unauthorized';
  end if;

  if p_opening_cash < 0 then
    raise exception 'Opening cash must be >= 0';
  end if;

  if exists (
    select 1
    from public.business_days bd
    where bd.status = 'open'
      and bd.deleted_at is null
  ) then
    raise exception 'Business day is already open';
  end if;

  insert into public.business_days(status, opening_cash)
  values ('open', p_opening_cash)
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.pos_start_business_day(numeric) from public;
grant execute on function public.pos_start_business_day(numeric) to authenticated;

create or replace function public.pos_close_business_day(
  p_closing_cash numeric,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day_id uuid;
  v_report jsonb;
begin
  if not app.is_staff() then
    raise exception 'Unauthorized';
  end if;

  if p_closing_cash < 0 then
    raise exception 'Closing cash must be >= 0';
  end if;

  select bd.id into v_day_id
  from public.business_days bd
  where bd.status = 'open'
    and bd.deleted_at is null
  order by bd.opened_at desc
  limit 1;

  if v_day_id is null then
    raise exception 'No open business day';
  end if;

  update public.business_days
  set status = 'closed',
      closed_at = timezone('utc', now()),
      closing_cash = p_closing_cash,
      notes = p_notes,
      updated_at = timezone('utc', now())
  where id = v_day_id;

  select jsonb_build_object(
    'business_day_id', v_day_id,
    'orders_count', (
      select count(*)::int
      from public.orders o
      join public.sessions s on s.id = o.session_id
      where s.business_day_id = v_day_id
        and o.deleted_at is null
    ),
    'paid_orders_count', (
      select count(*)::int
      from public.orders o
      join public.sessions s on s.id = o.session_id
      where s.business_day_id = v_day_id
        and o.status = 'paid'
        and o.deleted_at is null
    ),
    'payments_total', (
      select coalesce(sum(p.amount), 0)
      from public.payments p
      join public.bills b on b.id = p.bill_id
      join public.sessions s on s.id = b.session_id
      where s.business_day_id = v_day_id
        and p.deleted_at is null
        and b.deleted_at is null
    ),
    'expenses_total', (
      select coalesce(sum(e.amount), 0)
      from public.expenses e
      where e.business_day_id = v_day_id
        and e.deleted_at is null
    ),
    'open_sessions_count', (
      select count(*)::int
      from public.sessions s
      where s.business_day_id = v_day_id
        and s.status = 'open'
        and s.deleted_at is null
    ),
    'closing_cash', p_closing_cash
  ) into v_report;

  return v_report;
end;
$$;

revoke all on function public.pos_close_business_day(numeric, text) from public;
grant execute on function public.pos_close_business_day(numeric, text) to authenticated;

create or replace function public.pos_open_session(
  p_order_type order_type,
  p_table_number integer default null,
  p_customer_name text default null,
  p_customer_phone text default null,
  p_customer_address text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day_id uuid;
  v_session_id uuid;
begin
  if not app.is_staff() then
    raise exception 'Unauthorized';
  end if;

  select bd.id into v_day_id
  from public.business_days bd
  where bd.status = 'open'
    and bd.deleted_at is null
  order by bd.opened_at desc
  limit 1;

  if v_day_id is null then
    raise exception 'No open business day';
  end if;

  if p_order_type = 'dine_in' then
    if p_table_number is null then
      raise exception 'Dine-in requires table_number';
    end if;

    if not exists (
      select 1 from public.restaurant_tables rt
      where rt.table_number = p_table_number
        and rt.is_active = true
        and rt.deleted_at is null
    ) then
      raise exception 'Table is not active';
    end if;

    if exists (
      select 1
      from public.sessions s
      where s.table_number = p_table_number
        and s.status = 'open'
        and s.deleted_at is null
    ) then
      raise exception 'Table already has an open session';
    end if;
  else
    p_table_number := null;
  end if;

  insert into public.sessions(
    table_number,
    order_type,
    status,
    business_day_id,
    customer_name,
    customer_phone,
    customer_address
  )
  values (
    p_table_number,
    p_order_type,
    'open',
    v_day_id,
    case when p_order_type = 'delivery' then p_customer_name else null end,
    case when p_order_type = 'delivery' then p_customer_phone else null end,
    case when p_order_type = 'delivery' then p_customer_address else null end
  )
  returning id into v_session_id;

  return v_session_id;
end;
$$;

revoke all on function public.pos_open_session(order_type, integer, text, text, text) from public;
grant execute on function public.pos_open_session(order_type, integer, text, text, text) to authenticated;

create or replace function public.pos_toggle_table_qr(p_table_number integer, p_qr_enabled boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not app.is_staff() then
    raise exception 'Unauthorized';
  end if;

  update public.restaurant_tables
  set qr_enabled = p_qr_enabled,
      updated_at = timezone('utc', now())
  where table_number = p_table_number
    and deleted_at is null;

  if not found then
    raise exception 'Table not found';
  end if;
end;
$$;

revoke all on function public.pos_toggle_table_qr(integer, boolean) from public;
grant execute on function public.pos_toggle_table_qr(integer, boolean) to authenticated;

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
                 select coalesce(jsonb_agg(row_to_json(oi)), '[]'::jsonb)
                 from (
                   select oi.id, oi.menu_item_id, mi.name as menu_item_name, oi.qty, oi.notes, oi.selected_modifiers
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

revoke all on function public.pos_get_session_details(uuid) from public;
grant execute on function public.pos_get_session_details(uuid) to authenticated;
