-- Public wrappers for PostgREST RPC access (anon QR flow)

create or replace function public.submit_qr_order_request(
  p_table_number integer,
  p_items jsonb,
  p_customer_note text default null
)
returns uuid
language sql
security definer
set search_path = public
as $$
  select app.submit_qr_order_request(p_table_number, p_items, p_customer_note);
$$;

revoke all on function public.submit_qr_order_request(integer, jsonb, text) from public;
grant execute on function public.submit_qr_order_request(integer, jsonb, text) to anon, authenticated;

create or replace function public.get_table_ordering_status(p_table_number integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_table record;
  v_has_open_session boolean;
begin
  select t.table_number, t.is_active, t.qr_enabled
    into v_table
  from public.restaurant_tables t
  where t.table_number = p_table_number
    and t.deleted_at is null
  limit 1;

  if v_table is null then
    return jsonb_build_object(
      'table_exists', false,
      'is_active', false,
      'qr_enabled', false,
      'has_open_session', false
    );
  end if;

  select exists (
    select 1
    from public.sessions s
    join public.business_days bd on bd.id = s.business_day_id
    where s.table_number = p_table_number
      and s.status = 'open'
      and s.deleted_at is null
      and bd.status = 'open'
      and bd.deleted_at is null
  ) into v_has_open_session;

  return jsonb_build_object(
    'table_exists', true,
    'is_active', v_table.is_active,
    'qr_enabled', v_table.qr_enabled,
    'has_open_session', v_has_open_session
  );
end;
$$;

revoke all on function public.get_table_ordering_status(integer) from public;
grant execute on function public.get_table_ordering_status(integer) to anon, authenticated;
