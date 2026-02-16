'use client';

import { useLanguage } from '@/components/providers/language-provider';

type Props = {
  params: {
    tableNumber: string;
  };
};

export default function TablePage({ params }: Props) {
  const { t } = useLanguage();

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-900">
        {t('table')} #{params.tableNumber}
      </h1>
      <p className="text-slate-600">{t('tableHint')}</p>
      <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-700">
        Ordering flow can be integrated here with Supabase-backed realtime updates.
      </div>
    </section>
  );
}
