-- Billing engine + payment + receipt payload

create or replace function public.pos_set_bill_adjustments(
  p_session_id uuid,
  p_discount_amount numeric,
  p_delivery_fee numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bill_id uuid;
  v_subtotal numeric(12,2);
  v_discount numeric(12,2);
  v_delivery numeric(12,2);
  v_limit numeric(12,2);
  v_bill jsonb;
begin
  if not app.is_staff() then
    raise exception 'Unauthorized';
  end if;

  if not exists (
    select 1 from public.sessions s
    where s.id = p_session_id
      and s.deleted_at is null
  ) then
    raise exception 'Session not found';
  end if;

  select public.pos_recompute_bill(p_session_id) into v_bill_id;

  select b.subtotal
    into v_subtotal
  from public.bills b
  where b.id = v_bill_id
    and b.deleted_at is null;

  v_discount := greatest(coalesce(p_discount_amount, 0), 0);
  v_delivery := greatest(coalesce(p_delivery_fee, 0), 0);

  if not app.is_owner() then
    v_limit := round(coalesce(v_subtotal, 0) * 0.15, 2);
    if v_discount > v_limit then
      raise exception 'Cashier discount limit exceeded (max 15%% or equivalent amount)';
    end if;
  end if;

  update public.bills b
  set discount_amount = v_discount,
      delivery_fee = v_delivery,
      updated_at = timezone('utc', now())
  where b.id = v_bill_id;

  select jsonb_build_object(
    'bill_id', b.id,
    'subtotal', b.subtotal,
    'discount_amount', b.discount_amount,
    'new_subtotal', greatest(b.subtotal - b.discount_amount, 0),
    'tax_amount', b.tax_amount,
    'delivery_fee', b.delivery_fee,
    'total', b.total,
    'payment_status', b.payment_status
  ) into v_bill
  from public.bills b
  where b.id = v_bill_id;

  insert into public.audit_logs(actor_user_id, action_type, entity_type, entity_id, details)
  values (
    auth.uid(),
    'bill_adjusted',
    'bills',
    v_bill_id,
    jsonb_build_object('session_id', p_session_id, 'discount_amount', v_discount, 'delivery_fee', v_delivery)
  );

  return v_bill;
end;
$$;

revoke all on function public.pos_set_bill_adjustments(uuid, numeric, numeric) from public;
grant execute on function public.pos_set_bill_adjustments(uuid, numeric, numeric) to authenticated;

create or replace function public.pos_record_payment(
  p_session_id uuid,
  p_method payment_method,
  p_amount numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bill_id uuid;
  v_total numeric(12,2);
  v_paid numeric(12,2);
  v_due numeric(12,2);
  v_payment_id uuid;
  v_payload jsonb;
begin
  if not app.is_staff() then
    raise exception 'Unauthorized';
  end if;

  if coalesce(p_amount, 0) <= 0 then
    raise exception 'Payment amount must be > 0';
  end if;

  select public.pos_recompute_bill(p_session_id) into v_bill_id;

  select b.total
    into v_total
  from public.bills b
  where b.id = v_bill_id
    and b.deleted_at is null;

  select coalesce(sum(p.amount), 0)
    into v_paid
  from public.payments p
  where p.bill_id = v_bill_id
    and p.deleted_at is null;

  v_due := greatest(v_total - v_paid, 0);

  if round(p_amount::numeric, 2) <> round(v_due::numeric, 2) then
    raise exception 'Full payment required. Remaining due: %', v_due;
  end if;

  insert into public.payments(bill_id, method, amount)
  values (v_bill_id, p_method, p_amount)
  returning id into v_payment_id;

  update public.orders o
  set status = 'paid',
      updated_at = timezone('utc', now())
  where o.session_id = p_session_id
    and o.status in ('accepted', 'printed')
    and o.deleted_at is null;

  select jsonb_build_object(
    'payment_id', v_payment_id,
    'bill_id', b.id,
    'subtotal', b.subtotal,
    'discount_amount', b.discount_amount,
    'new_subtotal', greatest(b.subtotal - b.discount_amount, 0),
    'tax_amount', b.tax_amount,
    'delivery_fee', b.delivery_fee,
    'total', b.total,
    'payment_status', b.payment_status,
    'method', p_method,
    'paid_amount', p_amount
  ) into v_payload
  from public.bills b
  where b.id = v_bill_id;

  insert into public.audit_logs(actor_user_id, action_type, entity_type, entity_id, details)
  values (
    auth.uid(),
    'payment_recorded',
    'payments',
    v_payment_id,
    jsonb_build_object('session_id', p_session_id, 'bill_id', v_bill_id, 'method', p_method, 'amount', p_amount)
  );

  return v_payload;
end;
$$;

revoke all on function public.pos_record_payment(uuid, payment_method, numeric) from public;
grant execute on function public.pos_record_payment(uuid, payment_method, numeric) to authenticated;

create or replace function public.pos_get_receipt_payload(p_session_id uuid)
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
      select to_jsonb(sx)
      from (
        select s.id, s.table_number, s.order_type, s.created_at
        from public.sessions s
        where s.id = p_session_id
          and s.deleted_at is null
      ) sx
    ),
    'bill', (
      select jsonb_build_object(
        'id', b.id,
        'subtotal', b.subtotal,
        'discount_amount', b.discount_amount,
        'new_subtotal', greatest(b.subtotal - b.discount_amount, 0),
        'tax_amount', b.tax_amount,
        'delivery_fee', b.delivery_fee,
        'total', b.total,
        'payment_status', b.payment_status,
        'updated_at', b.updated_at
      )
      from public.bills b
      where b.session_id = p_session_id
        and b.deleted_at is null
      limit 1
    ),
    'payments', (
      select coalesce(jsonb_agg(row_to_json(p) order by p.created_at asc), '[]'::jsonb)
      from (
        select py.id, py.method, py.amount, py.created_at
        from public.payments py
        join public.bills b on b.id = py.bill_id
        where b.session_id = p_session_id
          and py.deleted_at is null
          and b.deleted_at is null
      ) p
    ),
    'items', (
      select coalesce(jsonb_agg(row_to_json(i) order by i.created_at asc), '[]'::jsonb)
      from (
        select oi.id, mi.name as menu_item_name, oi.qty, oi.notes, oi.selected_modifiers, oi.created_at
        from public.order_items oi
        join public.orders o on o.id = oi.order_id
        join public.menu_items mi on mi.id = oi.menu_item_id
        where o.session_id = p_session_id
          and o.status in ('accepted', 'printed', 'paid')
          and o.deleted_at is null
          and oi.deleted_at is null
      ) i
    )
  ) into v_payload;

  return v_payload;
end;
$$;

revoke all on function public.pos_get_receipt_payload(uuid) from public;
grant execute on function public.pos_get_receipt_payload(uuid) to authenticated;
