/**
 * 外观管理：自动（跟随系统）/ 浅色 / 深色。强调色固定为墨紫，写在 styles.css，不再由用户选择。
 * 初始值由 index.html 内联脚本在渲染前写入 <html> 的 data 属性
 *（含旧版 mystry_theme 六主题的迁移），这里负责读取、切换、跟随系统变化，
 * 并广播事件让多处选择器保持同步。
 */
import type { MessageKey } from './i18n';

export const APPEARANCES = ['auto', 'light', 'dark'] as const;
export type Appearance = (typeof APPEARANCES)[number];

/** 外观的显示名称对应的文案键。 */
export const APPEARANCE_LABEL_KEYS = {
  auto: 'appearance.auto',
  light: 'appearance.light',
  dark: 'appearance.dark',
} as const satisfies Record<Appearance, MessageKey>;

const APPEARANCE_KEY = 'mystry_appearance';
export const THEME_CHANGE_EVENT = 'mystry:theme-change';

export function isAppearance(value: string | null | undefined): value is Appearance {
  return (APPEARANCES as readonly string[]).includes(value ?? '');
}

function prefersDark(): boolean {
  try {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  } catch {
    return false;
  }
}

function resolveAppearance(preference: Appearance): 'light' | 'dark' {
  if (preference === 'auto') return prefersDark() ? 'dark' : 'light';
  return preference;
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 隐私模式等场景下静默降级为仅本次会话生效 */
  }
}

/** 用户选择的外观（可能是「自动」）。 */
export function getAppearance(): Appearance {
  const current = document.documentElement.dataset.appearancePreference;
  return isAppearance(current) ? current : 'auto';
}

function apply(preference: Appearance): void {
  const root = document.documentElement;
  root.dataset.appearancePreference = preference;
  root.dataset.appearance = resolveAppearance(preference);
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));
}

export function setAppearance(preference: Appearance): void {
  store(APPEARANCE_KEY, preference);
  apply(preference);
}

/** 「自动」外观下跟随系统深浅色切换；返回取消监听函数。 */
export function watchSystemAppearance(): () => void {
  let query: MediaQueryList | undefined;
  try {
    query = window.matchMedia?.('(prefers-color-scheme: dark)');
  } catch {
    return () => {};
  }
  if (!query?.addEventListener) return () => {};
  const onChange = () => {
    if (getAppearance() === 'auto') apply('auto');
  };
  query.addEventListener('change', onChange);
  return () => query?.removeEventListener('change', onChange);
}
