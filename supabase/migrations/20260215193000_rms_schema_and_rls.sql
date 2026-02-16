-- RMS core schema + business logic + RLS
-- Designed for Supabase Postgres

create extension if not exists pgcrypto;

create schema if not exists app;

-- =========================
-- Enums
-- =========================
create type app_role as enum ('owner', 'cashier');
create type business_day_status as enum ('open', 'closed');
create type order_type as enum ('dine_in', 'takeaway', 'delivery');
create type session_status as enum ('open', 'closed');
create type order_source as enum ('qr', 'manual');
create type order_status as enum ('pending', 'accepted', 'rejected', 'printed', 'paid', 'canceled');
create type bill_payment_status as enum ('unpaid', 'partial', 'paid', 'void');
create type payment_method as enum ('cash', 'card');
create type expense_category as enum ('operational', 'admin', 'purchase');

-- =========================
-- Helpers
-- =========================
create or replace function app.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create or replace function app.prevent_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Hard delete is disabled for %. Use soft-delete or status transitions.', tg_table_name;
end;
$$;

create or replace function app.prevent_update_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Updates are not allowed on immutable table %.', tg_table_name;
end;
$$;

create or replace function app.current_role()
returns app_role
language sql
stable
security definer
set search_path = public
as $$
  select p.role
  from public.profiles p
  where p.id = auth.uid();
$$;

create or replace function app.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(app.current_role() in ('owner', 'cashier'), false);
$$;

