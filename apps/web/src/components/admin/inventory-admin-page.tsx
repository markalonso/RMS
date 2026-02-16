'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';

import { supabase } from '@/lib/supabase';

type Ingredient = {
  id: string;
  name: string;
  unit: string;
  on_hand_qty: number;
  reserved_qty: number;
  reorder_level: number;
};

type MenuItem = { id: string; name: string };
type Recipe = { id: string; menu_item_id: string; ingredient_id: string; qty_per_item: number };

const ENGLISH_ONLY = /^[A-Za-z0-9 .,&()/%+\-]+$/;

export function InventoryAdminPage() {
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [ingredientForm, setIngredientForm] = useState({
    id: '',
    name: '',
    unit: '',
    on_hand_qty: '0',
    reserved_qty: '0',
    reorder_level: '0'
  });

  const [recipeForm, setRecipeForm] = useState({
    menu_item_id: '',
    ingredient_id: '',
    qty_per_item: '1'
  });

  const ingredientById = useMemo(() => Object.fromEntries(ingredients.map((i) => [i.id, i])), [ingredients]);
  const menuItemById = useMemo(() => Object.fromEntries(menuItems.map((m) => [m.id, m])), [menuItems]);

  const load = async () => {
    setLoading(true);
    setError(null);

    const [ingRes, menuRes, recipeRes] = await Promise.all([
      supabase
        .from('inventory_ingredients')
        .select('id,name,unit,on_hand_qty,reserved_qty,reorder_level')
        .is('deleted_at', null)
        .order('name', { ascending: true }),
      supabase
        .from('menu_items')
        .select('id,name')
        .eq('is_active', true)
        .is('deleted_at', null)
        .order('name', { ascending: true }),
      supabase
        .from('recipes')
        .select('id,menu_item_id,ingredient_id,qty_per_item')
        .is('deleted_at', null)
        .order('created_at', { ascending: true })
    ]);

    if (ingRes.error || menuRes.error || recipeRes.error) {
      setError(ingRes.error?.message ?? menuRes.error?.message ?? recipeRes.error?.message ?? 'Failed to load data');
      setLoading(false);
      return;
    }

    setIngredients((ingRes.data as Ingredient[]) ?? []);
    setMenuItems((menuRes.data as MenuItem[]) ?? []);
    setRecipes((recipeRes.data as Recipe[]) ?? []);

    if (!recipeForm.menu_item_id && (menuRes.data as MenuItem[])?.[0]?.id) {
      setRecipeForm((prev) => ({ ...prev, menu_item_id: (menuRes.data as MenuItem[])[0].id }));
    }
    if (!recipeForm.ingredient_id && (ingRes.data as Ingredient[])?.[0]?.id) {
      setRecipeForm((prev) => ({ ...prev, ingredient_id: (ingRes.data as Ingredient[])[0].id }));
    }

    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  const submitIngredient = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;

    if (!ENGLISH_ONLY.test(ingredientForm.name) || !ENGLISH_ONLY.test(ingredientForm.unit)) {
      setError('Ingredient name and unit must be English-only content.');
      return;
    }

    setBusy(true);
    setError(null);

    const { error: saveError } = await supabase.rpc('admin_upsert_ingredient', {
      p_id: ingredientForm.id || null,
      p_name: ingredientForm.name.trim(),
      p_unit: ingredientForm.unit.trim(),
      p_on_hand_qty: Math.max(0, Number(ingredientForm.on_hand_qty) || 0),
      p_reserved_qty: Math.max(0, Number(ingredientForm.reserved_qty) || 0),
      p_reorder_level: Math.max(0, Number(ingredientForm.reorder_level) || 0)
    });

    if (saveError) {
      setError(saveError.message);
      setBusy(false);
      return;
    }

    setIngredientForm({ id: '', name: '', unit: '', on_hand_qty: '0', reserved_qty: '0', reorder_level: '0' });
    await load();
    setBusy(false);
  };

  const editIngredient = (ingredient: Ingredient) => {
    setIngredientForm({
      id: ingredient.id,
      name: ingredient.name,
      unit: ingredient.unit,
      on_hand_qty: String(ingredient.on_hand_qty),
      reserved_qty: String(ingredient.reserved_qty),
      reorder_level: String(ingredient.reorder_level)
    });
  };

  const deleteIngredient = async (id: string) => {
    const reason = window.prompt('Delete reason');
    if (!reason || busy) return;

    setBusy(true);
    const { error: delError } = await supabase.rpc('admin_delete_ingredient', {
      p_id: id,
      p_reason: reason
    });
    if (delError) setError(delError.message);
    else await load();
    setBusy(false);
  };

  const submitRecipe = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;

    setBusy(true);
    const { error: saveError } = await supabase.rpc('admin_upsert_recipe', {
      p_menu_item_id: recipeForm.menu_item_id,
      p_ingredient_id: recipeForm.ingredient_id,
      p_qty_per_item: Math.max(0.001, Number(recipeForm.qty_per_item) || 0.001)
    });
    if (saveError) setError(saveError.message);
    else await load();
    setBusy(false);
  };

  const deleteRecipe = async (r: Recipe) => {
    const reason = window.prompt('Delete recipe reason');
    if (!reason || busy) return;

    setBusy(true);
    const { error: delError } = await supabase.rpc('admin_delete_recipe', {
      p_menu_item_id: r.menu_item_id,
      p_ingredient_id: r.ingredient_id,
      p_reason: reason
    });
    if (delError) setError(delError.message);
    else await load();
    setBusy(false);
  };

  return (
    <main className="min-h-screen bg-slate-100 p-4">
      <div className="mx-auto grid max-w-7xl gap-4 lg:grid-cols-2">
        <section className="rounded-xl bg-white p-4 shadow-sm">
          <h1 className="text-xl font-bold">Admin Inventory</h1>
          <p className="mt-1 text-sm text-slate-600">
            Strategy: reserve inventory on <strong>Accept</strong>, deduct on <strong>Print</strong>. If stock is insufficient,
            printing still proceeds while low-stock is logged.
          </p>
          {error ? <p className="mt-2 rounded bg-red-50 p-2 text-sm text-red-600">{error}</p> : null}
          {loading ? <p className="mt-2 text-sm">Loading...</p> : null}

          <form onSubmit={submitIngredient} className="mt-4 grid gap-2 md:grid-cols-2">
            <input className="rounded border px-2 py-1" placeholder="Ingredient name (English)" value={ingredientForm.name} onChange={(e) => setIngredientForm((p) => ({ ...p, name: e.target.value }))} />
            <input className="rounded border px-2 py-1" placeholder="Unit (English)" value={ingredientForm.unit} onChange={(e) => setIngredientForm((p) => ({ ...p, unit: e.target.value }))} />
            <input className="rounded border px-2 py-1" type="number" min="0" step="0.001" placeholder="On hand" value={ingredientForm.on_hand_qty} onChange={(e) => setIngredientForm((p) => ({ ...p, on_hand_qty: e.target.value }))} />
            <input className="rounded border px-2 py-1" type="number" min="0" step="0.001" placeholder="Reserved" value={ingredientForm.reserved_qty} onChange={(e) => setIngredientForm((p) => ({ ...p, reserved_qty: e.target.value }))} />
            <input className="rounded border px-2 py-1" type="number" min="0" step="0.001" placeholder="Reorder level" value={ingredientForm.reorder_level} onChange={(e) => setIngredientForm((p) => ({ ...p, reorder_level: e.target.value }))} />
            <div className="flex gap-2">
              <button disabled={busy} className="rounded bg-brand-700 px-3 py-1 text-white disabled:bg-slate-300">{ingredientForm.id ? 'Update' : 'Create'}</button>
              {ingredientForm.id ? (
                <button type="button" className="rounded border px-3 py-1" onClick={() => setIngredientForm({ id: '', name: '', unit: '', on_hand_qty: '0', reserved_qty: '0', reorder_level: '0' })}>Cancel</button>
              ) : null}
            </div>
          </form>

          <div className="mt-4 overflow-auto rounded border">
            <table className="w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-2 py-1 text-left">Name</th>
                  <th className="px-2 py-1 text-left">Unit</th>
                  <th className="px-2 py-1 text-right">On hand</th>
                  <th className="px-2 py-1 text-right">Reserved</th>
                  <th className="px-2 py-1 text-right">Reorder</th>
                  <th className="px-2 py-1 text-left">Actions</th>
                </tr>
              </thead>
              <tbody>
                {ingredients.map((i) => (
                  <tr key={i.id} className="border-t">
                    <td className="px-2 py-1" dir="ltr">{i.name}</td>
                    <td className="px-2 py-1" dir="ltr">{i.unit}</td>
                    <td className="px-2 py-1 text-right">{i.on_hand_qty}</td>
                    <td className="px-2 py-1 text-right">{i.reserved_qty}</td>
                    <td className="px-2 py-1 text-right">{i.reorder_level}</td>
                    <td className="px-2 py-1">
                      <div className="flex gap-1">
                        <button type="button" className="rounded border px-2 py-0.5" onClick={() => editIngredient(i)}>Edit</button>
                        <button type="button" className="rounded border px-2 py-0.5 text-red-600" onClick={() => void deleteIngredient(i.id)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-xl bg-white p-4 shadow-sm">
          <h2 className="text-xl font-bold">Recipes (BOM)</h2>
          <form onSubmit={submitRecipe} className="mt-3 grid gap-2 md:grid-cols-2">
            <select className="rounded border px-2 py-1" value={recipeForm.menu_item_id} onChange={(e) => setRecipeForm((p) => ({ ...p, menu_item_id: e.target.value }))}>
              {menuItems.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            <select className="rounded border px-2 py-1" value={recipeForm.ingredient_id} onChange={(e) => setRecipeForm((p) => ({ ...p, ingredient_id: e.target.value }))}>
              {ingredients.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
            <input className="rounded border px-2 py-1" type="number" min="0.001" step="0.001" value={recipeForm.qty_per_item} onChange={(e) => setRecipeForm((p) => ({ ...p, qty_per_item: e.target.value }))} />
            <button disabled={busy} className="rounded bg-brand-500 px-3 py-1 text-white disabled:bg-slate-300">Upsert Recipe Link</button>
          </form>

          <div className="mt-4 overflow-auto rounded border">
            <table className="w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-2 py-1 text-left">Menu Item</th>
                  <th className="px-2 py-1 text-left">Ingredient</th>
                  <th className="px-2 py-1 text-right">Qty / item</th>
                  <th className="px-2 py-1 text-left">Actions</th>
                </tr>
              </thead>
              <tbody>
                {recipes.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="px-2 py-1" dir="ltr">{menuItemById[r.menu_item_id]?.name ?? r.menu_item_id}</td>
                    <td className="px-2 py-1" dir="ltr">{ingredientById[r.ingredient_id]?.name ?? r.ingredient_id}</td>
                    <td className="px-2 py-1 text-right">{r.qty_per_item}</td>
                    <td className="px-2 py-1">
                      <button type="button" className="rounded border px-2 py-0.5 text-red-600" onClick={() => void deleteRecipe(r)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}
