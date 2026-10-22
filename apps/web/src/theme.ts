/**
 * 外观管理：参照 macOS「外观 + 强调色」模型。
 * - 外观：自动（跟随系统）/ 浅色 / 深色；
 * - 强调色：蓝色、紫色、Mystry 粉、绿色、石墨。
 * 初始值由 index.html 内联脚本在渲染前写入 <html> 的 data 属性
 *（含旧版 mystry_theme 六主题的迁移），这里负责读取、切换、跟随系统变化，
 * 并广播事件让多处选择器保持同步。
 */

export const APPEARANCES = ['auto', 'light', 'dark'] as const;
export type Appearance = (typeof APPEARANCES)[number];

export const ACCENTS = ['blue', 'purple', 'pink', 'green', 'graphite'] as const;
export type Accent = (typeof ACCENTS)[number];

export const APPEARANCE_META: Record<Appearance, { label: string }> = {
  auto: { label: '自动' },
  light: { label: '浅色' },
  dark: { label: '深色' },
};

export const ACCENT_META: Record<Accent, { label: string }> = {
  blue: { label: '蓝色' },
  purple: { label: '紫色' },
  pink: { label: 'Mystry 粉' },
  green: { label: '绿色' },
  graphite: { label: '石墨' },
};

const APPEARANCE_KEY = 'mystry_appearance';
const ACCENT_KEY = 'mystry_accent';
export const THEME_CHANGE_EVENT = 'mystry:theme-change';

export function isAppearance(value: string | null | undefined): value is Appearance {
  return (APPEARANCES as readonly string[]).includes(value ?? '');
}

export function isAccent(value: string | null | undefined): value is Accent {
  return (ACCENTS as readonly string[]).includes(value ?? '');
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

export function getAccent(): Accent {
  const current = document.documentElement.dataset.accent;
  return isAccent(current) ? current : 'blue';
}

function apply(preference: Appearance, accent: Accent): void {
  const root = document.documentElement;
  root.dataset.appearancePreference = preference;
  root.dataset.appearance = resolveAppearance(preference);
  root.dataset.accent = accent;
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));
}

export function setAppearance(preference: Appearance): void {
  store(APPEARANCE_KEY, preference);
  apply(preference, getAccent());
}

export function setAccent(accent: Accent): void {
  store(ACCENT_KEY, accent);
  apply(getAppearance(), accent);
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
    if (getAppearance() === 'auto') apply('auto', getAccent());
  };
  query.addEventListener('change', onChange);
  return () => query?.removeEventListener('change', onChange);
}
