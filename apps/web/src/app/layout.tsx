import type { Metadata } from 'next';

import { AppShell } from '@/components/layout/app-shell';
import { LanguageProvider } from '@/components/providers/language-provider';

import './globals.css';

export const metadata: Metadata = {
  title: 'Restaurant RMS',
  description: 'Production-ready Restaurant RMS starter with POS and admin dashboards.'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" dir="ltr">
      <body>
        <LanguageProvider>
          <AppShell>{children}</AppShell>
        </LanguageProvider>
      </body>
    </html>
  );
}
