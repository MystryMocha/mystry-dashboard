/**
 * UI language management: same model as appearance in theme.ts, where the user can choose "auto" or a fixed language.
 * - Auto: matched against the browser's language list; Traditional (zh-Hant, zh-TW/HK/MO) uses Traditional Chinese, other zh* use Simplified Chinese, and everything else English;
 * - en is the default language and also the fallback for missing keys.
 * The initial value is written to <html lang> and data attributes before rendering by the inline script in index.html;
 * this module reads it, switches it, follows browser language changes, and broadcasts an event so all subscribers re-render.
 */

export const LOCALES = ['en', 'zh-CN', 'zh-TW'] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_PREFERENCES = ['auto', ...LOCALES] as const;
export type LocalePreference = (typeof LOCALE_PREFERENCES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

/** Language names are always written in the language itself (English / 简体中文), so they are recognizable when switching. */
export const LOCALE_NATIVE_NAMES: Record<Locale, string> = {
  en: 'English',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
};

const LOCALE_KEY = 'mystry_locale';
export const LOCALE_CHANGE_EVENT = 'mystry:locale-change';

export function isLocale(value: string | null | undefined): value is Locale {
  return (LOCALES as readonly string[]).includes(value ?? '');
}

export function isLocalePreference(value: string | null | undefined): value is LocalePreference {
  return (LOCALE_PREFERENCES as readonly string[]).includes(value ?? '');
}

/** Traditional marker: an explicit Hant script, or a region of Taiwan, Hong Kong or Macau when Hans is not written. */
function isTraditionalChinese(tag: string): boolean {
  if (/(^|-)hant(-|$)/.test(tag)) return true;
  if (/(^|-)hans(-|$)/.test(tag)) return false;
  return /(^|-)(tw|hk|mo)(-|$)/.test(tag);
}

/** Picks the UI language from the browser's language list; the rules must stay in sync with the inline script in index.html. */
export function detectLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const tag = language.toLowerCase();
    if (tag.startsWith('zh')) return isTraditionalChinese(tag) ? 'zh-TW' : 'zh-CN';
    if (tag.startsWith('en')) return 'en';
  }
  return DEFAULT_LOCALE;
}

function browserLanguages(): readonly string[] {
  try {
    if (navigator.languages?.length) return navigator.languages;
    return navigator.language ? [navigator.language] : [];
  } catch {
    return [];
  }
}

function resolveLocale(preference: LocalePreference): Locale {
  return preference === 'auto' ? detectLocale(browserLanguages()) : preference;
}

/** The language the user chose (possibly "auto"). */
export function getLocalePreference(): LocalePreference {
  const current = document.documentElement.dataset.localePreference;
  return isLocalePreference(current) ? current : 'auto';
}

/** The UI language actually in effect. */
export function getLocale(): Locale {
  const current = document.documentElement.lang;
  return isLocale(current) ? current : resolveLocale(getLocalePreference());
}

function apply(preference: LocalePreference): void {
  const root = document.documentElement;
  root.dataset.localePreference = preference;
  root.lang = resolveLocale(preference);
  window.dispatchEvent(new CustomEvent(LOCALE_CHANGE_EVENT));
}

export function setLocalePreference(preference: LocalePreference): void {
  try {
    localStorage.setItem(LOCALE_KEY, preference);
  } catch {
    /* In cases such as private mode, silently degrade to taking effect for this session only */
  }
  apply(preference);
}

/** Follows browser language setting changes under the "auto" language; returns a function that removes the listener. */
export function watchBrowserLocale(): () => void {
  const onChange = () => {
    if (getLocalePreference() === 'auto') apply('auto');
  };
  window.addEventListener('languagechange', onChange);
  return () => window.removeEventListener('languagechange', onChange);
}
