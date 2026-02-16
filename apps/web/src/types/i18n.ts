export const SUPPORTED_LOCALES = ['en', 'ar'] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export type TranslationMap = {
  appTitle: string;
  pos: string;
  admin: string;
  table: string;
  language: string;
  welcomeTitle: string;
  welcomeDescription: string;
  menuTitle: string;
  tableHint: string;
};
