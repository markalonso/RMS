'use client';

import { useLanguage } from '@/components/providers/language-provider';

const POS_MENU_ITEMS = [
  'Classic Burger',
  'Grilled Chicken Wrap',
  'Caesar Salad',
  'French Fries',
  'Fresh Orange Juice'
];

export default function PosPage() {
  const { t } = useLanguage();

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-900">{t('pos')}</h1>
      <p className="text-slate-600">{t('welcomeDescription')}</p>

      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-lg font-semibold text-slate-900">{t('menuTitle')}</h2>
        <ul className="list-disc space-y-1 ps-6 text-slate-700">
          {POS_MENU_ITEMS.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
