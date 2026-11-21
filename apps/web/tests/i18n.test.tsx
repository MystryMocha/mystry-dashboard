// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  dateTimeFormat,
  detectLocale,
  formatters,
  getLocale,
  numberFormat,
  type Formatters,
  setLocalePreference,
  t,
  tm,
  translate,
  translatePanelMessage,
  translateRich,
  useI18n,
} from '../src/i18n';
import { LanguageToggle } from '../src/components/LanguageToggle';
import { ApiError } from '../src/api';
import { errorMessage } from '../src/errors';

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

test('Intl 格式化器按语言与选项缓存，useI18n().fmt 引用稳定，切换语言后换新', () => {
  // A new options object with the same content hits the same instance too; different options or language give another instance.
  expect(numberFormat('en', { maximumFractionDigits: 1 })).toBe(numberFormat('en', { maximumFractionDigits: 1 }));
  expect(numberFormat('en', { maximumFractionDigits: 2 })).not.toBe(numberFormat('en', { maximumFractionDigits: 1 }));
  expect(numberFormat('zh-CN')).not.toBe(numberFormat('en'));
  expect(dateTimeFormat('zh-TW', { year: 'numeric' })).toBe(dateTimeFormat('zh-TW', { year: 'numeric' }));
  expect(formatters('en')).toBe(formatters('en'));
  expect(formatters('en')).not.toBe(formatters('zh-CN'));

  const date = '2026-09-08T10:00:00Z';
  const monthDay: Intl.DateTimeFormatOptions = { month: 'long', day: 'numeric', timeZone: 'UTC' };
  const seen: Formatters[] = [];
  function Probe() {
    const { fmt } = useI18n();
    seen.push(fmt);
    return <p>{`${fmt.dateTime(date, monthDay)} | ${fmt.number(1234567.5)}`}</p>;
  }
  const { rerender } = render(<Probe />);
  rerender(<Probe />);
  expect(seen[1]).toBe(seen[0]);
  expect(screen.getByText('September 8 | 1,234,567.5')).toBeTruthy();

  act(() => setLocalePreference('zh-CN'));
  expect(seen.at(-1)).not.toBe(seen[0]);
  expect(seen.at(-1)).toBe(formatters('zh-CN'));
  expect(screen.getByText('9月8日 | 1,234,567.5')).toBeTruthy();

  act(() => setLocalePreference('en'));
  expect(seen.at(-1)).toBe(seen[0]);
  expect(screen.getByText('September 8 | 1,234,567.5')).toBeTruthy();
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

test('服务端消息：按键翻译、嵌套参数、无键时显示服务端原文', () => {
  const nested = {
    key: 'server.tasks.restartCleanupFailed' as const,
    params: { reason: { key: 'server.tasks.stagingMarkerMismatch' as const } },
  };
  expect(translatePanelMessage('zh-CN', nested)).toBe('面板重启，未完成的任务无法恢复；临时目录清理失败：临时目录中的任务标记与任务记录不匹配，已跳过自动清理');
  expect(translatePanelMessage('en', nested)).toMatch(/^The panel restarted .*: The task marker/);
  expect(translatePanelMessage('zh-TW', { key: 'server.tasks.timeout' })).toBe('任務執行逾時');
  // Old tasks have no key: the Chinese stored in the database is shown as is
  expect(translatePanelMessage('en', undefined, '下载失败')).toBe('下载失败');

  document.documentElement.lang = 'zh-CN';
  expect(tm({ key: 'server.common.unauthorized' })).toBe('登录已失效，请重新登录');
  const apiError = new ApiError(401, 'Your session has expired. Sign in again.', { key: 'server.common.unauthorized' });
  expect(errorMessage(apiError)).toBe('登录已失效，请重新登录');
  expect(errorMessage(new ApiError(500, 'ENOSPC: no space left on device'))).toBe('ENOSPC: no space left on device');
  document.documentElement.lang = 'en';
  expect(errorMessage(apiError)).toBe('Your session has expired. Sign in again.');
});
