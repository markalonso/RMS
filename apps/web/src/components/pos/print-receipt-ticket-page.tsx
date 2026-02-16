'use client';

import { useEffect, useState } from 'react';

import { supabase } from '@/lib/supabase';

type ReceiptPayload = {
  session: { id: string; table_number: number | null; order_type: string; created_at: string } | null;
  bill: {
    subtotal: number;
    discount_amount: number;
    new_subtotal: number;
    tax_amount: number;
    delivery_fee: number;
    total: number;
    payment_status: string;
    updated_at: string;
  } | null;
  payments: Array<{ id: string; method: string; amount: number; created_at: string }>;
  items: Array<{ id: string; menu_item_name: string; qty: number; notes: string | null }>;
};

export function ReceiptTicketPage({ sessionId }: { sessionId: string }) {
  const [payload, setPayload] = useState<ReceiptPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      const { data, error: loadError } = await supabase.rpc('pos_get_receipt_payload', {
        p_session_id: sessionId
      });
      if (loadError) {
        setError(loadError.message);
        return;
      }
      setPayload(data as ReceiptPayload);
    };
    void load();
  }, [sessionId]);

  useEffect(() => {
    if (payload) {
      const timeout = window.setTimeout(() => window.print(), 200);
      return () => window.clearTimeout(timeout);
    }
    return undefined;
  }, [payload]);

  if (error) return <main className="p-6 text-red-600">{error}</main>;
  if (!payload || !payload.bill || !payload.session) return <main className="p-6">Loading receipt...</main>;

  return (
    <main className="mx-auto max-w-md bg-white p-4 font-mono text-sm text-black">
      <h1 className="border-b pb-2 text-lg font-bold">CUSTOMER RECEIPT</h1>
      <p className="mt-2">Session: {payload.session.id}</p>
      <p>Order Type: {payload.session.order_type}</p>
      <p>Table: {payload.session.table_number ?? '-'}</p>
      <p>Time: {new Date(payload.session.created_at).toLocaleString()}</p>

      <hr className="my-3" />
      <ul className="space-y-1">
        {payload.items.map((item) => (
          <li key={item.id}>
            {item.qty} × {item.menu_item_name}
            {item.notes ? ` (${item.notes})` : ''}
          </li>
        ))}
      </ul>

      <hr className="my-3" />
      <p>Subtotal: {payload.bill.subtotal}</p>
      <p>Discount: {payload.bill.discount_amount}</p>
      <p>New Subtotal: {payload.bill.new_subtotal}</p>
      <p>Tax: {payload.bill.tax_amount}</p>
      <p>Delivery Fee: {payload.bill.delivery_fee}</p>
      <p className="font-bold">Total: {payload.bill.total}</p>
      <p>Payment Status: {payload.bill.payment_status}</p>

      <hr className="my-3" />
      <p className="font-semibold">Payments</p>
      {payload.payments.map((p) => (
        <p key={p.id}>{p.method.toUpperCase()} {p.amount} @ {new Date(p.created_at).toLocaleString()}</p>
      ))}
    </main>
  );
}
