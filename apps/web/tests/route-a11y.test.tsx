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
  // ConsolePanel writes xterm's global screen reader strings before creating the terminal, so the mock class must have this static object.
  static strings = { promptLabel: '', tooMuchOutput: '' };
  // Switching screen reader mode writes options.screenReaderMode.
  options = { screenReaderMode: false };
  loadAddon() {} open() {} dispose() {} clear() {} selectAll() {} write() {} writeln() {} reset() {}
  getSelection() { return ''; }
  clearSelection() {}
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));

const instance = { id: 'test', name: 'Survival', coreType: 'custom', status: 'stopped', jarFile: 'server.jar', jvmArgs: '-Xmx2G', nodeId: 'local' };
let signedIn: boolean;

function Location() { return <span data-testid="location">{useLocation().pathname}</span>; }
// The config editor and instance settings pages use useBlocker and need a data router; only pages that do not depend on it are covered here.
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
  // This group asserts on the English text, and language switches are triggered explicitly within the cases.
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
      : String(url).startsWith('/api/stats/overview') ? {
        range: '7d',
        from: '2026-11-19T12:00:00.000Z',
        to: '2026-11-26T12:00:00.000Z',
        bucketSeconds: 3600,
        processMetricsSupported: true,
        buckets: [],
        runs: [],
        host: { osName: 'Windows 11', cpuModel: 'Test CPU', cpuThreads: 8, totalMemoryBytes: 16 * 1024 ** 3, bootedAt: '2026-11-25T12:00:00.000Z' },
        diskBreakdown: { instancesBytes: 0, backupsBytes: 0, backupsOnSameVolume: true },
      }
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

test('the browser tab title changes with the route and updates after a language switch', async () => {
  const user = userEvent.setup();
  mountApp('/');
  await screen.findByRole('heading', { level: 1, name: 'Home' });
  await waitFor(() => expect(document.title).toBe('Home · Mystry Dashboard'));

  await user.click(document.querySelector<HTMLAnchorElement>('.sidebar a[href="/deploy"]')!);
  await waitFor(() => expect(document.title).toBe('Quick Deploy · Mystry Dashboard'));

  act(() => setLocalePreference('zh-CN'));
  expect(document.title).toBe('一键部署 · Mystry Dashboard');
  await user.click(document.querySelector<HTMLAnchorElement>('.sidebar a[href="/instances"]')!);
  await waitFor(() => expect(document.title).toBe('实例 · Mystry Dashboard'));

  act(() => setLocalePreference('zh-TW'));
  expect(document.title).toBe('實例 · Mystry Dashboard');
  act(() => setLocalePreference('en'));
  await user.click(document.querySelector<HTMLAnchorElement>('.sidebar a[href="/import"]')!);
  await waitFor(() => expect(document.title).toBe('Import Server · Mystry Dashboard'));

  // The entry to panel settings is in the user area at the bottom of the sidebar, not in the navigation groups.
  await user.click(document.querySelector<HTMLAnchorElement>('.sidebar-footer a[href="/settings"]')!);
  await waitFor(() => expect(document.title).toBe('Panel Settings · Mystry Dashboard'));
});

test('the instance page title carries the tab name and instance name, and updates after switching tabs and languages', async () => {
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

test('the login page title is shown when not signed in', async () => {
  signedIn = false;
  localStorage.clear();
  mountApp('/deploy');
  await screen.findByRole('heading', { level: 1, name: 'Sign In' });
  expect(screen.getByTestId('location').textContent).toBe('/login');
  await waitFor(() => expect(document.title).toBe('Sign In · Mystry Dashboard'));
});

test('the initial load does not take focus; after navigation focus lands on the new page h1; switching tabs within an instance keeps focus on the tab', async () => {
  const user = userEvent.setup();
  mountApp('/');
  await screen.findByRole('heading', { level: 1, name: 'Home' });
  expect(document.activeElement).toBe(document.body);

  await user.click(document.querySelector<HTMLAnchorElement>('.sidebar a[href="/deploy"]')!);
  const deployHeading = await screen.findByRole('heading', { level: 1, name: 'Quick Deploy' });
  await waitFor(() => expect(document.activeElement).toBe(deployHeading));
  // The heading can only be focused by script and does not enter the Tab order.
  expect(deployHeading.getAttribute('tabindex')).toBe('-1');

  await user.click(document.querySelector<HTMLAnchorElement>('.sidebar a[href="/instances"]')!);
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

test('an unknown instance sub-route redirects to the console instead of a blank page', async () => {
  mountApp('/instances/test/console');
  await screen.findByRole('heading', { level: 1, name: 'Survival' });
  await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/instances/test'));
  expect(screen.getByRole('link', { name: 'Console' }).className).toContain('active');
  await waitFor(() => expect(document.title).toBe('Console · Survival · Mystry Dashboard'));
});

test('an unknown top-level route redirects to the home page', async () => {
  mountApp('/no-such-page');
  await screen.findByRole('heading', { level: 1, name: 'Home' });
  expect(screen.getByTestId('location').textContent).toBe('/');
  await waitFor(() => expect(document.title).toBe('Home · Mystry Dashboard'));
});

test('the old local environment address lands on the home page, where the machine info now lives', async () => {
  mountApp('/nodes');
  await screen.findByRole('heading', { level: 1, name: 'Home' });
  expect(screen.getByTestId('location').textContent).toBe('/');
});

test('collapsing the sidebar keeps accessible names on every nav item including the workspace link and updates on language switch', async () => {
  const user = userEvent.setup();
  mountApp('/instances/test');
  await screen.findByRole('heading', { level: 1, name: 'Survival' });

  const toggle = screen.getByRole('button', { name: 'Collapse Sidebar' });
  expect(toggle.getAttribute('aria-controls')).toBe('app-sidebar');
  expect(toggle.hasAttribute('aria-pressed')).toBe(false);

  await user.click(toggle);
  expect(screen.getByRole('button', { name: 'Expand Sidebar' })).toBe(toggle);
  expect(document.querySelector('.app-shell')?.classList.contains('is-sidebar-collapsed')).toBe(true);

  const sidebar = document.querySelector<HTMLElement>('.sidebar')!;
  const navLinks = [...sidebar.querySelectorAll<HTMLAnchorElement>('.nav-item')];
  const expectedLabels = ['Home', 'Instances', 'Current Workspace', 'Quick Deploy', 'Import Server', 'Multiplayer'];
  expect(navLinks.map((link) => link.getAttribute('data-label'))).toEqual(expectedLabels);
  expect(navLinks.map((link) => link.textContent)).toEqual(expectedLabels);

  act(() => setLocalePreference('zh-CN'));
  expect(screen.getByRole('button', { name: '展开侧栏' })).toBe(toggle);
  expect(sidebar.querySelector('.nav-item.active')?.getAttribute('data-label')).toBe('当前工作台');

  act(() => setLocalePreference('zh-TW'));
  expect(screen.getByRole('button', { name: '展開側欄' })).toBe(toggle);
  expect(sidebar.querySelector('.nav-item.active')?.getAttribute('data-label')).toBe('目前工作台');

  act(() => setLocalePreference('en'));
  await user.click(toggle);
  expect(screen.getByRole('button', { name: 'Collapse Sidebar' })).toBe(toggle);
  expect(document.querySelector('.app-shell')?.classList.contains('is-sidebar-collapsed')).toBe(false);
});
