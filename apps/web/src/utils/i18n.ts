import type { Locale, TranslationMap } from '@/types/i18n';

export const STORAGE_KEY = 'rms-language';

export const TRANSLATIONS: Record<Locale, TranslationMap> = {
  en: {
    appTitle: 'Restaurant RMS',
    pos: 'POS',
    admin: 'Admin',
    table: 'Table',
    language: 'Language',
    welcomeTitle: 'Welcome to the Restaurant RMS',
    welcomeDescription: 'Use the dashboard routes to manage operations quickly.',
    menuTitle: 'Menu (English only)',
    tableHint: 'Guests can open this screen using their table number.'
  },
  ar: {
    appTitle: 'نظام إدارة المطعم',
    pos: 'نقطة البيع',
    admin: 'الإدارة',
    table: 'الطاولة',
    language: 'اللغة',
    welcomeTitle: 'مرحبًا بك في نظام إدارة المطعم',
    welcomeDescription: 'استخدم صفحات لوحة التحكم لإدارة العمليات بسرعة.',
    menuTitle: 'قائمة الطعام (بالإنجليزية فقط)',
    tableHint: 'يمكن للضيوف فتح هذه الشاشة باستخدام رقم الطاولة.'
  }
};

export function getDirection(locale: Locale) {
  return locale === 'ar' ? 'rtl' : 'ltr';
}
