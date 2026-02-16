'use client';

import { useLanguage } from '@/components/providers/language-provider';

export default function AdminPage() {
  const { t } = useLanguage();

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-900">{t('admin')}</h1>
      <p className="text-slate-600">{t('welcomeTitle')}</p>
      <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-700">
        Admin dashboard starter page is ready for modules like inventory, finance, and staff management.
      </div>
    </section>
  );
}
