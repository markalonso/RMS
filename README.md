# Restaurant RMS (Next.js 14 + Supabase)

Production-ready starter for a Restaurant RMS using **Next.js App Router**, **TypeScript**, **Tailwind CSS**, and **Supabase**.

## Tech Stack

- Next.js 14 (App Router)
- TypeScript
- Tailwind CSS
- Supabase (`@supabase/supabase-js`)
- ESLint (`next/core-web-vitals` + `next/typescript`)

## Folder Structure

```text
apps/web/src/
  app/
    (public)/
      table/[tableNumber]/page.tsx
    (dashboard)/
      pos/page.tsx
      admin/page.tsx
    layout.tsx
    page.tsx
  lib/
    supabaseClient.ts
  types/
    i18n.ts
  components/
    layout/app-shell.tsx
    providers/language-provider.tsx
  utils/
    i18n.ts
```

## Environment Variables

Create `apps/web/.env.local` from root `.env.example`:

```bash
cp .env.example apps/web/.env.local
```

Required values:

```env
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY
```

## i18n + RTL Notes

- UI supports **English** and **Arabic** only.
- Language toggle is in the global header.
- Arabic automatically sets `dir="rtl"` and `lang="ar"`.
- **Menu content remains English only** (not auto-translated).

## Routes

- `/` → redirects to `/pos`
- `/pos` → dashboard POS starter
- `/admin` → dashboard admin starter
- `/table/[tableNumber]` → public table page

## Run

From repository root:

```bash
npm install
npm run dev
```

Then open: `http://localhost:3000`.
