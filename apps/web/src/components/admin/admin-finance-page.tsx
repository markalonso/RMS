'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';

import { supabase } from '@/lib/supabase';

type Ingredient = { id: string; name: string; unit: string };
type PurchaseInvoice = { id: string; supplier_name: string | null; invoice_number: string | null; invoice_date: string; created_at: string };
type Expense = { id: string; category: 'operational' | 'admin' | 'purchase'; amount: number; note: string | null; occurred_at: string; exclude_from_profit: boolean };
type BusinessDay = { id: string; status: 'open' | 'closed'; opened_at: string; closed_at: string | null };

type PurchaseItemDraft = { ingredient_id: string; qty: string; unit_cost: string };

export function AdminFinancePage() {
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [businessDays, setBusinessDays] = useState<BusinessDay[]>([]);
  const [invoices, setInvoices] = useState<PurchaseInvoice[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);

  const [supplierName, setSupplierName] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().slice(0, 10));
  const [purchaseNotes, setPurchaseNotes] = useState('');
  const [purchaseItems, setPurchaseItems] = useState<PurchaseItemDraft[]>([{ ingredient_id: '', qty: '1', unit_cost: '0' }]);

  const [expenseCategory, setExpenseCategory] = useState<'operational' | 'admin' | 'purchase'>('operational');
  const [expenseAmount, setExpenseAmount] = useState('0');
  const [expenseNote, setExpenseNote] = useState('');
  const [expenseOccurredAt, setExpenseOccurredAt] = useState(new Date().toISOString().slice(0, 16));
  const [expenseBusinessDayId, setExpenseBusinessDayId] = useState('');
  const [linkedPurchaseInvoiceId, setLinkedPurchaseInvoiceId] = useState('');

  const [reportBusinessDayId, setReportBusinessDayId] = useState('');
  const [report, setReport] = useState<Record<string, unknown> | null>(null);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ingredientById = useMemo(() => Object.fromEntries(ingredients.map((i) => [i.id, i])), [ingredients]);

  const load = async () => {
    setLoading(true);
    setError(null);

    const [ingredientsRes, daysRes, invoicesRes, expensesRes] = await Promise.all([
      supabase
        .from('inventory_ingredients')
        .select('id,name,unit')
        .is('deleted_at', null)
        .order('name', { ascending: true }),
      supabase
        .from('business_days')
        .select('id,status,opened_at,closed_at')
        .is('deleted_at', null)
        .order('opened_at', { ascending: false })
        .limit(30),
      supabase
        .from('purchase_invoices')
        .select('id,supplier_name,invoice_number,invoice_date,created_at')
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(50),
      supabase
        .from('expenses')
        .select('id,category,amount,note,occurred_at,exclude_from_profit')
        .is('deleted_at', null)
        .order('occurred_at', { ascending: false })
        .limit(100)
    ]);

    if (ingredientsRes.error || daysRes.error || invoicesRes.error || expensesRes.error) {
      setError(ingredientsRes.error?.message ?? daysRes.error?.message ?? invoicesRes.error?.message ?? expensesRes.error?.message ?? 'Failed to load finance data');
      setLoading(false);
      return;
    }

    setIngredients((ingredientsRes.data as Ingredient[]) ?? []);
    setBusinessDays((daysRes.data as BusinessDay[]) ?? []);
    setInvoices((invoicesRes.data as PurchaseInvoice[]) ?? []);
    setExpenses((expensesRes.data as Expense[]) ?? []);

    if (!reportBusinessDayId && (daysRes.data as BusinessDay[])?.[0]?.id) setReportBusinessDayId((daysRes.data as BusinessDay[])[0].id);
    if (!expenseBusinessDayId && (daysRes.data as BusinessDay[])?.[0]?.id) setExpenseBusinessDayId((daysRes.data as BusinessDay[])[0].id);
    if ((ingredientsRes.data as Ingredient[])?.[0]?.id && !purchaseItems[0]?.ingredient_id) {
      setPurchaseItems([{ ingredient_id: (ingredientsRes.data as Ingredient[])[0].id, qty: '1', unit_cost: '0' }]);
    }

    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  const submitPurchase = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;

    const payload = purchaseItems
      .filter((p) => p.ingredient_id && Number(p.qty) > 0)
      .map((p) => ({ ingredient_id: p.ingredient_id, qty: Number(p.qty), unit_cost: Math.max(0, Number(p.unit_cost) || 0) }));

    if (payload.length === 0) {
      setError('Add at least one purchase item.');
      return;
    }

    setBusy(true);
    setError(null);

    const { error: createError } = await supabase.rpc('admin_create_purchase_invoice', {
      p_supplier_name: supplierName,
      p_invoice_number: invoiceNumber,
      p_invoice_date: invoiceDate,
      p_notes: purchaseNotes,
      p_items: payload
    });

    if (createError) {
      setError(createError.message);
      setBusy(false);
      return;
    }

    setSupplierName('');
    setInvoiceNumber('');
    setPurchaseNotes('');
    setPurchaseItems([{ ingredient_id: ingredients[0]?.id ?? '', qty: '1', unit_cost: '0' }]);
    await load();
    setBusy(false);
  };

  const submitExpense = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;

    setBusy(true);
    setError(null);

    const { error: expError } = await supabase.rpc('admin_create_expense', {
      p_category: expenseCategory,
      p_amount: Math.max(0, Number(expenseAmount) || 0),
      p_note: expenseNote,
      p_occurred_at: expenseOccurredAt ? new Date(expenseOccurredAt).toISOString() : new Date().toISOString(),
      p_business_day_id: expenseBusinessDayId || null,
      p_linked_purchase_invoice_id: linkedPurchaseInvoiceId || null
    });

    if (expError) {
      setError(expError.message);
      setBusy(false);
      return;
    }

    setExpenseAmount('0');
    setExpenseNote('');
    setLinkedPurchaseInvoiceId('');
    await load();
    setBusy(false);
  };

  const runReport = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);

    const { data, error: reportError } = await supabase.rpc('admin_get_business_day_report', {
      p_business_day_id: reportBusinessDayId || null
    });

    if (reportError) {
      setError(reportError.message);
      setBusy(false);
      return;
    }

    setReport((data as Record<string, unknown>) ?? null);
    setBusy(false);
  };

  return (
    <main className="min-h-screen bg-slate-100 p-4">
      <div className="mx-auto grid max-w-7xl gap-4 lg:grid-cols-2">
        <section className="rounded-xl bg-white p-4 shadow-sm">
          <h1 className="text-xl font-bold">Admin Finance</h1>
          <p className="mt-1 text-sm text-slate-600">Screen-only reporting. Purchases increase inventory via purchase items.</p>
          {error ? <p className="mt-2 rounded bg-red-50 p-2 text-sm text-red-600">{error}</p> : null}
          {loading ? <p className="mt-2 text-sm">Loading...</p> : null}

          <form onSubmit={submitPurchase} className="mt-4 space-y-2 rounded border p-3">
            <h2 className="font-semibold">Purchases</h2>
            <input className="w-full rounded border px-2 py-1" placeholder="Supplier" value={supplierName} onChange={(e) => setSupplierName(e.target.value)} />
            <input className="w-full rounded border px-2 py-1" placeholder="Invoice number" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} />
            <input className="w-full rounded border px-2 py-1" type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
            <textarea className="w-full rounded border px-2 py-1" placeholder="Notes" value={purchaseNotes} onChange={(e) => setPurchaseNotes(e.target.value)} />

            <div className="space-y-2">
              {purchaseItems.map((item, idx) => (
                <div key={idx} className="grid gap-2 md:grid-cols-4">
                  <select className="rounded border px-2 py-1" value={item.ingredient_id} onChange={(e) => setPurchaseItems((prev) => prev.map((p, i) => (i === idx ? { ...p, ingredient_id: e.target.value } : p)))}>
                    {ingredients.map((ing) => (
                      <option key={ing.id} value={ing.id}>{ing.name} ({ing.unit})</option>
                    ))}
                  </select>
                  <input className="rounded border px-2 py-1" type="number" min="0.001" step="0.001" placeholder="Qty" value={item.qty} onChange={(e) => setPurchaseItems((prev) => prev.map((p, i) => (i === idx ? { ...p, qty: e.target.value } : p)))} />
                  <input className="rounded border px-2 py-1" type="number" min="0" step="0.01" placeholder="Unit cost" value={item.unit_cost} onChange={(e) => setPurchaseItems((prev) => prev.map((p, i) => (i === idx ? { ...p, unit_cost: e.target.value } : p)))} />
                  <button type="button" className="rounded border px-2 py-1 text-red-600" onClick={() => setPurchaseItems((prev) => prev.filter((_, i) => i !== idx))}>Remove</button>
                </div>
              ))}
              <button type="button" className="rounded border px-2 py-1" onClick={() => setPurchaseItems((prev) => [...prev, { ingredient_id: ingredients[0]?.id ?? '', qty: '1', unit_cost: '0' }])}>Add purchase item</button>
            </div>

            <button disabled={busy} className="rounded bg-brand-700 px-3 py-1 text-white disabled:bg-slate-300">Create Purchase Invoice</button>
          </form>

          <form onSubmit={submitExpense} className="mt-4 space-y-2 rounded border p-3">
            <h2 className="font-semibold">Expenses</h2>
            <select className="w-full rounded border px-2 py-1" value={expenseCategory} onChange={(e) => setExpenseCategory(e.target.value as 'operational' | 'admin' | 'purchase')}>
              <option value="operational">Operational (excludes water/electricity)</option>
              <option value="admin">Administrative</option>
              <option value="purchase">Purchase-type</option>
            </select>
            <input className="w-full rounded border px-2 py-1" type="number" min="0.01" step="0.01" placeholder="Amount" value={expenseAmount} onChange={(e) => setExpenseAmount(e.target.value)} />
            <textarea className="w-full rounded border px-2 py-1" placeholder="Note" value={expenseNote} onChange={(e) => setExpenseNote(e.target.value)} />
            <input className="w-full rounded border px-2 py-1" type="datetime-local" value={expenseOccurredAt} onChange={(e) => setExpenseOccurredAt(e.target.value)} />
            <select className="w-full rounded border px-2 py-1" value={expenseBusinessDayId} onChange={(e) => setExpenseBusinessDayId(e.target.value)}>
              <option value="">No business day</option>
              {businessDays.map((bd) => <option key={bd.id} value={bd.id}>{bd.id.slice(0, 8)} · {bd.status}</option>)}
            </select>
            <select className="w-full rounded border px-2 py-1" value={linkedPurchaseInvoiceId} onChange={(e) => setLinkedPurchaseInvoiceId(e.target.value)}>
              <option value="">No linked purchase invoice</option>
              {invoices.map((inv) => <option key={inv.id} value={inv.id}>{inv.invoice_number ?? inv.id.slice(0, 8)} · {inv.supplier_name ?? '-'}</option>)}
            </select>
            <button disabled={busy} className="rounded bg-brand-500 px-3 py-1 text-white disabled:bg-slate-300">Record Expense</button>
          </form>
        </section>

        <section className="rounded-xl bg-white p-4 shadow-sm">
          <h2 className="text-xl font-bold">Business Day Report</h2>
          <div className="mt-3 flex gap-2">
            <select className="flex-1 rounded border px-2 py-1" value={reportBusinessDayId} onChange={(e) => setReportBusinessDayId(e.target.value)}>
              {businessDays.map((bd) => <option key={bd.id} value={bd.id}>{bd.id.slice(0, 8)} · {bd.status} · {new Date(bd.opened_at).toLocaleDateString()}</option>)}
            </select>
            <button disabled={busy} className="rounded bg-slate-900 px-3 py-1 text-white disabled:bg-slate-300" onClick={() => void runReport()}>Run</button>
          </div>

          {report ? (
            <div className="mt-3 rounded border bg-slate-50 p-3 text-sm">
              <pre className="overflow-auto text-xs">{JSON.stringify(report, null, 2)}</pre>
            </div>
          ) : (
            <p className="mt-3 text-sm text-slate-500">Run a report to view sales, tax, delivery fees, COGS estimate, expenses, and net profit estimate.</p>
          )}

          <div className="mt-4 rounded border p-3">
            <h3 className="font-semibold">Recent Purchases</h3>
            <ul className="mt-2 space-y-1 text-sm">
              {invoices.map((inv) => (
                <li key={inv.id}>
                  {inv.invoice_number ?? inv.id.slice(0, 8)} · {inv.supplier_name ?? '-'} · {new Date(inv.invoice_date).toLocaleDateString()}
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-4 rounded border p-3">
            <h3 className="font-semibold">Recent Expenses</h3>
            <ul className="mt-2 space-y-1 text-sm">
              {expenses.map((exp) => (
                <li key={exp.id}>
                  {exp.category} · {exp.amount} · {exp.note ?? '-'}
                  {exp.exclude_from_profit ? ' (excluded from net profit to avoid double counting)' : ''}
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>
    </main>
  );
}
