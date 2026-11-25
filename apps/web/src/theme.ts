/**
 * Appearance management: auto (follow the system) / light / dark. The accent color is fixed to clay orange, written in styles.css, and not chosen by the user.
 * The initial value is written to data attributes on <html> before rendering by the inline script in index.html
 * (including migration of the six themes of the legacy mystry_theme); this module reads it, switches it, follows system changes,
 * and broadcasts an event so pickers in several places stay in sync.
 */
import type { MessageKey } from './i18n';

export const APPEARANCES = ['auto', 'light', 'dark'] as const;
export type Appearance = (typeof APPEARANCES)[number];

/** String keys for the display names of the appearances. */
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
    /* In cases such as private mode, silently degrade to taking effect for this session only */
  }
}

/** The appearance the user chose (possibly "auto"). */
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

/** Follows system light/dark changes under the "auto" appearance; returns a function that removes the listener. */
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
