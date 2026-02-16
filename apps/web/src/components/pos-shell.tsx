'use client';

import { useMemo, useState } from 'react';

import { orderTicketSchema } from '@rms/shared';

import { supabase } from '@/lib/supabase';

const sampleTicket = {
  orderId: '10000000-0000-4000-8000-000000000001',
  tableCode: 'A-01',
  createdAt: new Date().toISOString(),
  lines: [
    { name: 'Nasi Goreng', qty: 2 },
    { name: 'Es Teh', qty: 2, note: 'Less sugar' }
  ]
};

export function PosShell() {
  const [status, setStatus] = useState('Idle');

  const validatedTicket = useMemo(() => orderTicketSchema.parse(sampleTicket), []);

  const checkSupabase = async () => {
    setStatus('Checking Supabase connection...');

    const { error } = await supabase.auth.getSession();
    setStatus(error ? `Supabase error: ${error.message}` : 'Supabase client ready.');
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 p-6">
      <header className="rounded-xl bg-white p-6 shadow-sm">
        <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">Online RMS</p>
        <h1 className="mt-2 text-3xl font-bold">Main POS Interface</h1>
        <p className="mt-3 text-slate-600">
          Kitchen flow uses printed tickets. No separate kitchen screen is enabled.
        </p>
      </header>

      <section className="grid gap-4 rounded-xl bg-white p-6 shadow-sm md:grid-cols-2">
        <div>
          <h2 className="text-xl font-semibold">Printing (current)</h2>
          <p className="mt-2 text-sm text-slate-600">
            Browser printing is active via <code>window.print()</code>. ESC/POS integration can be added in a
            dedicated print adapter later.
          </p>
          <button
            type="button"
            onClick={() => window.print()}
            className="mt-4 rounded-lg bg-brand-500 px-4 py-2 font-medium text-white hover:bg-brand-700"
          >
            Print Kitchen Ticket
          </button>
        </div>

        <div>
          <h2 className="text-xl font-semibold">Supabase</h2>
          <p className="mt-2 text-sm text-slate-600">Configured for Auth, Postgres, and Realtime.</p>
          <button
            type="button"
            onClick={checkSupabase}
            className="mt-4 rounded-lg border border-slate-300 px-4 py-2 font-medium text-slate-700 hover:bg-slate-100"
          >
            Check Client
          </button>
          <p className="mt-2 text-sm">{status}</p>
        </div>
      </section>

      <section className="rounded-xl bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold">Customer QR Rules</h2>
        <ul className="mt-2 list-disc space-y-2 pl-6 text-sm text-slate-700">
          <li>Customers can submit order requests only.</li>
          <li>Customers cannot view existing table orders.</li>
          <li>Customers cannot view bills.</li>
        </ul>
      </section>

      <section className="rounded-xl bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold">Ticket Preview</h2>
        <pre className="mt-3 overflow-auto rounded-lg bg-slate-900 p-4 text-xs text-slate-100">
          {JSON.stringify(validatedTicket, null, 2)}
        </pre>
      </section>
    </main>
  );
}