-- =========================
-- Core entities
-- =========================
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  full_name text,
  role app_role not null,
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.restaurant_tables (
  id uuid primary key default gen_random_uuid(),
  table_number integer not null unique,
  name text not null,
  is_active boolean not null default true,
  qr_enabled boolean not null default true,
  deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.business_days (
  id uuid primary key default gen_random_uuid(),
  status business_day_status not null default 'open',
  opened_at timestamptz not null default timezone('utc', now()),
  closed_at timestamptz,
  opening_cash numeric(12,2) not null default 0 check (opening_cash >= 0),
  closing_cash numeric(12,2) check (closing_cash >= 0),
  notes text,
  deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint business_day_close_consistency check (
    (status = 'open' and closed_at is null)
    or
    (status = 'closed' and closed_at is not null)
  )
);

create unique index if not exists ux_business_days_one_open
  on public.business_days ((status))
  where status = 'open' and deleted_at is null;

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  table_number integer references public.restaurant_tables(table_number) on delete restrict,
  order_type order_type not null,
  status session_status not null default 'open',
  business_day_id uuid not null references public.business_days(id) on delete restrict,
  deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.menu_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.menu_items (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.menu_categories(id) on delete restrict,
  name text not null,
  description text,
  price numeric(12,2) not null check (price >= 0),
  is_active boolean not null default true,
  deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.item_availability (
  menu_item_id uuid primary key references public.menu_items(id) on delete restrict,
  is_available boolean not null default true,
  reason text,
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.modifier_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  is_active boolean not null default true,
  deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.modifiers (
  id uuid primary key default gen_random_uuid(),
  modifier_group_id uuid not null references public.modifier_groups(id) on delete restrict,
  name text not null,
  price_delta numeric(12,2) not null default 0,
  is_active boolean not null default true,
  deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.item_modifier_groups (
  id uuid primary key default gen_random_uuid(),
  menu_item_id uuid not null references public.menu_items(id) on delete restrict,
  modifier_group_id uuid not null references public.modifier_groups(id) on delete restrict,
  is_required boolean not null default false,
  min_select integer not null default 0,
  max_select integer not null default 1,
  deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint item_modifier_groups_minmax check (min_select >= 0 and max_select >= min_select)
);

create unique index if not exists ux_item_modifier_groups_item_group
  on public.item_modifier_groups(menu_item_id, modifier_group_id)
  where deleted_at is null;

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete restrict,
  source order_source not null,
  status order_status not null default 'pending',
  customer_note text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  deleted_at timestamptz,
  constraint qr_order_starts_pending check (
    (source = 'qr' and status in ('pending', 'accepted', 'rejected', 'printed', 'paid', 'canceled'))
    or
    (source = 'manual')
  )
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  menu_item_id uuid not null references public.menu_items(id) on delete restrict,
  qty integer not null check (qty > 0),
  notes text,
  selected_modifiers jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  deleted_at timestamptz
);

create table if not exists public.bills (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null unique references public.sessions(id) on delete restrict,
  subtotal numeric(12,2) not null default 0 check (subtotal >= 0),
  discount_amount numeric(12,2) not null default 0 check (discount_amount >= 0),
  tax_amount numeric(12,2) not null default 0 check (tax_amount >= 0),
  delivery_fee numeric(12,2) not null default 0 check (delivery_fee >= 0),
  total numeric(12,2) not null default 0 check (total >= 0),
  payment_status bill_payment_status not null default 'unpaid',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  deleted_at timestamptz
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references public.bills(id) on delete restrict,
  method payment_method not null,
  amount numeric(12,2) not null check (amount > 0),
  created_at timestamptz not null default timezone('utc', now()),
  deleted_at timestamptz
);

create table if not exists public.inventory_ingredients (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  unit text not null,
  on_hand_qty numeric(14,3) not null default 0 check (on_hand_qty >= 0),
  reserved_qty numeric(14,3) not null default 0 check (reserved_qty >= 0),
  reorder_level numeric(14,3) not null default 0 check (reorder_level >= 0),
  deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.recipes (
  id uuid primary key default gen_random_uuid(),
  menu_item_id uuid not null references public.menu_items(id) on delete restrict,
  ingredient_id uuid not null references public.inventory_ingredients(id) on delete restrict,
  qty_per_item numeric(14,3) not null check (qty_per_item > 0),
  deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists ux_recipes_item_ingredient
  on public.recipes(menu_item_id, ingredient_id)
  where deleted_at is null;

create table if not exists public.purchase_invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_number text,
  supplier_name text,
  invoice_date date not null default current_date,
  notes text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  deleted_at timestamptz
);

create table if not exists public.purchase_items (
  id uuid primary key default gen_random_uuid(),
  purchase_invoice_id uuid not null references public.purchase_invoices(id) on delete restrict,
  ingredient_id uuid not null references public.inventory_ingredients(id) on delete restrict,
  qty numeric(14,3) not null check (qty > 0),
  unit_cost numeric(12,2) not null default 0 check (unit_cost >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  deleted_at timestamptz
);

create table if not exists public.waste_logs (
  id uuid primary key default gen_random_uuid(),
  ingredient_id uuid not null references public.inventory_ingredients(id) on delete restrict,
  qty numeric(14,3) not null check (qty > 0),
  reason text not null,
  created_at timestamptz not null default timezone('utc', now()),
  deleted_at timestamptz
);

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  category expense_category not null,
  amount numeric(12,2) not null check (amount > 0),
  note text,
  occurred_at timestamptz not null default timezone('utc', now()),
  business_day_id uuid references public.business_days(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  deleted_at timestamptz
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references auth.users(id) on delete set null,
  action_type text not null,
  entity_type text not null,
  entity_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

-- =========================
-- Business logic functions/triggers
-- =========================
create or replace function app.enforce_order_status_transition()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.source = 'qr' and new.status <> 'pending' then
      raise exception 'QR orders must start as pending';
    end if;
    return new;
  end if;

  if old.status = new.status then
    return new;
  end if;

  if old.status = 'pending' and new.status in ('accepted', 'rejected', 'canceled') then
    return new;
  elsif old.status = 'accepted' and new.status in ('printed', 'canceled') then
    return new;
  elsif old.status = 'printed' and new.status in ('paid', 'canceled') then
    return new;
  else
    raise exception 'Invalid order status transition: % -> %', old.status, new.status;
  end if;
end;
$$;

create or replace function app.apply_bill_calculation()
returns trigger
language plpgsql
as $$
declare
  v_order_type order_type;
  v_discounted_subtotal numeric(12,2);
begin
  select s.order_type
    into v_order_type
  from public.sessions s
  where s.id = new.session_id;

  if v_order_type is null then
    raise exception 'Session not found for bill %', new.session_id;
  end if;

  v_discounted_subtotal := greatest(new.subtotal - new.discount_amount, 0);

  if v_order_type = 'dine_in' then
    new.tax_amount := round(v_discounted_subtotal * 0.14, 2);
    new.delivery_fee := 0;
  elsif v_order_type = 'delivery' then
    new.tax_amount := 0;
    if new.delivery_fee < 0 then
      raise exception 'Delivery fee cannot be negative';
    end if;
  else
    new.tax_amount := 0;
    new.delivery_fee := 0;
  end if;

  new.total := v_discounted_subtotal + new.tax_amount + new.delivery_fee;
  new.updated_at := timezone('utc', now());

  return new;
end;
$$;

create or replace function app.refresh_bill_payment_status(p_bill_id uuid)
returns void
language plpgsql
as $$
declare
  v_total numeric(12,2);
  v_paid numeric(12,2);
begin
  select b.total into v_total
  from public.bills b
  where b.id = p_bill_id;

  if v_total is null then
    return;
  end if;

  select coalesce(sum(p.amount), 0)
    into v_paid
  from public.payments p
  where p.bill_id = p_bill_id
    and p.deleted_at is null;

  update public.bills
  set payment_status = case
    when v_paid <= 0 then 'unpaid'::bill_payment_status
    when v_paid < v_total then 'partial'::bill_payment_status
    else 'paid'::bill_payment_status
  end,
  updated_at = timezone('utc', now())
  where id = p_bill_id;
end;
$$;

create or replace function app.payments_after_change()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    perform app.refresh_bill_payment_status(old.bill_id);
    return old;
  else
    perform app.refresh_bill_payment_status(new.bill_id);
    return new;
  end if;
end;
$$;

create or replace function app.inventory_add_from_purchase()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    update public.inventory_ingredients
    set on_hand_qty = on_hand_qty + new.qty,
        updated_at = timezone('utc', now())
    where id = new.ingredient_id;
    return new;
  elsif tg_op = 'UPDATE' then
    if old.ingredient_id <> new.ingredient_id then
      update public.inventory_ingredients
      set on_hand_qty = on_hand_qty - old.qty,
          updated_at = timezone('utc', now())
      where id = old.ingredient_id;

      update public.inventory_ingredients
      set on_hand_qty = on_hand_qty + new.qty,
          updated_at = timezone('utc', now())
      where id = new.ingredient_id;
    else
      update public.inventory_ingredients
      set on_hand_qty = on_hand_qty + (new.qty - old.qty),
          updated_at = timezone('utc', now())
      where id = new.ingredient_id;
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    update public.inventory_ingredients
    set on_hand_qty = on_hand_qty - old.qty,
        updated_at = timezone('utc', now())
    where id = old.ingredient_id;
    return old;
  end if;

  return null;
end;
$$;

create or replace function app.inventory_deduct_on_order_print()
returns trigger
language plpgsql
as $$
declare
  rec record;
begin
  if not (old.status = 'accepted' and new.status = 'printed') then
    return new;
  end if;

  for rec in
    select r.ingredient_id,
           sum(r.qty_per_item * oi.qty)::numeric(14,3) as required_qty
    from public.order_items oi
    join public.recipes r
      on r.menu_item_id = oi.menu_item_id
     and r.deleted_at is null
    where oi.order_id = new.id
      and oi.deleted_at is null
    group by r.ingredient_id
  loop
    update public.inventory_ingredients i
      set on_hand_qty = i.on_hand_qty - rec.required_qty,
          updated_at = timezone('utc', now())
    where i.id = rec.ingredient_id
      and i.deleted_at is null
      and i.on_hand_qty >= rec.required_qty;

    if not found then
      raise exception 'Insufficient inventory for ingredient % while printing order %', rec.ingredient_id, new.id;
    end if;
  end loop;

  return new;
end;
$$;

create or replace function app.inventory_deduct_waste()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    update public.inventory_ingredients
      set on_hand_qty = on_hand_qty - new.qty,
          updated_at = timezone('utc', now())
    where id = new.ingredient_id
      and on_hand_qty >= new.qty;

    if not found then
      raise exception 'Insufficient inventory for waste log';
    end if;
    return new;
  end if;

  return new;
end;
$$;

-- Customer RPC: submit order requests only
create or replace function app.submit_qr_order_request(
  p_table_number integer,
  p_items jsonb,
  p_customer_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_id uuid;
  v_order_id uuid;
  v_item jsonb;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'p_items must be a non-empty JSON array';
  end if;

  if not exists (
    select 1
    from public.restaurant_tables t
    where t.table_number = p_table_number
      and t.is_active = true
      and t.qr_enabled = true
      and t.deleted_at is null
  ) then
    raise exception 'Table is not available for QR ordering';
  end if;

  select s.id into v_session_id
  from public.sessions s
  join public.business_days bd on bd.id = s.business_day_id
  where s.table_number = p_table_number
    and s.status = 'open'
    and s.deleted_at is null
    and bd.status = 'open'
    and bd.deleted_at is null
  order by s.created_at desc
  limit 1;

  if v_session_id is null then
    raise exception 'No open session for this table';
  end if;

  insert into public.orders(session_id, source, status, customer_note)
  values (v_session_id, 'qr', 'pending', p_customer_note)
  returning id into v_order_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    insert into public.order_items(order_id, menu_item_id, qty, notes, selected_modifiers)
    values (
      v_order_id,
      (v_item->>'menu_item_id')::uuid,
      (v_item->>'qty')::integer,
      v_item->>'notes',
      coalesce(v_item->'selected_modifiers', '[]'::jsonb)
    );
  end loop;

  return v_order_id;
end;
$$;

revoke all on function app.submit_qr_order_request(integer, jsonb, text) from public;
grant execute on function app.submit_qr_order_request(integer, jsonb, text) to anon, authenticated;

-- =========================
-- Trigger bindings
-- =========================
create trigger trg_profiles_set_updated_at
before update on public.profiles
for each row execute function app.set_updated_at();

create trigger trg_restaurant_tables_set_updated_at
before update on public.restaurant_tables
for each row execute function app.set_updated_at();

create trigger trg_business_days_set_updated_at
before update on public.business_days
for each row execute function app.set_updated_at();

create trigger trg_sessions_set_updated_at
before update on public.sessions
for each row execute function app.set_updated_at();

create trigger trg_menu_categories_set_updated_at
before update on public.menu_categories
for each row execute function app.set_updated_at();

create trigger trg_menu_items_set_updated_at
before update on public.menu_items
for each row execute function app.set_updated_at();

create trigger trg_modifier_groups_set_updated_at
before update on public.modifier_groups
for each row execute function app.set_updated_at();

create trigger trg_modifiers_set_updated_at
before update on public.modifiers
for each row execute function app.set_updated_at();

create trigger trg_item_modifier_groups_set_updated_at
before update on public.item_modifier_groups
for each row execute function app.set_updated_at();

create trigger trg_orders_set_updated_at
before update on public.orders
for each row execute function app.set_updated_at();

create trigger trg_order_status_transition
before insert or update of status on public.orders
for each row execute function app.enforce_order_status_transition();

create trigger trg_order_items_set_updated_at
before update on public.order_items
for each row execute function app.set_updated_at();

create trigger trg_bills_calculation
before insert or update of subtotal, discount_amount, delivery_fee, session_id on public.bills
for each row execute function app.apply_bill_calculation();

create trigger trg_purchase_invoices_set_updated_at
before update on public.purchase_invoices
for each row execute function app.set_updated_at();

create trigger trg_purchase_items_set_updated_at
before update on public.purchase_items
for each row execute function app.set_updated_at();

create trigger trg_expenses_set_updated_at
before update on public.expenses
for each row execute function app.set_updated_at();

create trigger trg_inventory_set_updated_at
before update on public.inventory_ingredients
for each row execute function app.set_updated_at();

create trigger trg_recipes_set_updated_at
before update on public.recipes
for each row execute function app.set_updated_at();

create trigger trg_inventory_from_purchase
after insert or update or delete on public.purchase_items
for each row execute function app.inventory_add_from_purchase();

create trigger trg_inventory_from_print
after update of status on public.orders
for each row execute function app.inventory_deduct_on_order_print();

create trigger trg_inventory_from_waste
after insert on public.waste_logs
for each row execute function app.inventory_deduct_waste();

create trigger trg_payments_after_change
after insert or update or delete on public.payments
for each row execute function app.payments_after_change();

-- Block hard deletes on mutable tables
create trigger trg_no_delete_profiles before delete on public.profiles for each row execute function app.prevent_delete();
create trigger trg_no_delete_restaurant_tables before delete on public.restaurant_tables for each row execute function app.prevent_delete();
create trigger trg_no_delete_business_days before delete on public.business_days for each row execute function app.prevent_delete();
create trigger trg_no_delete_sessions before delete on public.sessions for each row execute function app.prevent_delete();
create trigger trg_no_delete_menu_categories before delete on public.menu_categories for each row execute function app.prevent_delete();
create trigger trg_no_delete_menu_items before delete on public.menu_items for each row execute function app.prevent_delete();
create trigger trg_no_delete_item_availability before delete on public.item_availability for each row execute function app.prevent_delete();
create trigger trg_no_delete_modifier_groups before delete on public.modifier_groups for each row execute function app.prevent_delete();
create trigger trg_no_delete_modifiers before delete on public.modifiers for each row execute function app.prevent_delete();
create trigger trg_no_delete_item_modifier_groups before delete on public.item_modifier_groups for each row execute function app.prevent_delete();
create trigger trg_no_delete_orders before delete on public.orders for each row execute function app.prevent_delete();
create trigger trg_no_delete_order_items before delete on public.order_items for each row execute function app.prevent_delete();
create trigger trg_no_delete_bills before delete on public.bills for each row execute function app.prevent_delete();
create trigger trg_no_delete_payments before delete on public.payments for each row execute function app.prevent_delete();
create trigger trg_no_delete_inventory before delete on public.inventory_ingredients for each row execute function app.prevent_delete();
create trigger trg_no_delete_recipes before delete on public.recipes for each row execute function app.prevent_delete();
create trigger trg_no_delete_purchase_invoices before delete on public.purchase_invoices for each row execute function app.prevent_delete();
create trigger trg_no_delete_purchase_items before delete on public.purchase_items for each row execute function app.prevent_delete();
create trigger trg_no_delete_waste_logs before delete on public.waste_logs for each row execute function app.prevent_delete();
create trigger trg_no_delete_expenses before delete on public.expenses for each row execute function app.prevent_delete();

-- Audit logs are append-only
create trigger trg_no_update_audit_logs before update on public.audit_logs for each row execute function app.prevent_update_immutable();
create trigger trg_no_delete_audit_logs before delete on public.audit_logs for each row execute function app.prevent_delete();

-- =========================
-- Indexes
-- =========================
create index if not exists idx_profiles_role on public.profiles(role) where is_active = true;
create index if not exists idx_restaurant_tables_active_qr on public.restaurant_tables(table_number) where is_active = true and qr_enabled = true and deleted_at is null;
create index if not exists idx_sessions_business_day_status on public.sessions(business_day_id, status, created_at desc) where deleted_at is null;
create index if not exists idx_sessions_table_open on public.sessions(table_number, created_at desc) where status = 'open' and deleted_at is null;
create index if not exists idx_menu_items_category_active on public.menu_items(category_id, is_active) where deleted_at is null;
create index if not exists idx_modifiers_group_active on public.modifiers(modifier_group_id, is_active) where deleted_at is null;
create index if not exists idx_orders_session_created on public.orders(session_id, created_at desc) where deleted_at is null;
create index if not exists idx_orders_status_source on public.orders(status, source, created_at desc) where deleted_at is null;
create index if not exists idx_order_items_order on public.order_items(order_id) where deleted_at is null;
create index if not exists idx_bills_session on public.bills(session_id) where deleted_at is null;
create index if not exists idx_payments_bill_created on public.payments(bill_id, created_at desc) where deleted_at is null;
create index if not exists idx_inventory_reorder on public.inventory_ingredients(reorder_level, on_hand_qty) where deleted_at is null;
create index if not exists idx_purchase_items_invoice on public.purchase_items(purchase_invoice_id) where deleted_at is null;
create index if not exists idx_waste_logs_ingredient_created on public.waste_logs(ingredient_id, created_at desc) where deleted_at is null;
create index if not exists idx_expenses_business_day_occurred on public.expenses(business_day_id, occurred_at desc) where deleted_at is null;
create index if not exists idx_audit_logs_entity_created on public.audit_logs(entity_type, entity_id, created_at desc);

-- =========================
-- RLS
-- =========================
alter table public.profiles enable row level security;
alter table public.restaurant_tables enable row level security;
alter table public.business_days enable row level security;
alter table public.sessions enable row level security;
alter table public.menu_categories enable row level security;
alter table public.menu_items enable row level security;
alter table public.item_availability enable row level security;
alter table public.modifier_groups enable row level security;
alter table public.modifiers enable row level security;
alter table public.item_modifier_groups enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.bills enable row level security;
alter table public.payments enable row level security;
alter table public.inventory_ingredients enable row level security;
alter table public.recipes enable row level security;
alter table public.purchase_invoices enable row level security;
alter table public.purchase_items enable row level security;
alter table public.waste_logs enable row level security;
alter table public.expenses enable row level security;
alter table public.audit_logs enable row level security;

-- profiles: user can see/update own profile; staff can manage all
create policy profiles_select_self on public.profiles
for select
using (id = auth.uid() or app.is_staff());

create policy profiles_update_self on public.profiles
for update
using (id = auth.uid() or app.is_staff())
with check (id = auth.uid() or app.is_staff());

create policy profiles_insert_staff on public.profiles
for insert
with check (app.is_staff());

-- Staff all-access policy template for internal tables
create policy restaurant_tables_staff_all on public.restaurant_tables for all using (app.is_staff()) with check (app.is_staff());
create policy business_days_staff_all on public.business_days for all using (app.is_staff()) with check (app.is_staff());
create policy sessions_staff_all on public.sessions for all using (app.is_staff()) with check (app.is_staff());
create policy menu_categories_staff_all on public.menu_categories for all using (app.is_staff()) with check (app.is_staff());
create policy menu_items_staff_all on public.menu_items for all using (app.is_staff()) with check (app.is_staff());
create policy item_availability_staff_all on public.item_availability for all using (app.is_staff()) with check (app.is_staff());
create policy modifier_groups_staff_all on public.modifier_groups for all using (app.is_staff()) with check (app.is_staff());
create policy modifiers_staff_all on public.modifiers for all using (app.is_staff()) with check (app.is_staff());
create policy item_modifier_groups_staff_all on public.item_modifier_groups for all using (app.is_staff()) with check (app.is_staff());
create policy orders_staff_all on public.orders for all using (app.is_staff()) with check (app.is_staff());
create policy order_items_staff_all on public.order_items for all using (app.is_staff()) with check (app.is_staff());
create policy bills_staff_all on public.bills for all using (app.is_staff()) with check (app.is_staff());
create policy payments_staff_all on public.payments for all using (app.is_staff()) with check (app.is_staff());
create policy inventory_staff_all on public.inventory_ingredients for all using (app.is_staff()) with check (app.is_staff());
create policy recipes_staff_all on public.recipes for all using (app.is_staff()) with check (app.is_staff());
create policy purchase_invoices_staff_all on public.purchase_invoices for all using (app.is_staff()) with check (app.is_staff());
create policy purchase_items_staff_all on public.purchase_items for all using (app.is_staff()) with check (app.is_staff());
create policy waste_logs_staff_all on public.waste_logs for all using (app.is_staff()) with check (app.is_staff());
create policy expenses_staff_all on public.expenses for all using (app.is_staff()) with check (app.is_staff());
create policy audit_logs_staff_all on public.audit_logs for all using (app.is_staff()) with check (app.is_staff());

-- Optional read-only customer-facing catalog access for QR UI
create policy restaurant_tables_anon_qr_lookup on public.restaurant_tables
for select
using (is_active = true and qr_enabled = true and deleted_at is null);

create policy menu_categories_public_read on public.menu_categories
for select
using (is_active = true and deleted_at is null);

create policy menu_items_public_read on public.menu_items
for select
using (is_active = true and deleted_at is null);

create policy item_availability_public_read on public.item_availability
for select
using (is_available = true);

create policy modifier_groups_public_read on public.modifier_groups
for select
using (is_active = true and deleted_at is null);

create policy modifiers_public_read on public.modifiers
for select
using (is_active = true and deleted_at is null);

create policy item_modifier_groups_public_read on public.item_modifier_groups
for select
using (deleted_at is null);
