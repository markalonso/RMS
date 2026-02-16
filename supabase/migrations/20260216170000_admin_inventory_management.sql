-- Admin inventory management + reservation strategy

create or replace function app.adjust_reservation_for_order(
  p_order_id uuid,
  p_direction integer
)
returns void
language plpgsql
as $$
declare
  rec record;
begin
  if p_direction not in (-1, 1) then
    raise exception 'p_direction must be -1 or 1';
  end if;

  for rec in
    select r.ingredient_id,
           sum(r.qty_per_item * oi.qty)::numeric(14,3) as qty
    from public.order_items oi
    join public.recipes r
      on r.menu_item_id = oi.menu_item_id
     and r.deleted_at is null
    where oi.order_id = p_order_id
      and oi.deleted_at is null
    group by r.ingredient_id
  loop
    update public.inventory_ingredients i
    set reserved_qty = greatest(i.reserved_qty + (rec.qty * p_direction), 0),
        updated_at = timezone('utc', now())
    where i.id = rec.ingredient_id
      and i.deleted_at is null;

    insert into public.inventory_movements(ingredient_id, order_id, movement_type, qty_delta, note)
    values (
      rec.ingredient_id,
      p_order_id,
      case when p_direction = 1 then 'reserve_on_accept' else 'release_reserve' end,
      rec.qty * p_direction,
      case when p_direction = 1 then 'Reserved inventory on order accept' else 'Released reserved inventory' end
    );
  end loop;
end;
$$;

create or replace function app.sync_inventory_reservation_on_order_status()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'accepted' then
      perform app.adjust_reservation_for_order(new.id, 1);
    end if;
    return new;
  end if;

  if old.status <> 'accepted' and new.status = 'accepted' then
    perform app.adjust_reservation_for_order(new.id, 1);
  elsif old.status = 'accepted' and new.status in ('rejected', 'canceled') then
    perform app.adjust_reservation_for_order(new.id, -1);
  end if;

  return new;
end;
$$;

create or replace function app.inventory_deduct_on_order_print()
returns trigger
language plpgsql
as $$
declare
  rec record;
  v_before_on_hand numeric(14,3);
  v_deducted numeric(14,3);
  v_shortage numeric(14,3);
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
    select i.on_hand_qty into v_before_on_hand
    from public.inventory_ingredients i
    where i.id = rec.ingredient_id
      and i.deleted_at is null
    limit 1;

    if v_before_on_hand is null then
      continue;
    end if;

    v_deducted := least(v_before_on_hand, rec.required_qty);
    v_shortage := greatest(rec.required_qty - v_before_on_hand, 0);

    update public.inventory_ingredients i
    set on_hand_qty = greatest(i.on_hand_qty - rec.required_qty, 0),
        reserved_qty = greatest(i.reserved_qty - rec.required_qty, 0),
        updated_at = timezone('utc', now())
    where i.id = rec.ingredient_id
      and i.deleted_at is null;

    insert into public.inventory_movements(ingredient_id, order_id, movement_type, qty_delta, note)
    values (
      rec.ingredient_id,
      new.id,
      'kitchen_print_deduction',
      v_deducted * -1,
      'Deducted on kitchen print'
    );

    if v_shortage > 0 then
      insert into public.inventory_movements(ingredient_id, order_id, movement_type, qty_delta, note)
      values (
        rec.ingredient_id,
        new.id,
        'low_stock_shortage',
        0,
        format('Low stock on print. Missing qty: %s', v_shortage)
      );

      insert into public.audit_logs(actor_user_id, action_type, entity_type, entity_id, details)
      values (
        auth.uid(),
        'low_stock_on_print',
        'orders',
        new.id,
        jsonb_build_object('ingredient_id', rec.ingredient_id, 'required_qty', rec.required_qty, 'shortage_qty', v_shortage)
      );
    end if;
  end loop;

  return new;
end;
$$;

-- reserve on accept, release on cancel/reject; deduct on print remains separate
create trigger trg_inventory_reservation_on_order_status
after insert or update of status on public.orders
for each row execute function app.sync_inventory_reservation_on_order_status();

