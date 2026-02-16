'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { useLanguage } from '@/components/providers/language-provider';

function NavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const isActive = pathname.startsWith(href);

  return (
    <Link
      href={href}
      className={`rounded-md px-3 py-2 text-sm font-medium transition ${
        isActive ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-200'
      }`}
    >
      {label}
    </Link>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { locale, setLocale, t } = useLanguage();

  return (
    <>
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <p className="font-semibold text-slate-900">{t('appTitle')}</p>

          <div className="flex items-center gap-2">
            <NavLink href="/pos" label={t('pos')} />
            <NavLink href="/admin" label={t('admin')} />
            <label className="ml-2 flex items-center gap-2 text-sm text-slate-700">
              <span>{t('language')}</span>
              <select
                className="rounded-md border border-slate-300 bg-white px-2 py-1"
                value={locale}
                onChange={(event) => setLocale(event.target.value as 'en' | 'ar')}
              >
                <option value="en">English</option>
                <option value="ar">العربية</option>
              </select>
            </label>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
    </>
  );
}
