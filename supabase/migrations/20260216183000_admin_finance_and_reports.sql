-- Admin finance module: purchases, expenses, and business-day reporting

alter table public.expenses
  add column if not exists linked_purchase_invoice_id uuid references public.purchase_invoices(id) on delete set null,
  add column if not exists exclude_from_profit boolean not null default false;

create index if not exists idx_expenses_linked_purchase on public.expenses(linked_purchase_invoice_id) where deleted_at is null;

create or replace function public.admin_create_purchase_invoice(
  p_supplier_name text,
  p_invoice_number text,
  p_invoice_date date,
  p_notes text,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice_id uuid;
  v_item jsonb;
  v_ingredient_id uuid;
  v_qty numeric(14,3);
  v_unit_cost numeric(12,2);
begin
  if not app.is_staff() then
    raise exception 'Unauthorized';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'p_items must be a non-empty array';
  end if;

  insert into public.purchase_invoices(invoice_number, supplier_name, invoice_date, notes)
  values (nullif(trim(p_invoice_number), ''), nullif(trim(p_supplier_name), ''), coalesce(p_invoice_date, current_date), nullif(trim(p_notes), ''))
  returning id into v_invoice_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_ingredient_id := (v_item->>'ingredient_id')::uuid;
    v_qty := greatest(coalesce((v_item->>'qty')::numeric, 0), 0);
    v_unit_cost := greatest(coalesce((v_item->>'unit_cost')::numeric, 0), 0);

    if v_ingredient_id is null or v_qty <= 0 then
      raise exception 'Invalid purchase item payload';
    end if;

    insert into public.purchase_items(purchase_invoice_id, ingredient_id, qty, unit_cost)
    values (v_invoice_id, v_ingredient_id, v_qty, v_unit_cost);
  end loop;

  insert into public.audit_logs(actor_user_id, action_type, entity_type, entity_id, details)
  values (
    auth.uid(),
    'purchase_invoice_created',
    'purchase_invoices',
    v_invoice_id,
    jsonb_build_object('supplier_name', p_supplier_name, 'invoice_date', p_invoice_date)
  );

  return v_invoice_id;
end;
$$;

revoke all on function public.admin_create_purchase_invoice(text, text, date, text, jsonb) from public;
grant execute on function public.admin_create_purchase_invoice(text, text, date, text, jsonb) to authenticated;

create or replace function public.admin_create_expense(
  p_category expense_category,
  p_amount numeric,
  p_note text,
  p_occurred_at timestamptz,
  p_business_day_id uuid default null,
  p_linked_purchase_invoice_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_note text;
  v_bd_id uuid;
  v_exclude boolean := false;
begin
  if not app.is_staff() then
    raise exception 'Unauthorized';
  end if;

  if coalesce(p_amount, 0) <= 0 then
    raise exception 'Amount must be > 0';
  end if;

  v_note := nullif(trim(coalesce(p_note, '')), '');

  if p_category = 'operational' and v_note is not null and lower(v_note) ~ '(water|electricity)' then
    raise exception 'Operational category cannot include water/electricity';
  end if;

  if p_business_day_id is null then
    select bd.id into v_bd_id
    from public.business_days bd
    where bd.status = 'open'
      and bd.deleted_at is null
    order by bd.opened_at desc
    limit 1;
  else
    v_bd_id := p_business_day_id;
  end if;

  if p_category = 'purchase' and p_linked_purchase_invoice_id is not null then
    v_exclude := true;
  end if;

  insert into public.expenses(category, amount, note, occurred_at, business_day_id, linked_purchase_invoice_id, exclude_from_profit)
  values (p_category, p_amount, v_note, coalesce(p_occurred_at, timezone('utc', now())), v_bd_id, p_linked_purchase_invoice_id, v_exclude)
  returning id into v_id;

  insert into public.audit_logs(actor_user_id, action_type, entity_type, entity_id, details)
  values (
    auth.uid(),
    'expense_created',
    'expenses',
    v_id,
    jsonb_build_object('category', p_category, 'amount', p_amount, 'exclude_from_profit', v_exclude)
  );

  return v_id;
end;
$$;

revoke all on function public.admin_create_expense(expense_category, numeric, text, timestamptz, uuid, uuid) from public;
grant execute on function public.admin_create_expense(expense_category, numeric, text, timestamptz, uuid, uuid) to authenticated;

create or replace function public.admin_get_business_day_report(p_business_day_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day_id uuid;
  v_sales_dine_in numeric(12,2);
  v_sales_takeaway numeric(12,2);
  v_sales_delivery numeric(12,2);
  v_tax_collected numeric(12,2);
  v_delivery_fees numeric(12,2);
  v_expenses numeric(12,2);
  v_cogs numeric(12,2);
  v_revenue numeric(12,2);
  v_net numeric(12,2);
begin
  if not app.is_staff() then
    raise exception 'Unauthorized';
  end if;

  if p_business_day_id is null then
    select bd.id into v_day_id
    from public.business_days bd
    where bd.deleted_at is null
    order by bd.opened_at desc
    limit 1;
  else
    v_day_id := p_business_day_id;
  end if;

  if v_day_id is null then
    raise exception 'Business day not found';
  end if;

  select coalesce(sum(b.total), 0) into v_sales_dine_in
  from public.bills b
  join public.sessions s on s.id = b.session_id
  where s.business_day_id = v_day_id
    and s.order_type = 'dine_in'
    and b.payment_status = 'paid'
    and b.deleted_at is null
    and s.deleted_at is null;

  select coalesce(sum(b.total), 0) into v_sales_takeaway
  from public.bills b
  join public.sessions s on s.id = b.session_id
  where s.business_day_id = v_day_id
    and s.order_type = 'takeaway'
    and b.payment_status = 'paid'
    and b.deleted_at is null
    and s.deleted_at is null;

  select coalesce(sum(b.total), 0) into v_sales_delivery
  from public.bills b
  join public.sessions s on s.id = b.session_id
  where s.business_day_id = v_day_id
    and s.order_type = 'delivery'
    and b.payment_status = 'paid'
    and b.deleted_at is null
    and s.deleted_at is null;

  select coalesce(sum(b.tax_amount), 0) into v_tax_collected
  from public.bills b
  join public.sessions s on s.id = b.session_id
  where s.business_day_id = v_day_id
    and b.payment_status = 'paid'
    and b.deleted_at is null
    and s.deleted_at is null;

  select coalesce(sum(b.delivery_fee), 0) into v_delivery_fees
  from public.bills b
  join public.sessions s on s.id = b.session_id
  where s.business_day_id = v_day_id
    and b.payment_status = 'paid'
    and b.deleted_at is null
    and s.deleted_at is null;

  -- COGS estimate from printed/paid orders using weighted average ingredient costs from purchases.
  select coalesce(sum(consumed.qty_required * coalesce(cost.avg_unit_cost, 0)), 0)::numeric(12,2)
    into v_cogs
  from (
    select r.ingredient_id,
           sum(r.qty_per_item * oi.qty)::numeric(14,3) as qty_required
    from public.orders o
    join public.sessions s on s.id = o.session_id
    join public.order_items oi on oi.order_id = o.id and oi.deleted_at is null
    join public.recipes r on r.menu_item_id = oi.menu_item_id and r.deleted_at is null
    where s.business_day_id = v_day_id
      and o.status in ('printed', 'paid')
      and o.deleted_at is null
      and s.deleted_at is null
    group by r.ingredient_id
  ) consumed
  left join (
    select pi.ingredient_id,
           case when sum(pi.qty) > 0 then (sum(pi.qty * pi.unit_cost) / sum(pi.qty)) else 0 end::numeric(12,4) as avg_unit_cost
    from public.purchase_items pi
    where pi.deleted_at is null
    group by pi.ingredient_id
  ) cost on cost.ingredient_id = consumed.ingredient_id;

  select coalesce(sum(e.amount), 0)::numeric(12,2)
    into v_expenses
  from public.expenses e
  where e.business_day_id = v_day_id
    and e.deleted_at is null
    and e.exclude_from_profit = false;

  v_revenue := coalesce(v_sales_dine_in, 0) + coalesce(v_sales_takeaway, 0) + coalesce(v_sales_delivery, 0);
  v_net := v_revenue - coalesce(v_cogs, 0) - coalesce(v_expenses, 0);

  return jsonb_build_object(
    'business_day_id', v_day_id,
    'sales', jsonb_build_object(
      'dine_in', coalesce(v_sales_dine_in, 0),
      'takeaway', coalesce(v_sales_takeaway, 0),
      'delivery', coalesce(v_sales_delivery, 0),
      'total', v_revenue
    ),
    'tax_collected', coalesce(v_tax_collected, 0),
    'delivery_fees', coalesce(v_delivery_fees, 0),
    'ingredient_cogs_estimate', coalesce(v_cogs, 0),
    'expenses', coalesce(v_expenses, 0),
    'net_profit_estimate', coalesce(v_net, 0)
  );
end;
$$;

revoke all on function public.admin_get_business_day_report(uuid) from public;
grant execute on function public.admin_get_business_day_report(uuid) to authenticated;