create or replace function public.admin_upsert_ingredient(
  p_id uuid default null,
  p_name text default null,
  p_unit text default null,
  p_on_hand_qty numeric default 0,
  p_reserved_qty numeric default 0,
  p_reorder_level numeric default 0
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_name text;
  v_unit text;
begin
  if not app.is_staff() then
    raise exception 'Unauthorized';
  end if;

  v_name := trim(coalesce(p_name, ''));
  v_unit := trim(coalesce(p_unit, ''));

  if v_name = '' or v_unit = '' then
    raise exception 'Name and unit are required';
  end if;

  if v_name !~ '^[A-Za-z0-9 .,&()/%+\-]+$' then
    raise exception 'Ingredient name must be English-only';
  end if;

  if v_unit !~ '^[A-Za-z0-9 .,&()/%+\-]+$' then
    raise exception 'Unit must be English-only';
  end if;

  if p_id is null then
    insert into public.inventory_ingredients(name, unit, on_hand_qty, reserved_qty, reorder_level)
    values (v_name, v_unit, greatest(p_on_hand_qty, 0), greatest(p_reserved_qty, 0), greatest(p_reorder_level, 0))
    returning id into v_id;

    insert into public.audit_logs(actor_user_id, action_type, entity_type, entity_id, details)
    values (auth.uid(), 'ingredient_created', 'inventory_ingredients', v_id, jsonb_build_object('name', v_name));
  else
    update public.inventory_ingredients
    set name = v_name,
        unit = v_unit,
        on_hand_qty = greatest(p_on_hand_qty, 0),
        reserved_qty = greatest(p_reserved_qty, 0),
        reorder_level = greatest(p_reorder_level, 0),
        updated_at = timezone('utc', now())
    where id = p_id
      and deleted_at is null
    returning id into v_id;

    if v_id is null then
      raise exception 'Ingredient not found';
    end if;

    insert into public.audit_logs(actor_user_id, action_type, entity_type, entity_id, details)
    values (auth.uid(), 'ingredient_updated', 'inventory_ingredients', v_id, jsonb_build_object('name', v_name));
  end if;

  return v_id;
end;
$$;

revoke all on function public.admin_upsert_ingredient(uuid, text, text, numeric, numeric, numeric) from public;
grant execute on function public.admin_upsert_ingredient(uuid, text, text, numeric, numeric, numeric) to authenticated;

create or replace function public.admin_delete_ingredient(
  p_id uuid,
  p_reason text default 'manual_delete'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not app.is_staff() then
    raise exception 'Unauthorized';
  end if;

  update public.inventory_ingredients
  set deleted_at = timezone('utc', now()),
      updated_at = timezone('utc', now())
  where id = p_id
    and deleted_at is null;

  if not found then
    raise exception 'Ingredient not found';
  end if;

  insert into public.audit_logs(actor_user_id, action_type, entity_type, entity_id, details)
  values (auth.uid(), 'ingredient_deleted', 'inventory_ingredients', p_id, jsonb_build_object('reason', p_reason));
end;
$$;

revoke all on function public.admin_delete_ingredient(uuid, text) from public;
grant execute on function public.admin_delete_ingredient(uuid, text) to authenticated;

create or replace function public.admin_upsert_recipe(
  p_menu_item_id uuid,
  p_ingredient_id uuid,
  p_qty_per_item numeric
)
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

  if p_qty_per_item <= 0 then
    raise exception 'qty_per_item must be > 0';
  end if;

  insert into public.recipes(menu_item_id, ingredient_id, qty_per_item, deleted_at)
  values (p_menu_item_id, p_ingredient_id, p_qty_per_item, null)
  on conflict (menu_item_id, ingredient_id)
  where deleted_at is null
  do update
    set qty_per_item = excluded.qty_per_item,
        updated_at = timezone('utc', now()),
        deleted_at = null
  returning id into v_id;

  insert into public.audit_logs(actor_user_id, action_type, entity_type, entity_id, details)
  values (
    auth.uid(),
    'recipe_upserted',
    'recipes',
    v_id,
    jsonb_build_object('menu_item_id', p_menu_item_id, 'ingredient_id', p_ingredient_id, 'qty_per_item', p_qty_per_item)
  );

  return v_id;
end;
$$;

revoke all on function public.admin_upsert_recipe(uuid, uuid, numeric) from public;
grant execute on function public.admin_upsert_recipe(uuid, uuid, numeric) to authenticated;

create or replace function public.admin_delete_recipe(
  p_menu_item_id uuid,
  p_ingredient_id uuid,
  p_reason text default 'manual_delete'
)
returns void
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

  update public.recipes
  set deleted_at = timezone('utc', now()),
      updated_at = timezone('utc', now())
  where menu_item_id = p_menu_item_id
    and ingredient_id = p_ingredient_id
    and deleted_at is null
  returning id into v_id;

  if v_id is null then
    raise exception 'Recipe link not found';
  end if;

  insert into public.audit_logs(actor_user_id, action_type, entity_type, entity_id, details)
  values (auth.uid(), 'recipe_deleted', 'recipes', v_id, jsonb_build_object('reason', p_reason));
end;
$$;

revoke all on function public.admin_delete_recipe(uuid, uuid, text) from public;
grant execute on function public.admin_delete_recipe(uuid, uuid, text) to authenticated;
