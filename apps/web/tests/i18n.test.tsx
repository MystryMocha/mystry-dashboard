// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  detectLocale,
  formatters,
  getLocale,
  setLocalePreference,
  t,
  translate,
  translateRich,
  useI18n,
} from '../src/i18n';
import { LanguageToggle } from '../src/components/LanguageToggle';

type Table = Record<string, string>;
const enFiles = import.meta.glob<{ default: Table }>('../src/i18n/en/*.ts', { eager: true });
const localeFiles = {
  'zh-CN': import.meta.glob<{ default: Table }>('../src/i18n/zh-CN/*.ts', { eager: true }),
  'zh-TW': import.meta.glob<{ default: Table }>('../src/i18n/zh-TW/*.ts', { eager: true }),
};
const area = (path: string) => path.split('/').pop()!;

beforeEach(() => {
  localStorage.clear();
  document.documentElement.lang = 'en';
  document.documentElement.dataset.localePreference = 'auto';
});
afterEach(cleanup);

test('浏览器语言检测：繁体用 zh-TW，其他 zh* 用 zh-CN，en* 或无法匹配用英文，按列表顺序取第一个命中', () => {
  expect(detectLocale(['zh-TW'])).toBe('zh-TW');
  expect(detectLocale(['zh-HK'])).toBe('zh-TW');
  expect(detectLocale(['zh-Hant'])).toBe('zh-TW');
  expect(detectLocale(['zh-Hans-HK'])).toBe('zh-CN');
  expect(detectLocale(['zh'])).toBe('zh-CN');
  expect(detectLocale(['zh-SG'])).toBe('zh-CN');
  expect(detectLocale(['zh-Hans-CN', 'en-US'])).toBe('zh-CN');
  expect(detectLocale(['en-GB', 'zh-CN'])).toBe('en');
  expect(detectLocale(['fr-FR', 'de'])).toBe('en');
  expect(detectLocale(['fr-FR', 'zh-CN'])).toBe('zh-CN');
  expect(detectLocale([])).toBe('en');
});

test('文案表：每个区域 en 与 zh-CN、zh-TW 键一致，区域之间不重名', () => {
  const seen = new Map<string, string>();
  for (const [path, mod] of Object.entries(enFiles)) {
    if (area(path) === 'index.ts') continue;
    for (const [locale, files] of Object.entries(localeFiles)) {
      const table = Object.entries(files).find(([other]) => area(other) === area(path))?.[1];
      expect(table, `缺少 ${locale}/${area(path)}`).toBeDefined();
      expect(Object.keys(table!.default).sort()).toEqual(Object.keys(mod.default).sort());
    }
    for (const key of Object.keys(mod.default)) {
      expect(seen.get(key), `键 ${key} 在 ${seen.get(key)} 与 ${area(path)} 中重复`).toBeUndefined();
      seen.set(key, area(path));
      expect(mod.default[key]!.trim(), `en 键 ${key} 为空`).not.toBe('');
    }
  }
});

test('插值、缺参保留占位、富文本标签', () => {
  expect(translate('en', 'language.button', { language: 'English' })).toBe('Language settings, currently English');
  expect(translate('zh-CN', 'language.button', {})).toBe('语言设置，当前为{language}');
  const { container } = render(<p>{translateRich('en', 'language.auto.hint', { b: (chunk) => <b>{chunk}</b> }, { language: '<b>English</b>' })}</p>);
  expect(container.querySelector('b')?.textContent).toBe('English');
});

test('Intl 格式化随语言变化，数字与单位之间留空格', () => {
  expect(formatters('en').fileSize(1536)).toBe('1.5 KB');
  expect(formatters('en').fileSize(512)).toBe('512 B');
  expect(formatters('en').number(12345)).toBe('12,345');
  expect(formatters('en').percent(24.5)).toBe('24.5%');
  expect(formatters('zh-CN').dateTime('invalid')).toBe('');
  expect(formatters('en').dateTime('2026-09-08T10:00:00Z', { year: 'numeric', timeZone: 'UTC' })).toBe('2026');
});

test('切换语言写入 <html lang> 与本机存储，模块级 t() 与组件同时更新', async () => {
  function Title() {
    const { t: tr } = useI18n();
    return <h1>{tr('nav.overview')}</h1>;
  }
  render(<><Title /><LanguageToggle /></>);
  expect(screen.getByRole('heading').textContent).toBe('Instances');

  await userEvent.click(screen.getByRole('button', { name: /Language settings/ }));
  await userEvent.click(screen.getByLabelText('简体中文'));
  expect(document.documentElement.lang).toBe('zh-CN');
  expect(localStorage.getItem('mystry_locale')).toBe('zh-CN');
  expect(screen.getByRole('heading').textContent).toBe('实例总览');
  expect(t('action.forceStop')).toBe('强制停止');
  expect(screen.getByRole('button', { name: '语言设置，当前为简体中文' })).toBeTruthy();

  act(() => setLocalePreference('zh-TW'));
  expect(document.documentElement.lang).toBe('zh-TW');
  expect(screen.getByRole('heading').textContent).toBe('實例總覽');
  expect(t('instance.status.crashed')).toBe('已當機');

  act(() => setLocalePreference('en'));
  expect(getLocale()).toBe('en');
  expect(screen.getByRole('heading').textContent).toBe('Instances');
});
