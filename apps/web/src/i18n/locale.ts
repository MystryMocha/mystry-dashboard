/**
 * 界面语言管理：与 theme.ts 的外观模型一致，用户可选「自动」或固定语言。
 * - 自动：按浏览器语言列表匹配，繁体（zh-Hant、zh-TW/HK/MO）用繁體中文，其他 zh* 用简体中文，其余一律英文；
 * - en 为默认语言，也是缺键时的回落语言。
 * 初始值由 index.html 内联脚本在渲染前写入 <html lang> 与 data 属性，
 * 这里负责读取、切换、跟随浏览器语言变化，并广播事件让所有订阅者重新渲染。
 */

export const LOCALES = ['en', 'zh-CN', 'zh-TW'] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_PREFERENCES = ['auto', ...LOCALES] as const;
export type LocalePreference = (typeof LOCALE_PREFERENCES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

/** 语言名称始终用该语言自身书写（English / 简体中文），切换时才认得出来。 */
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

/** 繁体标记：显式 Hant 脚本，或未写 Hans 时地区为台湾、香港、澳门。 */
function isTraditionalChinese(tag: string): boolean {
  if (/(^|-)hant(-|$)/.test(tag)) return true;
  if (/(^|-)hans(-|$)/.test(tag)) return false;
  return /(^|-)(tw|hk|mo)(-|$)/.test(tag);
}

/** 按浏览器语言列表挑选界面语言；规则必须与 index.html 内联脚本保持一致。 */
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

/** 用户选择的语言（可能是「自动」）。 */
export function getLocalePreference(): LocalePreference {
  const current = document.documentElement.dataset.localePreference;
  return isLocalePreference(current) ? current : 'auto';
}

/** 当前实际生效的界面语言。 */
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
    /* 隐私模式等场景下静默降级为仅本次会话生效 */
  }
  apply(preference);
}

/** 「自动」语言下跟随浏览器语言设置变化；返回取消监听函数。 */
export function watchBrowserLocale(): () => void {
  const onChange = () => {
    if (getLocalePreference() === 'auto') apply('auto');
  };
  window.addEventListener('languagechange', onChange);
  return () => window.removeEventListener('languagechange', onChange);
}
