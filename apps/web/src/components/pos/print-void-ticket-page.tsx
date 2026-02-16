'use client';

import { useEffect, useState } from 'react';

import { supabase } from '@/lib/supabase';

type VoidTicket = {
  void_log_id: string;
  created_at: string;
  reason: string;
  approved_via: string;
  order_id: string;
  session_id: string;
  table_number: number | null;
  item: {
    menu_item_name: string;
    qty: number;
    notes: string | null;
    selected_modifiers: Array<{ name?: string }>;
  };
};

export function VoidTicketPage({ voidLogId }: { voidLogId: string }) {
  const [ticket, setTicket] = useState<VoidTicket | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      const { data, error: loadError } = await supabase.rpc('pos_get_void_ticket', {
        p_void_log_id: voidLogId
      });
      if (loadError) {
        setError(loadError.message);
        return;
      }
      setTicket(data as VoidTicket);
    };
    void load();
  }, [voidLogId]);

  useEffect(() => {
    if (ticket) {
      const timeout = window.setTimeout(() => window.print(), 200);
      return () => window.clearTimeout(timeout);
    }
    return undefined;
  }, [ticket]);

  if (error) return <main className="p-6 text-red-600">{error}</main>;
  if (!ticket) return <main className="p-6">Loading VOID ticket...</main>;

  return (
    <main className="mx-auto max-w-md bg-white p-4 font-mono text-sm text-black">
      <h1 className="border-b pb-2 text-lg font-bold">VOID TICKET</h1>
      <p className="mt-2">Void Log: {ticket.void_log_id}</p>
      <p>Order: {ticket.order_id}</p>
      <p>Session: {ticket.session_id}</p>
      <p>Table: {ticket.table_number ?? '-'}</p>
      <p>Time: {new Date(ticket.created_at).toLocaleString()}</p>
      <p>Approved: {ticket.approved_via}</p>
      <hr className="my-3" />
      <p className="font-bold">VOID {ticket.item.qty} × {ticket.item.menu_item_name}</p>
      {ticket.item.notes ? <p>Notes: {ticket.item.notes}</p> : null}
      {ticket.item.selected_modifiers?.length ? (
        <p>Modifiers: {ticket.item.selected_modifiers.map((m) => m.name).filter(Boolean).join(', ')}</p>
      ) : null}
      <p className="mt-2">Reason: {ticket.reason}</p>
    </main>
  );
}
