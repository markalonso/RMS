'use client';

import { useEffect, useState } from 'react';

import { supabase } from '@/lib/supabase';

type KitchenTicket = {
  order_id: string;
  status: string;
  created_at: string;
  source: string;
  table_number: number | null;
  order_type: string;
  items: Array<{
    item_name: string;
    qty: number;
    notes: string | null;
    selected_modifiers: Array<{ name?: string }>;
  }>;
};

export function KitchenTicketPage({ orderId }: { orderId: string }) {
  const [ticket, setTicket] = useState<KitchenTicket | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      const { data, error: ticketError } = await supabase.rpc('pos_get_kitchen_ticket', {
        p_order_id: orderId
      });

      if (ticketError) {
        setError(ticketError.message);
        return;
      }

      setTicket(data as KitchenTicket);
    };

    void load();
  }, [orderId]);

  useEffect(() => {
    if (ticket) {
      const timeout = window.setTimeout(() => window.print(), 200);
      return () => window.clearTimeout(timeout);
    }
    return undefined;
  }, [ticket]);

  if (error) {
    return <main className="p-6 text-red-600">{error}</main>;
  }

  if (!ticket) {
    return <main className="p-6">Loading ticket...</main>;
  }

  return (
    <main className="mx-auto max-w-md bg-white p-4 font-mono text-sm text-black">
      <h1 className="border-b pb-2 text-lg font-bold">KITCHEN / BAR TICKET</h1>
      <p className="mt-2">Order: {ticket.order_id}</p>
      <p>Type: {ticket.order_type}</p>
      <p>Table: {ticket.table_number ?? '-'}</p>
      <p>Source: {ticket.source}</p>
      <p>Time: {new Date(ticket.created_at).toLocaleString()}</p>

      <hr className="my-3" />
      <ul className="space-y-2">
        {ticket.items.map((item, idx) => (
          <li key={`${item.item_name}-${idx}`}>
            <p className="font-bold">{item.qty} × {item.item_name}</p>
            {item.notes ? <p>Note: {item.notes}</p> : null}
            {item.selected_modifiers?.length ? (
              <p>Add-ons: {item.selected_modifiers.map((m) => m.name).filter(Boolean).join(', ')}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </main>
  );
}
