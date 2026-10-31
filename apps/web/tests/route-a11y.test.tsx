// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { App } from '../src/App';
import { AuthProvider } from '../src/auth';
import { setLocalePreference } from '../src/i18n';
import { resetRouteFocusForTests } from '../src/hooks/useRouteFocus';

vi.mock('@xterm/xterm', () => ({ Terminal: class {
  // ConsolePanel 创建终端前会写 xterm 的全局读屏文案，模拟类必须带这个静态对象。
  static strings = { promptLabel: '', tooMuchOutput: '' };
  // 切换读屏模式时会写 options.screenReaderMode。
  options = { screenReaderMode: false };
  loadAddon() {} open() {} dispose() {} clear() {} selectAll() {} write() {} writeln() {} reset() {}
  getSelection() { return ''; }
  clearSelection() {}
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));

const instance = { id: 'test', name: 'Survival', coreType: 'custom', status: 'stopped', jarFile: 'server.jar', jvmArgs: '-Xmx2G', nodeId: 'local' };
let signedIn: boolean;

function Location() { return <span data-testid="location">{useLocation().pathname}</span>; }
// 参数配置、实例设置页用到 useBlocker，需要数据路由；这里只走不依赖它的页面。
function mountApp(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider><App /></AuthProvider>
      <Location />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  // 本组按英文文案断言，语言切换在用例内显式触发。
  document.documentElement.lang = 'en'; document.documentElement.dataset.localePreference = 'en';
  document.title = 'Mystry Dashboard';
  resetRouteFocusForTests();
  signedIn = true;
  localStorage.setItem('mystry_token', 'test-only');
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/auth/me' && !signedIn) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    const data = url === '/api/auth/status' ? { needsSetup: false }
      : url === '/api/auth/me' ? { user: { id: 'tester', username: 'tester' } }
      : url === '/api/instances' ? [instance]
      : url === '/api/instances/test' ? instance
      : url === '/api/tasks' ? { tasks: [] }
      : url === '/api/nodes' ? []
      : String(url).startsWith('/api/instances/test/files') ? []
      : url === '/api/instances/test/backups' ? { backups: [] }
      : String(url).includes('/import/sources') ? { sources: [] }
      : String(url).includes('java-runtimes') ? { runtimes: [], defaultRuntime: null }
      : {};
    return new Response(JSON.stringify(data));
  }));
  vi.stubGlobal('WebSocket', class { close() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test('浏览器标签标题随路由变化，切换语言后同步更新', async () => {
  const user = userEvent.setup();
  mountApp('/');
  await screen.findByRole('heading', { level: 1, name: 'Instances' });
  await waitFor(() => expect(document.title).toBe('Instances · Mystry Dashboard'));

  await user.click(document.querySelector<HTMLAnchorElement>('.sidebar a[href="/deploy"]')!);
  await waitFor(() => expect(document.title).toBe('Quick Deploy · Mystry Dashboard'));

  act(() => setLocalePreference('zh-CN'));
  expect(document.title).toBe('一键部署 · Mystry Dashboard');
  await user.click(document.querySelector<HTMLAnchorElement>('.sidebar a[href="/nodes"]')!);
  await waitFor(() => expect(document.title).toBe('本机环境 · Mystry Dashboard'));

  act(() => setLocalePreference('zh-TW'));
  expect(document.title).toBe('本機環境 · Mystry Dashboard');
  act(() => setLocalePreference('en'));
  await user.click(document.querySelector<HTMLAnchorElement>('.sidebar a[href="/import"]')!);
  await waitFor(() => expect(document.title).toBe('Import Server · Mystry Dashboard'));
});

test('实例页标题带标签名和实例名，切换标签和语言后更新', async () => {
  const user = userEvent.setup();
  mountApp('/instances/test');
  await screen.findByRole('heading', { level: 1, name: 'Survival' });
  await waitFor(() => expect(document.title).toBe('Console · Survival · Mystry Dashboard'));

  await user.click(screen.getByRole('link', { name: 'Files' }));
  await waitFor(() => expect(document.title).toBe('Files · Survival · Mystry Dashboard'));
  await user.click(screen.getByRole('link', { name: 'Backups' }));
  await waitFor(() => expect(document.title).toBe('Backups · Survival · Mystry Dashboard'));

  act(() => setLocalePreference('zh-CN'));
  expect(document.title).toBe('备份 · Survival · Mystry Dashboard');
  act(() => setLocalePreference('en'));

  await user.click(screen.getAllByRole('link', { name: 'Instances' })[0]!);
  await waitFor(() => expect(document.title).toBe('Instances · Mystry Dashboard'));
});

test('未登录时显示登录页标题', async () => {
  signedIn = false;
  localStorage.clear();
  mountApp('/deploy');
  await screen.findByRole('heading', { level: 1, name: 'Sign In' });
  expect(screen.getByTestId('location').textContent).toBe('/login');
  await waitFor(() => expect(document.title).toBe('Sign In · Mystry Dashboard'));
});

test('首屏加载不抢焦点；导航后焦点落到新页面 h1；实例内切换标签焦点留在标签上', async () => {
  const user = userEvent.setup();
  mountApp('/');
  await screen.findByRole('heading', { level: 1, name: 'Instances' });
  expect(document.activeElement).toBe(document.body);

  await user.click(document.querySelector<HTMLAnchorElement>('.sidebar a[href="/deploy"]')!);
  const deployHeading = await screen.findByRole('heading', { level: 1, name: 'Quick Deploy' });
  await waitFor(() => expect(document.activeElement).toBe(deployHeading));
  // 标题只能被脚本聚焦，不进入 Tab 顺序。
  expect(deployHeading.getAttribute('tabindex')).toBe('-1');

  await user.click(document.querySelector<HTMLAnchorElement>('.sidebar a[href="/"]')!);
  const instanceLink = await screen.findByRole('link', { name: /Survival/ });
  await waitFor(() => expect(document.activeElement?.textContent).toBe('Instances'));

  await user.click(instanceLink);
  const instanceHeading = await screen.findByRole('heading', { level: 1, name: 'Survival' });
  await waitFor(() => expect(document.activeElement).toBe(instanceHeading));

  const backupsTab = screen.getByRole('link', { name: 'Backups' });
  await user.click(backupsTab);
  expect(screen.getByTestId('location').textContent).toBe('/instances/test/backups');
  await screen.findByRole('button', { name: /Back Up Now/ });
  expect(document.activeElement).toBe(backupsTab);
});

test('未知实例子路由重定向到控制台，而不是空白', async () => {
  mountApp('/instances/test/console');
  await screen.findByRole('heading', { level: 1, name: 'Survival' });
  await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/instances/test'));
  expect(screen.getByRole('link', { name: 'Console' }).className).toContain('active');
  await waitFor(() => expect(document.title).toBe('Console · Survival · Mystry Dashboard'));
});

test('未知顶层路由重定向到总览', async () => {
  mountApp('/no-such-page');
  await screen.findByRole('heading', { level: 1, name: 'Instances' });
  expect(screen.getByTestId('location').textContent).toBe('/');
  await waitFor(() => expect(document.title).toBe('Instances · Mystry Dashboard'));
});
