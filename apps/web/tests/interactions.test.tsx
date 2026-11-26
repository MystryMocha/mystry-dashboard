// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, MemoryRouter, RouterProvider, useLocation } from 'react-router-dom';
import { useState } from 'react';
import { DashboardPage } from '../src/pages/DashboardPage';
import { JavaRuntimeSelect } from '../src/components/JavaRuntimeSelect';
import { DeployPage } from '../src/pages/DeployPage';
import { ImportPage } from '../src/pages/ImportPage';
import { NodesPage } from '../src/pages/NodesPage';
import { SettingsPage } from '../src/pages/SettingsPage';
import { InstancePage } from '../src/pages/InstancePage';
import { MultiplayerPage } from '../src/pages/MultiplayerPage';
import { TaskCenter } from '../src/components/TaskCenter';
import { ConsolePanel } from '../src/components/ConsolePanel';
import { BackupsTab } from '../src/components/BackupsTab';
import { BackupScheduleSection } from '../src/components/BackupScheduleSection';
import { FilesTab } from '../src/components/FilesTab';
import { ConfigTab } from '../src/components/ConfigTab';
import { WhitelistNotice } from '../src/components/WhitelistNotice';
import { ChangePasswordDialog } from '../src/components/ChangePasswordDialog';
import { RemoteAccessDialog } from '../src/components/RemoteAccessDialog';
import { qrMatrix } from '../src/components/QrCode';
import { copyText } from '../src/clipboard';
import { api, getToken } from '../src/api';
import { App } from '../src/App';
import { AuthProvider } from '../src/auth';
import { Terminal } from '@xterm/xterm';

const terminal = vi.hoisted(() => ({ text: '', written: '', clearSelection: vi.fn(), created: [] as boolean[], srChanges: [] as boolean[], current: null as null | { options: { screenReaderMode: boolean } } }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  static strings = { promptLabel: '', tooMuchOutput: '' };
  options: { screenReaderMode: boolean };
  constructor(options: { screenReaderMode?: boolean } = {}) {
    // Same as xterm: the screen reader layer is rebuilt only when the value really changes, and each change is recorded here.
    let screenReaderMode = Boolean(options.screenReaderMode);
    this.options = {
      get screenReaderMode() { return screenReaderMode; },
      set screenReaderMode(value: boolean) { if (value !== screenReaderMode) { screenReaderMode = value; terminal.srChanges.push(value); } },
    };
    terminal.created.push(screenReaderMode);
    terminal.current = this;
  }
  loadAddon() {} open() {} dispose() {} clear() {} selectAll() {}
  write(data: string, callback?: () => void) { terminal.written += data; callback?.(); }
  writeln(data: string) { terminal.written += `${data}\n`; }
  reset() { terminal.written = ''; }
  getSelection() { return terminal.text; }
  clearSelection = terminal.clearSelection;
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));

function Location() { return <span data-testid="location">{useLocation().pathname}</span>; }
function mount(element: React.ReactNode) {
  return render(<MemoryRouter>{element}<Location /></MemoryRouter>);
}
const instance = { id: 'test', name: '很长的测试实例'.repeat(12), coreType: 'custom', status: 'stopped', jarFile: 'server.jar', jvmArgs: '-Xmx2G', nodeId: 'local' };
const metricSample = { sampledAt: '2026-09-08T10:00:00Z', cpuPercent: 24, memory: { usedBytes: 8 * 1024 ** 3, totalBytes: 32 * 1024 ** 3 }, disk: { availableBytes: 186 * 1024 ** 3, totalBytes: 512 * 1024 ** 3 }, instances: { test: { cpuPercent: 8.2, memoryBytes: 2.4 * 1024 ** 3, state: 'ready' } }, warnings: [] };
let requests: string[];
let nodes: unknown[];
let failNodes: boolean;
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  // This regression group looks up elements by the Chinese text, with the UI language fixed to zh-CN; for language switching and English text see i18n.test.tsx.
  document.documentElement.lang = 'zh-CN'; document.documentElement.dataset.localePreference = 'zh-CN';
  requests = []; nodes = []; failNodes = false; terminal.text = ''; terminal.written = ''; terminal.created = []; terminal.srChanges = []; terminal.current = null;
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} });
  // jsdom does not implement the native modal layer; this stub only verifies open state and the app's focus restoration logic.
  HTMLDialogElement.prototype.showModal = function () { this.open = true; this.querySelector<HTMLElement>('button')?.focus(); };
  HTMLDialogElement.prototype.close = function () { if (!this.open) return; this.open = false; this.dispatchEvent(new Event('close')); };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    requests.push(String(url));
    if (url === '/api/nodes' && failNodes) return new Response(JSON.stringify({ error: '测试网络失败' }), { status: 503 });
    const data = url === '/api/auth/status' ? { needsSetup: false }
      : url === '/api/auth/me' ? { user: { id: 'tester', username: '测试员' } }
      : url === '/api/instances' ? [instance]
      : url === '/api/system/metrics' ? metricSample
      : url === '/api/tasks' ? { tasks: [{ id: 'task', type: 'import', status: 'running', progress: 30, createdAt: new Date().toISOString() }] }
      : url === '/api/nodes' ? nodes
      : url === '/api/system/download-source' ? { source: 'official' }
      : url === '/api/auth/session-duration' ? { duration: '12h' }
      : url === '/api/system/panel-info' ? { host: '127.0.0.1', port: 3000, dataDir: '/srv/mystry/data', backupDir: '/srv/mystry/data/backups', configPath: '/srv/mystry/config/panel.env' }
      : String(url).includes('/import/sources') ? { sources: [] }
      : String(url).includes('java-runtimes') ? { runtimes: [], defaultRuntime: null }
      : {};
    return new Response(JSON.stringify(data));
  }));
  vi.stubGlobal('WebSocket', class { close() {} });
});

test('overview monitoring keeps stale data, recovers on retry, and the abnormal filter can be cleared', async () => {
  const baseFetch = globalThis.fetch;
  let fail = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/system/metrics' && fail) return new Response('{}', { status: 503 });
    if (url === '/api/instances') return new Response(JSON.stringify([{ ...instance, status: 'running' }]));
    return baseFetch(url, options);
  }));
  const user = userEvent.setup();
  mount(<DashboardPage />);
  expect(await screen.findByText('24.0%')).toBeTruthy();
  expect(await screen.findByText('2.4 GiB')).toBeTruthy();
  fail = true;
  await user.click(screen.getByRole('button', { name: '刷新', exact: true }));
  // The visible status line and the screen reader live region each have a copy of the error text.
  expect(await screen.findAllByText(/数据可能过期/)).toHaveLength(2);
  expect(screen.getByText('2.4 GiB（过期）')).toBeTruthy();
  fail = false;
  await user.click(screen.getByRole('button', { name: '重试监测' }));
  await waitFor(() => expect(screen.queryByText(/数据可能过期/)).toBeNull());
  const issues = screen.getByRole('button', { name: '异常 0' });
  await user.click(issues);
  expect(issues.getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByText('暂无异常实例。')).toBeTruthy();
  expect(screen.queryByRole('link', { name: instance.name })).toBeNull();
  await user.click(screen.getByRole('button', { name: '全部 1' }));
  expect(screen.getByRole('link', { name: instance.name })).toBeTruthy();
});

test('each overview row gives a status note and next step, and only the three ways to add remain when there are no instances', async () => {
  const baseFetch = globalThis.fetch;
  let list: unknown[] = [
    { ...instance, id: 'ready', name: '生存服', status: 'running', ready: true },
    { ...instance, id: 'java', name: '模组服', status: 'crashed', startIssue: { kind: 'java-too-old', requiredJava: 21 } },
    { ...instance, id: 'eula', name: '新服', status: 'stopped', startIssue: { kind: 'eula', requiredJava: null } },
  ];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/instances' && !options?.method) return new Response(JSON.stringify(list));
    return baseFetch(url, options);
  }));
  const user = userEvent.setup();
  const view = mount(<DashboardPage />);
  expect(await screen.findByText('这个服务器需要 Java 21')).toBeTruthy();
  // The Running status already says players can join, so a ready row has no sentence of its own.
  expect(screen.queryByText('可以进服了')).toBeNull();
  expect(screen.getByRole('link', { name: '邀请玩家' }).getAttribute('href')).toBe('/multiplayer?instance=ready');
  expect(screen.getByRole('link', { name: '打开实例设置' }).getAttribute('href')).toBe('/instances/java/settings');
  expect(screen.getByRole('link', { name: '查看并同意' }).getAttribute('href')).toBe('/instances/eula');
  // An instance that stopped because the EULA was not accepted also counts as abnormal.
  await user.click(screen.getByRole('button', { name: '异常 2' }));
  expect(screen.queryByRole('link', { name: '生存服' })).toBeNull();
  expect(screen.getByRole('link', { name: '新服' })).toBeTruthy();
  view.unmount();

  list = [];
  mount(<DashboardPage />);
  expect(await screen.findByText('选一种方式添加第一个服务器。')).toBeTruthy();
  expect(screen.queryByRole('group', { name: '筛选实例' })).toBeNull();
  const paths = within(document.querySelector('.start-path-list') as HTMLElement);
  expect(paths.getByRole('link', { name: /一键部署/ }).getAttribute('href')).toBe('/deploy');
  expect(paths.getByRole('link', { name: /导入服务端/ }).getAttribute('href')).toBe('/import');
  // The top no longer repeats a set of create buttons.
  expect(screen.getAllByRole('link', { name: /一键部署/ })).toHaveLength(1);
  await user.click(paths.getByRole('button', { name: /创建空实例/ }));
  expect(screen.getByRole('dialog', { name: '创建空实例' })).toBeTruthy();
});

test('monitoring pauses on a hidden page, refreshes on returning to the foreground, and stops requesting after unmount', async () => {
  vi.useFakeTimers();
  let hidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  const view = mount(<DashboardPage />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const count = () => requests.filter(url => url === '/api/system/metrics').length;
  expect(count()).toBe(1);
  hidden = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(count()).toBe(1);
  hidden = false;
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(0); });
  expect(count()).toBe(2);
  view.unmount();
  await vi.advanceTimersByTimeAsync(10000);
  expect(count()).toBe(2);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test('the navigation menu disables the main content and the right side of the top bar, and Escape releases them and restores focus to the entry', async () => {
  const user = userEvent.setup();
  localStorage.setItem('mystry_token', 'test-only');
  mount(<AuthProvider><App /></AuthProvider>);
  const trigger = await screen.findByRole('button', { name: '打开导航菜单' });
  await user.click(trigger);
  expect(document.querySelector('.topbar')?.hasAttribute('inert')).toBe(false);
  expect(document.querySelector('.topbar-right')?.hasAttribute('inert')).toBe(true);
  expect(document.querySelector('main')?.hasAttribute('inert')).toBe(true);
  expect(screen.getByRole('button', { name: '关闭导航菜单' })).toBe(trigger);
  expect(document.querySelector('.sidebar')?.contains(document.activeElement)).toBe(true);
  await user.keyboard('{Escape}');
  expect(document.querySelector('.topbar')?.hasAttribute('inert')).toBe(false);
  expect(document.querySelector('.topbar-right')?.hasAttribute('inert')).toBe(false);
  expect(document.querySelector('main')?.hasAttribute('inert')).toBe(false);
  expect(document.activeElement).toBe(trigger);
});

test('the navigation menu close button is clickable, and clicking it closes the menu and restores focus to the entry', async () => {
  const user = userEvent.setup();
  localStorage.setItem('mystry_token', 'test-only');
  mount(<AuthProvider><App /></AuthProvider>);
  const trigger = await screen.findByRole('button', { name: '打开导航菜单' });
  await user.click(trigger);
  const closer = screen.getByRole('button', { name: '关闭导航菜单' });
  expect(closer.closest('[inert]')).toBeNull();
  await user.click(closer);
  expect(document.querySelector('.sidebar-open')).toBeNull();
  expect(document.querySelector('main')?.hasAttribute('inert')).toBe(false);
  expect(document.activeElement).toBe(trigger);
});

test('clicking a navigation item with the menu open navigates and closes the menu', async () => {
  const user = userEvent.setup();
  localStorage.setItem('mystry_token', 'test-only');
  mount(<AuthProvider><App /></AuthProvider>);
  const trigger = await screen.findByRole('button', { name: '打开导航菜单' });
  await user.click(trigger);
  const sidebarDeploy = document.querySelector<HTMLAnchorElement>('.sidebar a.nav-item[href="/deploy"]');
  expect(sidebarDeploy).toBeTruthy();
  await user.click(sidebarDeploy!);
  expect(screen.getByTestId('location').textContent).toBe('/deploy');
  expect(document.querySelector('.sidebar-open')).toBeNull();
  expect(document.querySelector('main')?.hasAttribute('inert')).toBe(false);
});

test('desktop sidebar collapse toggles the icon rail, keeps tooltip labels and persists across remounts', async () => {
  const user = userEvent.setup();
  localStorage.setItem('mystry_token', 'test-only');
  const first = mount(<AuthProvider><App /></AuthProvider>);
  const collapse = await screen.findByRole('button', { name: '收起侧栏' });
  expect(collapse.getAttribute('aria-controls')).toBe('app-sidebar');
  expect(collapse.hasAttribute('aria-pressed')).toBe(false);
  expect(collapse.getAttribute('title')).toBe('收起侧栏');
  expect(document.querySelector('.app-shell')?.classList.contains('is-sidebar-collapsed')).toBe(false);
  expect(document.querySelector('.sidebar a.nav-item[href="/"]')?.getAttribute('data-label')).toBe('实例总览');
  expect(document.querySelector('.sidebar a.nav-item[href="/deploy"]')?.getAttribute('data-label')).toBe('一键部署');

  await user.click(collapse);
  expect(document.querySelector('.app-shell')?.classList.contains('is-sidebar-collapsed')).toBe(true);
  expect(screen.getByRole('button', { name: '展开侧栏' })).toBe(collapse);
  expect(collapse.getAttribute('title')).toBe('展开侧栏');
  expect(localStorage.getItem('mystry_sidebar_collapsed')).toBe('1');

  await user.click(document.querySelector<HTMLAnchorElement>('.sidebar a.nav-item[href="/deploy"]')!);
  expect(screen.getByTestId('location').textContent).toBe('/deploy');
  expect(document.querySelector('.app-shell')?.classList.contains('is-sidebar-collapsed')).toBe(true);
  first.unmount();

  const second = mount(<AuthProvider><App /></AuthProvider>);
  const expand = await screen.findByRole('button', { name: '展开侧栏' });
  expect(document.querySelector('.app-shell')?.classList.contains('is-sidebar-collapsed')).toBe(true);

  await user.click(expand);
  expect(document.querySelector('.app-shell')?.classList.contains('is-sidebar-collapsed')).toBe(false);
  expect(screen.getByRole('button', { name: '收起侧栏' })).toBe(expand);
  expect(localStorage.getItem('mystry_sidebar_collapsed')).toBe('0');

  const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  await user.click(expand);
  expect(document.querySelector('.app-shell')?.classList.contains('is-sidebar-collapsed')).toBe(true);
  setItem.mockRestore();
  second.unmount();
});

test('Enter on an instance action button only performs the action, and the name link can still navigate', async () => {
  const user = userEvent.setup();
  mount(<DashboardPage />);
  const start = await screen.findByRole('button', { name: '启动', exact: true });
  start.focus(); await user.keyboard('{Enter}');
  await waitFor(() => expect(requests).toContain('/api/instances/test/start'));
  expect(screen.getByTestId('location').textContent).toBe('/');
  await user.click(screen.getByRole('link', { name: instance.name }));
  expect(screen.getByTestId('location').textContent).toBe('/instances/test');
});

test('the more-actions menu is attached to body, arrow keys move, Escape restores focus, and selecting opens the confirmation dialog', async () => {
  const user = userEvent.setup();
  mount(<DashboardPage />);
  const trigger = await screen.findByRole('button', { name: '更多操作' });
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  await user.click(trigger);
  const menu = screen.getByRole('menu', { name: '更多操作' });
  expect(menu.parentElement).toBe(document.body);
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  const restart = screen.getByRole('menuitem', { name: '重启实例' });
  const forceStop = screen.getByRole('menuitem', { name: '强制停止' }) as HTMLButtonElement;
  const remove = screen.getByRole('menuitem', { name: '删除实例' });
  expect(forceStop.disabled).toBe(true);
  await waitFor(() => expect(document.activeElement).toBe(restart));
  await user.keyboard('{ArrowDown}');
  expect(document.activeElement).toBe(remove);
  await user.keyboard('{ArrowDown}');
  expect(document.activeElement).toBe(restart);
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  await user.click(trigger);
  await user.click(document.body);
  expect(screen.queryByRole('menu')).toBeNull();
  await user.click(trigger);
  await user.click(screen.getByRole('menuitem', { name: '删除实例' }));
  expect(screen.queryByRole('menu')).toBeNull();
  expect(screen.getByRole('dialog', { name: /^删除实例「/ })).toBeTruthy();
});

test('the task drawer is inaccessible while closed, and closing by button, Escape or backdrop all restore focus to the entry', async () => {
  const user = userEvent.setup();
  mount(<TaskCenter />);
  const trigger = screen.getByRole('button', { name: /打开任务中心/ });
  expect(screen.queryByRole('dialog')).toBeNull();
  for (const reason of ['button', 'cancel', 'backdrop']) {
    await user.click(trigger);
    const dialog = screen.getByRole('dialog');
    expect(dialog.parentElement).toBe(document.body);
    expect((await screen.findByRole('progressbar')).getAttribute('aria-valuenow')).toBe('30');
    if (reason === 'button') await user.click(screen.getByTitle('关闭'));
    if (reason === 'cancel') fireEvent(dialog, new Event('cancel', { cancelable: true }));
    if (reason === 'backdrop') fireEvent.click(dialog, { clientX: -1 });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);
    expect(screen.queryByRole('button', { name: '刷新任务' })).toBeNull();
  }
});

test('the deploy page defaults to Paper and the latest release, the EULA has to be checked by the user, and an empty Build lets the server take the latest', async () => {
  const baseFetch = globalThis.fetch;
  const deployBodies: Array<Record<string, unknown>> = [];
  const java25 = { id: 'rt25', path: 'C:/Java/jdk-25/bin/java.exe', version: '25.0.1', majorVersion: 25, source: 'scan', verifiedAt: '', available: true };
  let javaRuntimes: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (String(url).startsWith('/api/system/java-runtimes')) return new Response(JSON.stringify({ runtimes: javaRuntimes, installable: [] }));
    if (url === '/api/cores/paper/versions') {
      requests.push(url);
      return new Response(JSON.stringify({ versions: ['26.3', '26.2', '1.21.11'] }));
    }
    if (url === '/api/cores/deploy') {
      deployBodies.push(JSON.parse(String(options?.body)));
      return new Response(JSON.stringify({ id: 'deploy-task', type: 'deploy', status: 'pending', progress: 0 }));
    }
    return baseFetch(url, options);
  }));
  const user = userEvent.setup();
  mount(<DeployPage />);
  const version = screen.getByRole('button', { name: /^游戏版本/ });
  await waitFor(() => expect(version.textContent).toContain('26.3'));
  expect(requests.filter((url) => url === '/api/cores/paper/versions')).toHaveLength(1);
  expect(screen.getByRole('button', { name: /^Paper 构建版本（可选）/ }).textContent).toContain('自动使用最新构建');

  const submit = screen.getByRole('button', { name: '开始部署' }) as HTMLButtonElement;
  const eula = screen.getByRole('checkbox', { name: /同意 Minecraft EULA/ }) as HTMLInputElement;
  expect(eula.checked).toBe(false);
  expect(submit.disabled).toBe(true);

  await user.click(eula);
  // 26.3 needs Java 25 and this computer does not have it: deployment cannot start, and the reason is explained.
  expect(await screen.findByRole('button', { name: '先安装或选择 Java 25' })).toBeTruthy();
  expect(submit.disabled).toBe(true);
  // Rescan after installing Java 25: it is selected automatically and the button is enabled.
  javaRuntimes = [java25];
  await user.click(screen.getByRole('button', { name: '重新扫描' }));
  await waitFor(() => expect(submit.disabled).toBe(false));
  expect(screen.queryByText(/先安装或选择 Java 25/)).toBeNull();
  // After acceptance is withdrawn the button is greyed out and the action bar says the EULA must be checked first; checking it again restores it.
  await user.click(eula);
  expect(submit.disabled).toBe(true);
  expect(screen.getByText('勾选同意 Minecraft EULA 后才能部署')).toBeTruthy();
  await user.click(eula);
  await user.click(submit);
  await waitFor(() => expect(deployBodies).toHaveLength(1));
  expect(deployBodies[0]).toMatchObject({ coreType: 'paper', mcVersion: '26.3', acceptEula: true, javaRuntimeId: 'rt25' });
  expect(deployBodies[0]?.build).toBeUndefined();
  expect(deployBodies[0]?.loaderVersion).toBeUndefined();
});

test('the ZIP button can be triggered by keyboard, and choosing and dropping reject non-ZIP files and allow choosing again', async () => {
  const user = userEvent.setup();
  mount(<ImportPage />);
  await user.click(screen.getByRole('button', { name: /ZIP/ }));
  const input = document.querySelector<HTMLInputElement>('#existing-server-zip')!;
  const click = vi.spyOn(input, 'click');
  screen.getByRole('button', { name: '选择 ZIP', exact: true }).focus();
  await user.keyboard('{Enter}'); expect(click).toHaveBeenCalledOnce();
  fireEvent.change(input, { target: { files: [new File(['bad'], 'bad.txt')] } });
  expect(await screen.findByText('请选择 ZIP 格式的服务端压缩包。')).toBeTruthy();
  fireEvent.change(input, { target: { files: [new File(['zip'], 'server.ZIP')] } });
  expect(screen.getByText('server.ZIP')).toBeTruthy();
  const dropZone = screen.getByRole('button', { name: '选择 ZIP', exact: true }).parentElement!;
  fireEvent.drop(dropZone, { dataTransfer: { files: [new File(['bad'], 'drop.txt')] } });
  expect(screen.getByText('请选择 ZIP 格式的服务端压缩包。')).toBeTruthy();
  expect(screen.getByText('server.ZIP')).toBeTruthy();
});

test('ZIP choosing and dropping are locked while a preview is restored and during upload', async () => {
  const user = userEvent.setup();
  sessionStorage.setItem('mystry_import_preview_id', 'restoring');
  const fetchDefault = globalThis.fetch;
  let resolvePreview: (response: Response) => void = () => {};
  vi.stubGlobal('fetch', vi.fn((url, options) => String(url).includes('/import/previews/')
    ? new Promise<Response>((resolve) => { resolvePreview = resolve; }) : fetchDefault(url, options)));
  mount(<ImportPage />);
  await user.click(screen.getByRole('button', { name: /ZIP/ }));
  const button = screen.getByRole('button', { name: '选择 ZIP', exact: true }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.drop(button.parentElement!, { dataTransfer: { files: [new File(['x'], 'locked.zip')] } });
  expect(screen.queryByText('locked.zip')).toBeNull();
  await act(async () => resolvePreview(new Response(JSON.stringify({ error: '预览过期' }), { status: 410 })));
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.change(document.querySelector('#existing-server-zip')!, { target: { files: [new File(['zip'], 'upload.zip')] } });
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  await user.click(screen.getByRole('button', { name: '上传并检查' }));
  expect(button.disabled).toBe(true);
  fireEvent.drop(button.parentElement!, { dataTransfer: { files: [new File(['x'], 'locked.zip')] } });
  expect(screen.queryByText('locked.zip')).toBeNull();
});

test('the nodes page shows the empty state, and after a failure a manual retry recovers the real offline state', async () => {
  const user = userEvent.setup();
  mount(<NodesPage />);
  expect(await screen.findByText('读不到本机信息。')).toBeTruthy();
  failNodes = true;
  await user.click(screen.getByRole('button', { name: '重新读取' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  failNodes = false;
  nodes = [{ id: 'local', isLocal: true, name: '本机', status: 'offline', instanceCount: 0 }];
  await user.click(screen.getByRole('button', { name: '重试加载' }));
  expect(await screen.findByText('离线')).toBeTruthy();
  expect(screen.queryByText(/健康运转中/)).toBeNull();
});

test('panel settings page switching the download source: the original choice is kept on failure, and the description is shown on success', async () => {
  const user = userEvent.setup();
  const baseFetch = globalThis.fetch;
  const saved: string[] = [];
  let failSave = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/system/download-source' && options?.method === 'PUT') {
      saved.push(String(options.body));
      return failSave
        ? new Response(JSON.stringify({ error: '保存失败' }), { status: 500 })
        : new Response(String(options.body));
    }
    return baseFetch(url, options);
  }));
  mount(<AuthProvider><SettingsPage /></AuthProvider>);
  const official = await screen.findByRole('button', { name: '官方来源', pressed: true });
  const china = screen.getByRole('button', { name: '国内镜像', pressed: false });
  await user.click(china);
  expect((await screen.findByRole('alert')).textContent).toContain('保存失败');
  expect(official.getAttribute('aria-pressed')).toBe('true');
  failSave = false;
  await user.click(china);
  expect(await screen.findByText('已保存，之后的下载使用这个来源。')).toBeTruthy();
  expect(china.getAttribute('aria-pressed')).toBe('true');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText(/Paper 和 Fabric 的服务端文件没有可靠的镜像/)).toBeTruthy();
  expect(saved.at(-1)).toBe('{"source":"china"}');
});

test('panel settings page changing the session duration: the new token is swapped in after saving, "never expire" shows a risk note, and the original choice is kept on failure', async () => {
  const user = userEvent.setup();
  const baseFetch = globalThis.fetch;
  const saved: string[] = [];
  let failSave = true;
  localStorage.setItem('mystry_token', 'old-token');
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/auth/session-duration' && options?.method === 'PUT') {
      saved.push(String(options.body));
      return failSave
        ? new Response(JSON.stringify({ error: 'Choose one of the listed sign-in durations.', code: 'server.auth.sessionDurationInvalid' }), { status: 400 })
        : new Response(JSON.stringify({ duration: 'never', token: 'new-token' }));
    }
    return baseFetch(url, options);
  }));
  mount(<AuthProvider><SettingsPage /></AuthProvider>);
  const select = await screen.findByRole('combobox', { name: '登录有效期' }) as HTMLSelectElement;
  await waitFor(() => expect(select.value).toBe('12h'));
  expect(screen.getByRole('option', { name: '12 小时（默认）' })).toBeTruthy();
  expect(screen.queryByText(/直到修改密码/)).toBeNull();

  await user.selectOptions(select, 'never');
  expect((await screen.findByRole('alert')).textContent).toBe('请从列出的选项中选择登录有效期');
  expect(select.value).toBe('12h');
  expect(localStorage.getItem('mystry_token')).toBe('old-token');

  failSave = false;
  await user.selectOptions(select, 'never');
  expect(await screen.findByText('已保存，这台设备的登录已按新时长计算。')).toBeTruthy();
  expect(select.value).toBe('never');
  expect(screen.getByText(/直到修改密码/)).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(localStorage.getItem('mystry_token')).toBe('new-token');
  expect(saved.at(-1)).toBe('{"duration":"never"}');
});

test('the sidebar gear opens panel settings: language and appearance apply in place, runtime info is shown, and password change and sign-out are available', async () => {
  const user = userEvent.setup();
  localStorage.setItem('mystry_token', 'test-only');
  mount(<AuthProvider><App /></AuthProvider>);
  const gear = await screen.findByRole('link', { name: '面板设置' });
  expect(gear.closest('.sidebar-footer')).toBeTruthy();
  // Change password no longer takes up an icon in the user area; it is only on the settings page.
  expect(screen.queryByRole('button', { name: '修改密码' })).toBeNull();
  await user.click(gear);
  expect(await screen.findByRole('heading', { level: 1, name: '面板设置' })).toBeTruthy();
  expect(screen.getByTestId('location').textContent).toBe('/settings');
  expect(gear.getAttribute('aria-current')).toBe('page');
  expect(gear.className).toContain('active');

  // Runtime info is read-only: the listen address, directories and config file come from the API.
  expect(await screen.findByText('127.0.0.1:3000')).toBeTruthy();
  expect(screen.getByText('/srv/mystry/data')).toBeTruthy();
  expect(screen.getByText('/srv/mystry/data/backups')).toBeTruthy();
  expect(screen.getByText('/srv/mystry/config/panel.env')).toBeTruthy();
  expect(screen.getByText('监听地址和目录在配置文件里设置，改完要重启面板才生效。')).toBeTruthy();

  // Session duration and download source moved to this page.
  expect(await screen.findByRole('combobox', { name: '登录有效期' })).toBeTruthy();
  expect(await screen.findByRole('button', { name: '官方来源', pressed: true })).toBeTruthy();

  // Language: switches as soon as chosen, the same setting as the language button in the top bar.
  await user.selectOptions(screen.getByRole('combobox', { name: '语言' }), 'en');
  expect(await screen.findByRole('heading', { level: 1, name: 'Panel Settings' })).toBeTruthy();
  expect(localStorage.getItem('mystry_locale')).toBe('en');
  await user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'zh-CN');
  expect(await screen.findByRole('heading', { level: 1, name: '面板设置' })).toBeTruthy();

  // Appearance: a segmented button, with aria-pressed on the selected item.
  const dark = screen.getByRole('button', { name: '深色' });
  await user.click(dark);
  expect(dark.getAttribute('aria-pressed')).toBe('true');
  expect(document.documentElement.dataset.appearance).toBe('dark');
  await user.click(screen.getByRole('button', { name: '自动' }));
  expect(document.documentElement.dataset.appearancePreference).toBe('auto');

  // Change password opens from here; after cancelling it returns to the settings page.
  await user.click(screen.getByRole('button', { name: '修改密码' }));
  expect(await screen.findByLabelText('当前密码')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '取消' }));
  await waitFor(() => expect(screen.queryByLabelText('当前密码')).toBeNull());

  // Sign out: one button on the settings page and one icon in the sidebar.
  const account = screen.getByRole('region', { name: '账号' });
  expect(within(account).getByText('测试员')).toBeTruthy();
  await user.click(within(account).getByRole('button', { name: '退出登录' }));
  await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/login'));
  expect(localStorage.getItem('mystry_token')).toBeNull();
});

test('the local environment page no longer holds session duration and download source, and keeps "Open on other devices"', async () => {
  nodes = [{ id: 'local', isLocal: true, name: '本机', status: 'online', instanceCount: 1 }];
  mount(<NodesPage />);
  expect(await screen.findByText('在线')).toBeTruthy();
  expect(screen.getByRole('button', { name: /在其他设备上打开/ })).toBeTruthy();
  expect(screen.queryByRole('combobox', { name: '登录有效期' })).toBeNull();
  expect(screen.queryByRole('button', { name: '官方来源' })).toBeNull();
  expect(requests).not.toContain('/api/auth/session-duration');
  expect(requests).not.toContain('/api/system/download-source');
});

test('the panel settings page explains why when runtime info cannot be read, and the other settings stay usable', async () => {
  const baseFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/system/panel-info') return new Response(JSON.stringify({ error: '测试网络失败' }), { status: 503 });
    return baseFetch(url, options);
  }));
  mount(<AuthProvider><SettingsPage /></AuthProvider>);
  expect((await screen.findByRole('alert')).textContent).toContain('测试网络失败');
  expect(screen.queryByText('监听地址')).toBeNull();
  // The version number comes from the frontend build and does not depend on the API.
  expect(screen.getByText('版本')).toBeTruthy();
  const select = await screen.findByRole('combobox', { name: '登录有效期' }) as HTMLSelectElement;
  await waitFor(() => expect(select.value).toBe('12h'));
});

test('copy log gives feedback for an empty log, denied permission, a missing API and success', async () => {
  const user = userEvent.setup();
  mount(<ConsolePanel instanceId="test" />);
  await user.click(screen.getByRole('button', { name: '复制日志' }));
  expect(screen.getByRole('status').textContent).toContain('暂无可复制');
  terminal.text = '测试日志';
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
  await user.click(screen.getByRole('button', { name: '复制日志' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('请手动选择日志并复制'));
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  await user.click(screen.getByRole('button', { name: '复制日志' }));
  expect(screen.getByRole('status').textContent).toContain('复制失败');
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  await user.click(screen.getByRole('button', { name: '复制日志' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('日志已复制。'));
  expect(writeText).toHaveBeenCalledWith('测试日志');
});

test('after a console reconnect the history snapshot replaces the old log, without duplicated output', async () => {
  const sockets: Array<{ onopen?: () => void; onmessage?: (ev: { data: string }) => void; onclose?: () => void }> = [];
  vi.stubGlobal('WebSocket', class { constructor() { sockets.push(this); } close() {} });
  vi.useFakeTimers();
  mount(<ConsolePanel instanceId="test" />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const history = JSON.stringify({ type: 'history', data: '[10:00:00 INFO]: Done (3.2s)!\n', status: 'running' });
  act(() => { sockets[0].onopen?.(); sockets[0].onmessage?.({ data: history }); });
  expect(terminal.written.match(/Done \(3\.2s\)/g)).toHaveLength(1);
  act(() => sockets[0].onclose?.());
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  act(() => { sockets[1].onopen?.(); sockets[1].onmessage?.({ data: history }); });
  expect(terminal.written.match(/Done \(3\.2s\)/g)).toHaveLength(1);
  expect(terminal.written).toContain('已重新连接');
});

test('a node polling failure keeps the old data and marks it as possibly stale', async () => {
  nodes = [{ id: 'local', isLocal: true, name: '本机', status: 'online', instanceCount: 3 }];
  vi.useFakeTimers();
  mount(<NodesPage />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByText('在线')).toBeTruthy();
  failNodes = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.getByText('3 个服务实例')).toBeTruthy();
  expect(screen.getByText('状态可能已过期')).toBeTruthy();
  expect(screen.queryByText('在线')).toBeNull();
  expect(screen.getByRole('button', { name: '重试加载' })).toBeTruthy();
});

test('the copy notice timer is cleared when the console unmounts', async () => {
  vi.useFakeTimers();
  const view = mount(<ConsolePanel instanceId="test" />);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '复制日志' })));
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test('backups page: restore is disabled while running; the restore dialog backs up the current files first by default, and unchecking it warns that it cannot be undone', async () => {
  const backup = { id: '20261026-010203-abcdef', instanceId: 'test', instanceName: '测试', source: 'manual', createdAt: '2026-10-26T01:02:03.000Z', sizeBytes: 2048, fileCount: 3, contentBytes: 4096, coreType: null, mcVersion: null, wasRunning: false, sha256: 'x' };
  const posted: Array<{ url: string; body: unknown }> = [];
  const baseFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/instances/test/backups' && !options?.method) return new Response(JSON.stringify({ backups: [backup] }));
    if (String(url).endsWith('/restore')) {
      posted.push({ url: String(url), body: JSON.parse(String(options?.body)) });
      return new Response(JSON.stringify({ id: 'restore-task', type: 'restore', status: 'completed', progress: 100, createdAt: backup.createdAt }));
    }
    if (url === '/api/tasks/restore-task') return new Response(JSON.stringify({ id: 'restore-task', type: 'restore', status: 'completed', progress: 100, createdAt: backup.createdAt }));
    return baseFetch(url, options);
  }));
  const user = userEvent.setup();
  const view = mount(<BackupsTab instance={{ ...instance, status: 'running' } as never} onRestored={() => {}} />);
  expect((await screen.findByRole('button', { name: '还原' }) as HTMLButtonElement).disabled).toBe(true);
  view.unmount();

  mount(<BackupsTab instance={instance as never} onRestored={() => {}} />);
  await user.click(await screen.findByRole('button', { name: '还原' }));
  const dialog = screen.getByRole('dialog', { name: '还原这个备份？' });
  const checkbox = screen.getByRole('checkbox', { name: '先备份当前文件' }) as HTMLInputElement;
  expect(checkbox.checked).toBe(true);
  await user.click(checkbox);
  expect(dialog.textContent).toContain('无法撤销');
  await user.click(checkbox);
  await user.click(within(dialog).getByRole('button', { name: '还原', exact: true }));
  await waitFor(() => expect(posted).toEqual([{ url: '/api/instances/test/backups/20261026-010203-abcdef/restore', body: { backupCurrent: true } }]));
  expect(await screen.findByText('备份已还原')).toBeTruthy();
});

test('backups page: a note is shown when the instance record was updated to match the backup after a restore', async () => {
  const backup = { id: '20261026-010203-abcdef', instanceId: 'test', instanceName: '测试', source: 'manual', createdAt: '2026-10-26T01:02:03.000Z', sizeBytes: 2048, fileCount: 3, contentBytes: 4096, coreType: null, mcVersion: null, wasRunning: false, sha256: 'x' };
  const task = { id: 'restore-task', type: 'restore', status: 'completed', progress: 100, createdAt: backup.createdAt, result: { instanceId: 'test', backupId: backup.id, instanceRecordUpdated: true } };
  const baseFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/instances/test/backups' && !options?.method) return new Response(JSON.stringify({ backups: [backup] }));
    if (String(url).endsWith('/restore') || url === '/api/tasks/restore-task') return new Response(JSON.stringify(task));
    return baseFetch(url, options);
  }));
  const onRestored = vi.fn();
  const user = userEvent.setup();
  mount(<BackupsTab instance={instance as never} onRestored={onRestored} />);
  await user.click(await screen.findByRole('button', { name: '还原' }));
  const dialog = screen.getByRole('dialog', { name: '还原这个备份？' });
  await user.click(within(dialog).getByRole('button', { name: '还原', exact: true }));
  expect(await screen.findByText(/服务端文件、核心类型和版本已按备份更新/)).toBeTruthy();
  expect(onRestored).toHaveBeenCalledTimes(1);
});

test('backups page: when a backup task fails, its reason stays on the page after the backup list reloads', async () => {
  const failed = { id: 'backup-task', type: 'backup', status: 'failed', progress: 0, message: '', error: 'x', errorI18n: { key: 'server.backups.saveTimeout', params: { seconds: 60 } }, createdAt: '2026-10-26T01:02:03.000Z' };
  const backup = { id: '20261026-010203-abcdef', instanceId: 'test', instanceName: '测试', source: 'manual', createdAt: '2026-10-26T01:02:03.000Z', sizeBytes: 2048, fileCount: 3, contentBytes: 4096, coreType: null, mcVersion: null, wasRunning: false, sha256: 'x' };
  let listRequests = 0;
  const baseFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/instances/test/backups' && !options?.method) {
      listRequests += 1;
      // The reload after the failure returns a row, so waiting for it proves the reload has rendered.
      return new Response(JSON.stringify({ backups: listRequests > 1 ? [backup] : [] }));
    }
    if (url === '/api/instances/test/backups' && options?.method === 'POST') return new Response(JSON.stringify({ ...failed, status: 'running', error: undefined, errorI18n: undefined }));
    if (url === '/api/tasks/backup-task') return new Response(JSON.stringify(failed));
    return baseFetch(url, options);
  }));
  const user = userEvent.setup();
  mount(<BackupsTab instance={{ ...instance, status: 'running' } as never} onRestored={() => {}} />);
  await user.click(await screen.findByRole('button', { name: '立即备份' }));
  expect(await screen.findByRole('button', { name: /的备份操作$/ })).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toContain('60 秒内没有确认世界已保存');
});

function stubWhitelistFiles(properties: Record<string, string>, whitelist: string | null) {
  const baseFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/instances/test/config/server.properties') return new Response(JSON.stringify(properties));
    if (url === '/api/instances/test/files/content?path=whitelist.json') {
      return whitelist === null
        ? new Response(JSON.stringify({ error: 'File not found', code: 'server.files.fileNotFound' }), { status: 400 })
        : new Response(JSON.stringify({ path: 'whitelist.json', content: whitelist }));
    }
    return baseFetch(url, options);
  }));
}

test('whitelist notice: with the whitelist on and no one on it, both ways out are named and lead to the console and the properties', async () => {
  stubWhitelistFiles({ 'white-list': 'true', 'online-mode': 'true' }, '[]');
  mount(<WhitelistNotice instanceId="test" status="running" linkConsole />);
  const notice = await screen.findByRole('status');
  expect(notice.textContent).toContain('白名单已开启，名单里还没有玩家');
  expect(notice.textContent).toContain('whitelist add 玩家名');
  expect(screen.getByRole('link', { name: '控制台' }).getAttribute('href')).toBe('/instances/test');
  expect(screen.getByRole('link', { name: '参数配置' }).getAttribute('href')).toBe('/instances/test/config');
});

test('whitelist notice: above the console it does not link to the console, and a missing whitelist.json counts as an empty list', async () => {
  stubWhitelistFiles({ 'white-list': 'true' }, null);
  mount(<WhitelistNotice instanceId="test" status="stopped" linkConsole={false} />);
  expect((await screen.findByRole('status')).textContent).toContain('白名单已开启');
  expect(screen.queryByRole('link', { name: '控制台' })).toBeNull();
  expect(screen.getByRole('link', { name: '参数配置' })).toBeTruthy();
});

test('whitelist notice: nothing is shown when the whitelist already lists players, is off, or has not been written yet', async () => {
  const propertiesUrl = '/api/instances/test/config/server.properties';
  const whitelistUrl = '/api/instances/test/files/content?path=whitelist.json';
  // The last request each case makes: the list is read only when the whitelist is on.
  const cases: Array<[Record<string, string>, string | null, string]> = [
    [{ 'white-list': 'true' }, '[{"uuid":"3bdcf18e-f975-3fba-b25b-f59340950037","name":"Steve"}]', whitelistUrl],
    [{ 'white-list': 'false' }, '[]', propertiesUrl],
    [{ 'online-mode': 'true' }, null, propertiesUrl],
  ];
  for (const [properties, whitelist, lastRequest] of cases) {
    const reads: string[] = [];
    stubWhitelistFiles(properties, whitelist);
    const stubbed = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
      reads.push(String(url));
      return stubbed(url, options);
    }));
    const view = mount(<WhitelistNotice instanceId="test" status="running" linkConsole />);
    await waitFor(() => expect(reads).toContain(lastRequest));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(screen.queryByText(/白名单已开启/)).toBeNull();
    if (lastRequest === propertiesUrl) expect(reads).not.toContain(whitelistUrl);
    view.unmount();
  }
});

test('deleting an instance deletes its backups by default, and unchecking sends keepBackups=1 and says where the backups go', async () => {
  const deletes: string[] = [];
  const baseFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'DELETE') {
      deletes.push(String(url));
      return new Response(JSON.stringify({ ok: true }));
    }
    return baseFetch(url, options);
  }));
  const user = userEvent.setup();
  mount(<DashboardPage />);

  async function openDelete() {
    await user.click(await screen.findByRole('button', { name: '更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '删除实例' }));
    await user.type(screen.getByRole('textbox', { name: /请输入/ }), instance.name);
    return screen.getByRole('checkbox', { name: '同时删除该实例的备份' }) as HTMLInputElement;
  }

  const checkbox = await openDelete();
  expect(checkbox.checked).toBe(true);
  await user.click(screen.getByRole('button', { name: '永久删除' }));
  await waitFor(() => expect(deletes).toEqual(['/api/instances/test']));

  await user.click((await openDelete()));
  expect(screen.getByText(/备份会留在面板数据目录的 backups 文件夹中/)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '永久删除' }));
  await waitFor(() => expect(deletes).toEqual(['/api/instances/test', '/api/instances/test?keepBackups=1']));
});

test('deploy page version dropdown: the name is the visible label plus the current value, and the keyboard can select and return to the trigger button', async () => {
  const baseFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/cores/paper/versions') return new Response(JSON.stringify({ versions: ['26.3', '26.2', '1.21.11'] }));
    return baseFetch(url, options);
  }));
  // jsdom does not implement scrollIntoView, which is called when the keyboard moves the active item.
  Element.prototype.scrollIntoView = vi.fn();
  const user = userEvent.setup();
  mount(<DeployPage />);
  const trigger = await screen.findByRole('button', { name: '游戏版本 26.3' });
  expect(trigger.hasAttribute('aria-label')).toBe(false);
  expect(screen.getByRole('button', { name: 'Paper 构建版本（可选） 自动使用最新构建（优先稳定版）' })).toBeTruthy();

  trigger.focus();
  await user.keyboard('{ArrowDown}');
  const listbox = screen.getByRole('listbox', { name: '游戏版本' });
  expect(document.activeElement).toBe(listbox);
  const selected = screen.getByRole('option', { name: '26.3' });
  expect(selected.getAttribute('aria-selected')).toBe('true');
  expect(listbox.getAttribute('aria-activedescendant')).toBe(selected.id);
  expect(selected.tabIndex).toBe(-1);
  await user.keyboard('{ArrowDown}');
  expect(listbox.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: '26.2' }).id);
  await user.keyboard('{Enter}');
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '游戏版本 26.2' }));

  await user.keyboard('{ArrowDown}');
  expect(screen.getByRole('listbox', { name: '游戏版本' })).toBeTruthy();
  await user.keyboard('{Tab}');
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(document.activeElement).not.toBe(trigger);
});

/** jsdom has no real layout: the dropdown panel is simulated with sizes measured on desktop (34px per item, 44px for the hint and padding, a 400px cap). */
function mockLazySelectLayout() {
  const contentHeight = (el: HTMLElement) => el.querySelectorAll('[role="option"]').length * 34 + 44;
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return contentHeight(this);
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return Math.min(contentHeight(this), 400);
  });
}

test('deploy page version dropdown: loading continues when the first screen does not fill the panel, and later versions can be picked with the mouse after scrolling', async () => {
  const versions = Array.from({ length: 45 }, (_, index) => `1.${index}`);
  const baseFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/cores/paper/versions') return new Response(JSON.stringify({ versions }));
    return baseFetch(url, options);
  }));
  Element.prototype.scrollIntoView = vi.fn();
  mockLazySelectLayout();
  const user = userEvent.setup();
  mount(<DeployPage />);

  await user.click(await screen.findByRole('button', { name: '游戏版本 1.0' }));
  const listbox = screen.getByRole('listbox', { name: '游戏版本' });
  // 10 items are only 384px and do not fill the 400px panel; loading must stop once a scrollbar appears at 20 items, and must not render everything at once.
  expect(within(listbox).getAllByRole('option')).toHaveLength(20);
  expect(listbox.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: '1.0' }).id);

  listbox.scrollTop = listbox.scrollHeight - listbox.clientHeight;
  fireEvent.scroll(listbox);
  expect(within(listbox).getAllByRole('option')).toHaveLength(30);
  await user.click(screen.getByRole('option', { name: '1.25' }));
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(screen.getByRole('button', { name: '游戏版本 1.25' })).toBeTruthy();
});

test('deploy page Paper build dropdown: options arriving only after opening fill the panel as well', async () => {
  const builds = Array.from({ length: 45 }, (_, index) => 500 - index);
  let resolveBuilds: (response: Response) => void = () => {};
  const baseFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/cores/paper/versions') return new Response(JSON.stringify({ versions: ['26.3'] }));
    if (url === '/api/cores/paper/26.3/builds') return new Promise<Response>((resolve) => { resolveBuilds = resolve; });
    return baseFetch(url, options);
  }));
  Element.prototype.scrollIntoView = vi.fn();
  mockLazySelectLayout();
  const user = userEvent.setup();
  mount(<DeployPage />);
  await screen.findByRole('button', { name: '游戏版本 26.3' });

  await user.click(screen.getByRole('button', { name: /^Paper 构建版本/ }));
  const listbox = screen.getByRole('listbox', { name: /^Paper 构建版本/ });
  expect(within(listbox).queryAllByRole('option')).toHaveLength(0);

  await act(async () => { resolveBuilds(new Response(JSON.stringify({ builds }))); });
  await waitFor(() => expect(within(listbox).getAllByRole('option')).toHaveLength(20));
});

test('routine overview refreshes stay out of the live region, which announces only errors and recovery', async () => {
  vi.useFakeTimers();
  const baseFetch = globalThis.fetch;
  let fail = false;
  let sample = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/system/metrics') {
      if (fail) return new Response('{}', { status: 503 });
      sample += 1;
      return new Response(JSON.stringify({ ...metricSample, sampledAt: `2026-09-08T10:00:${String(sample * 5).padStart(2, '0')}Z` }));
    }
    return baseFetch(url, options);
  }));
  mount(<DashboardPage />);
  const liveText = () => [...document.querySelectorAll('[role="status"], [role="alert"], [aria-live]')]
    .map((node) => node.textContent ?? '').join('|');
  const refresh = () => screen.getByRole('button', { name: '刷新', exact: true }) as HTMLButtonElement;
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByText(/^更新于/)).toBeTruthy();
  expect(liveText()).not.toContain('更新于');

  const before = screen.getByText(/^更新于/).textContent;
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(screen.getByText(/^更新于/).textContent).not.toBe(before);
  expect(liveText()).not.toContain('更新于');
  // Routine polling does not toggle the refresh button's disabled state, so keyboard users focused on the button are not interrupted.
  expect(refresh().disabled).toBe(false);

  fail = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(liveText()).toContain('监测数据获取失败，数据可能过期');

  fail = false;
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(liveText()).not.toContain('获取失败');
  expect(liveText()).toContain('更新于');
  const announced = liveText();
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(liveText()).toBe(announced);
});

test('action errors of the confirmation dialog are shown inside the dialog, announced as an alert and associated as the description', async () => {
  const baseFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/instances' && options?.method === 'POST') return new Response(JSON.stringify({ error: '实例名称已存在' }), { status: 409 });
    return baseFetch(url, options);
  }));
  const user = userEvent.setup();
  mount(<DashboardPage />);
  await user.click(await screen.findByRole('button', { name: '创建空实例' }));
  const dialog = screen.getByRole('dialog', { name: '创建空实例' });
  expect(dialog.hasAttribute('aria-describedby')).toBe(false);
  await user.click(within(dialog).getByRole('button', { name: '创建并前往文件页' }));
  const alert = await within(dialog).findByRole('alert');
  expect(alert.textContent).toBe('实例名称已存在');
  expect(dialog.getAttribute('aria-describedby')).toBe(alert.id);
  await user.click(within(dialog).getByRole('button', { name: '取消' }));
  await user.click(screen.getByRole('button', { name: '创建空实例' }));
  expect(within(screen.getByRole('dialog', { name: '创建空实例' })).queryByRole('alert')).toBeNull();
});

test('console screen reader mode can be toggled and is remembered, and the live region is reset after the history is written and before a command is sent', async () => {
  const sockets: Array<{ onopen?: () => void; onmessage?: (ev: { data: string }) => void; send: ReturnType<typeof vi.fn> }> = [];
  vi.stubGlobal('WebSocket', class {
    static OPEN = 1;
    readyState = 1;
    send = vi.fn();
    constructor() { sockets.push(this); }
    close() {}
  });
  const user = userEvent.setup();
  const view = mount(<ConsolePanel instanceId="test" />);
  const toggle = screen.getByRole('button', { name: '读屏模式' });
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  expect(terminal.created).toEqual([false]);
  expect(Terminal.strings.promptLabel).toBe('控制台输出');
  expect(Terminal.strings.tooMuchOutput).toContain('输出太多');

  await user.click(toggle);
  expect(toggle.getAttribute('aria-pressed')).toBe('true');
  expect(terminal.current?.options.screenReaderMode).toBe(true);
  expect(localStorage.getItem('mystry_console_screen_reader')).toBe('1');

  await waitFor(() => expect(sockets).toHaveLength(1));
  terminal.srChanges = [];
  act(() => {
    sockets[0].onopen?.();
    sockets[0].onmessage?.({ data: JSON.stringify({ type: 'history', data: '[10:00:00 INFO]: Done (3.2s)!\n', status: 'running' }) });
  });
  // Coloring and history replacement are unaffected; after the history is written, close and reopen once to reset xterm's announcement count.
  expect(terminal.written).toContain('Done (3.2s)');
  expect(terminal.srChanges).toEqual([false, true]);

  terminal.srChanges = [];
  await user.type(screen.getByRole('textbox', { name: '控制台命令' }), 'list{Enter}');
  expect(sockets[0].send).toHaveBeenCalledWith(JSON.stringify({ type: 'command', data: 'list' }));
  expect(terminal.srChanges).toEqual([false, true]);

  view.unmount();
  mount(<ConsolePanel instanceId="test" />);
  expect(screen.getByRole('button', { name: '读屏模式' }).getAttribute('aria-pressed')).toBe('true');
  expect(terminal.created.at(-1)).toBe(true);
  await user.click(screen.getByRole('button', { name: '读屏模式' }));
  expect(terminal.current?.options.screenReaderMode).toBe(false);
  expect(localStorage.getItem('mystry_console_screen_reader')).toBeNull();
});

test('the config editor shows a value outside the options as is, without wrongly displaying the first item', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ difficulty: '9', gamemode: 'creative' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )));
  // useBlocker needs a data router, so MemoryRouter cannot be used here.
  const router = createMemoryRouter([{ path: '/', element: <ConfigTab instanceId="test" /> }]);
  render(<RouterProvider router={router} />);

  const difficulty = await screen.findByRole('combobox', { name: '难度' }) as HTMLSelectElement;
  await waitFor(() => expect(difficulty.value).toBe('9'));
  expect(within(difficulty).getByRole('option', { name: '9' })).toBeTruthy();
  const gamemode = screen.getByRole('combobox', { name: '默认游戏模式' }) as HTMLSelectElement;
  expect(gamemode.value).toBe('creative');
  expect(within(gamemode).queryByRole('option', { name: 'creative' })).toBeNull();
});

// Shared by the config editor tests: mounts with the given file content and records what is submitted on save.
function mountConfigTab(fileProps: Record<string, string>, mcVersion?: string) {
  const saves: Record<string, string>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => {
    if (options?.method === 'PUT') saves.push(JSON.parse(String(options.body)) as Record<string, string>);
    return new Response(JSON.stringify(fileProps), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  const router = createMemoryRouter([{ path: '/', element: <ConfigTab instanceId="test" mcVersion={mcVersion} /> }]);
  render(<RouterProvider router={router} />);
  return saves;
}

test('config editor: keys not written in the file show the game default, toggling back to the default is not a change, and only changed keys are written on save', async () => {
  const user = userEvent.setup();
  const saves = mountConfigTab({ motd: 'Imported', 'server-port': '25565' });

  const onlineMode = await screen.findByRole('switch', { name: '正版验证（在线模式）' }) as HTMLInputElement;
  await waitFor(() => expect(onlineMode.disabled).toBe(false));
  // Switches and dropdowns show the default value, number and text boxes put the default in the placeholder, and the input itself is empty.
  expect(onlineMode.checked).toBe(true);
  expect((screen.getByRole('switch', { name: '启用白名单' }) as HTMLInputElement).checked).toBe(false);
  const difficulty = screen.getByRole('combobox', { name: '难度' }) as HTMLSelectElement;
  expect(difficulty.value).toBe('easy');
  expect(within(difficulty).getByRole('option', { name: '简单（默认）' })).toBeTruthy();
  expect(within(difficulty).queryByRole('option', { name: '请选择' })).toBeNull();
  const maxPlayers = screen.getByRole('textbox', { name: '最大在线人数' }) as HTMLInputElement;
  expect(maxPlayers.value).toBe('');
  expect(maxPlayers.placeholder).toBe('20');
  expect((screen.getByRole('textbox', { name: '世界种子' }) as HTMLInputElement).placeholder).toBe('随机');
  // The save bar appears only when there are changes.
  const findSave = () => screen.queryByRole('button', { name: '保存配置' }) as HTMLButtonElement | null;
  expect(findSave()).toBeNull();

  // Toggling away from the default counts as a change, and toggling back returns to unchanged.
  await user.click(onlineMode);
  expect(onlineMode.checked).toBe(false);
  expect(findSave()!.disabled).toBe(false);
  await user.click(onlineMode);
  expect(onlineMode.checked).toBe(true);
  expect(findSave()).toBeNull();
  await user.selectOptions(difficulty, 'hard');
  expect(findSave()!.disabled).toBe(false);
  await user.selectOptions(difficulty, 'easy');
  expect(findSave()).toBeNull();
  // Filling in a number box and clearing it likewise returns to unchanged.
  await user.type(maxPlayers, '8');
  expect(findSave()!.disabled).toBe(false);
  await user.clear(maxPlayers);
  expect(findSave()).toBeNull();

  // The displayed default value is not written into the file along with the rest.
  await user.selectOptions(difficulty, 'hard');
  await user.click(findSave()!);
  await waitFor(() => expect(saves).toEqual([{ motd: 'Imported', 'server-port': '25565', difficulty: 'hard' }]));
});

test('config editor: keys with an empty value in the file are shown as the server actually applies them', async () => {
  mountConfigTab({ difficulty: '', 'online-mode': '', 'max-players': '', motd: '', 'level-seed': '' });

  const difficulty = await screen.findByRole('combobox', { name: '难度' }) as HTMLSelectElement;
  // When left empty, dropdown items and numbers use the server default, a switch equals off, and text is simply empty (an empty world seed is random).
  await waitFor(() => expect(difficulty.value).toBe('easy'));
  expect(within(difficulty).queryByRole('option', { name: '请选择' })).toBeNull();
  expect((screen.getByRole('switch', { name: '正版验证（在线模式）' }) as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole('textbox', { name: '最大在线人数' }) as HTMLInputElement).placeholder).toBe('20');
  expect((screen.getByRole('textbox', { name: '服务器简介' }) as HTMLInputElement).placeholder).toBe('');
  expect((screen.getByRole('textbox', { name: '世界种子' }) as HTMLInputElement).placeholder).toBe('随机');
  expect(screen.queryByRole('button', { name: '保存配置' })).toBeNull();
});

test('config editor: an existing number item can be cleared and saved, and an out-of-range value is still blocked', async () => {
  const user = userEvent.setup();
  const saves = mountConfigTab({ 'view-distance': '12', 'server-port': '25570' });

  const view = await screen.findByRole('textbox', { name: '视距（区块）' }) as HTMLInputElement;
  await waitFor(() => expect(view.value).toBe('12'));
  const port = screen.getByRole('textbox', { name: '服务器端口' }) as HTMLInputElement;

  // No error after clearing, and the placeholder is the default the server will use.
  await user.clear(port);
  await user.clear(view);
  expect(view.getAttribute('aria-invalid')).toBeNull();
  expect(view.placeholder).toBe('10');
  expect(port.placeholder).toBe('25565');
  const save = screen.getByRole('button', { name: '保存配置' }) as HTMLButtonElement;
  expect(save.disabled).toBe(false);

  // An out-of-range value blocks saving right away, and the red text shows only after blur.
  await user.type(view, '99');
  expect(save.disabled).toBe(true);
  expect(screen.getByRole('status').textContent).toBe('先修正「视距（区块）」');
  expect(view.getAttribute('aria-invalid')).toBeNull();
  await user.tab();
  expect(view.getAttribute('aria-invalid')).toBe('true');

  await user.clear(view);
  await user.click(save);
  await waitFor(() => expect(saves).toEqual([{ 'view-distance': '', 'server-port': '' }]));
});

test('config editor: when the file cannot be read, game defaults are not displayed as file content', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: '测试读取失败' }), { status: 500 })));
  const router = createMemoryRouter([{ path: '/', element: <ConfigTab instanceId="test" /> }]);
  render(<RouterProvider router={router} />);

  expect((await screen.findByRole('alert')).textContent).toContain('测试读取失败');
  const onlineMode = screen.getByRole('switch', { name: '正版验证（在线模式）' }) as HTMLInputElement;
  expect(onlineMode.disabled).toBe(true);
  expect(onlineMode.checked).toBe(false);
  const difficulty = screen.getByRole('combobox', { name: '难度' }) as HTMLSelectElement;
  expect(difficulty.value).toBe('');
  expect(within(difficulty).queryByRole('option', { name: '简单（默认）' })).toBeNull();
  expect((screen.getByRole('textbox', { name: '最大在线人数' }) as HTMLInputElement).placeholder).toBe('');
  expect((screen.getByRole('textbox', { name: '世界种子' }) as HTMLInputElement).placeholder).toBe('');
});

test('config editor: items that became game rules are hidden by the instance game version, and old values in the file are sent back as is on save', async () => {
  const user = userEvent.setup();
  const saves = mountConfigTab({ motd: 'Old', pvp: 'false', 'spawn-animals': 'false' }, '26.3');

  const motd = await screen.findByRole('textbox', { name: '服务器简介' }) as HTMLInputElement;
  await waitFor(() => expect(motd.value).toBe('Old'));
  for (const name of ['玩家对战（PVP）', '开启下界', '生成怪物', '生成动物']) {
    expect(screen.queryByRole('switch', { name })).toBeNull();
  }
  // Hidden keys do not appear in "Advanced Options", and the end of both groups says where to set them.
  expect(screen.queryByLabelText('pvp')).toBeNull();
  expect(screen.queryByLabelText('spawn-animals')).toBeNull();
  expect(screen.getAllByText('/gamerule')).toHaveLength(2);
  expect(screen.getByRole('switch', { name: '正版验证（在线模式）' })).toBeTruthy();

  await user.clear(motd);
  await user.type(motd, 'New');
  await user.click(screen.getByRole('button', { name: '保存配置' }));
  await waitFor(() => expect(saves).toEqual([{ motd: 'New', pvp: 'false', 'spawn-animals': 'false' }]));
});

test('config editor: items still in use are not hidden on old versions or when the version is unknown', async () => {
  mountConfigTab({ motd: 'Old' }, '1.21.8');
  // 1.21.8: spawn animals was already removed in 1.21.2, and the other three were removed only in 1.21.9.
  const pvp = await screen.findByRole('switch', { name: '玩家对战（PVP）' }) as HTMLInputElement;
  await waitFor(() => expect(pvp.disabled).toBe(false));
  expect(pvp.checked).toBe(true);
  expect(screen.getByRole('switch', { name: '开启下界' })).toBeTruthy();
  expect(screen.getByRole('switch', { name: '生成怪物' })).toBeTruthy();
  expect(screen.queryByRole('switch', { name: '生成动物' })).toBeNull();
  expect(screen.queryByText('/gamerule')).toBeNull();
  cleanup();

  // Instances whose version cannot be recognized, such as snapshot numbers and custom jars, show everything as usual.
  for (const version of [undefined, '25w35a']) {
    mountConfigTab({ motd: 'Old' }, version);
    expect(await screen.findByRole('switch', { name: '生成动物' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: '玩家对战（PVP）' })).toBeTruthy();
    expect(screen.queryByText('/gamerule')).toBeNull();
    cleanup();
  }
});

test('a start failure with the EULA not accepted shows a notice, and "Accept and Start" saves acceptance before starting', async () => {
  const user = userEvent.setup();
  const baseFetch = globalThis.fetch;
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    const method = options?.method ?? 'GET';
    if (url === '/api/instances/test' && method === 'GET') {
      return new Response(JSON.stringify({ ...instance, name: '测试服', acceptEula: false, startIssue: { kind: 'eula', requiredJava: null } }));
    }
    if (method !== 'GET' && String(url).startsWith('/api/instances/test') && !String(url).includes('console-ticket')) {
      calls.push(`${method} ${url} ${options?.body ?? ''}`.trim());
      return new Response('{}');
    }
    return baseFetch(url, options);
  }));
  const router = createMemoryRouter(
    [{ path: '/instances/:id/*', element: <InstancePage /> }],
    { initialEntries: ['/instances/test'] },
  );
  render(<RouterProvider router={router} />);
  const banner = await screen.findByRole('alert');
  expect(banner.textContent).toContain('同意 Minecraft EULA 后才能启动这个服务器');
  expect(within(banner).getByRole('link', { name: 'Minecraft EULA' }).getAttribute('href')).toBe('https://aka.ms/MinecraftEULA');
  await user.click(within(banner).getByRole('button', { name: '同意并启动' }));
  await waitFor(() => expect(calls).toEqual([
    'PATCH /api/instances/test {"acceptEula":true}',
    'POST /api/instances/test/start',
  ]));
});

test('a start failure from a Java version mismatch gives the needed version, a download link and the instance settings entry', async () => {
  const baseFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => (
    url === '/api/instances/test'
      ? new Response(JSON.stringify({ ...instance, name: '测试服', status: 'crashed', startIssue: { kind: 'java-too-new', requiredJava: 8 } }))
      : baseFetch(url, options)
  )));
  const router = createMemoryRouter(
    [{ path: '/instances/:id/*', element: <InstancePage /> }],
    { initialEntries: ['/instances/test'] },
  );
  render(<RouterProvider router={router} />);
  const banner = await screen.findByRole('alert');
  expect(banner.textContent).toContain('这个服务器需要 Java 8');
  expect(banner.textContent).toContain('Java 版本太新');
  expect(within(banner).getByRole('link', { name: '下载 Java 8' }).getAttribute('href')).toBe('https://adoptium.net/temurin/releases/?version=8');
  expect(within(banner).getByRole('link', { name: '打开实例设置' }).getAttribute('href')).toBe('/instances/test/settings');
});

test('after the server finishes starting a hint says it can be joined and points to multiplayer; it no longer appears after "Do not show again"', async () => {
  const user = userEvent.setup();
  const baseFetch = globalThis.fetch;
  let ready = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => (
    url === '/api/instances/test'
      ? new Response(JSON.stringify({ ...instance, name: '测试服', status: 'running', ready }))
      : baseFetch(url, options)
  )));
  const open = () => render(<RouterProvider router={createMemoryRouter(
    [{ path: '/instances/:id/*', element: <InstancePage /> }],
    { initialEntries: ['/instances/test'] },
  )} />);

  // No notice while the world is still loading.
  const loading = open();
  expect(await screen.findByRole('heading', { name: '测试服' })).toBeTruthy();
  expect(screen.queryByText('服务器已启动，现在可以进服了。')).toBeNull();
  loading.unmount();

  ready = true;
  const started = open();
  expect(await screen.findByText('服务器已启动，现在可以进服了。')).toBeTruthy();
  expect(screen.getByRole('link', { name: '邀请玩家' }).getAttribute('href')).toBe('/multiplayer?instance=test');
  await user.click(screen.getByRole('button', { name: '不再提示' }));
  expect(screen.queryByText('服务器已启动，现在可以进服了。')).toBeNull();
  started.unmount();

  // After dismissing it, it does not appear again when the page is reopened.
  open();
  expect(await screen.findByRole('heading', { name: '测试服' })).toBeTruthy();
  expect(screen.queryByText('服务器已启动，现在可以进服了。')).toBeNull();
});

test('importing from a local folder fills in the recognized core type and Minecraft version', async () => {
  const baseFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => (
    String(url).includes('/import/sources')
      ? new Response(JSON.stringify({ sources: [{
        id: 'old-forge',
        launchTarget: 'forge-1.12.2-14.23.5.2860.jar',
        coreType: 'forge',
        mcVersion: '1.12.2',
        modifiedAt: '2026-11-01T00:00:00.000Z',
        ready: true,
      }] }))
      : baseFetch(url, options)
  )));
  mount(<ImportPage />);
  const version = await screen.findByRole('textbox', { name: 'Minecraft 版本（可选）' }) as HTMLInputElement;
  await waitFor(() => expect(version.value).toBe('1.12.2'));
  expect((screen.getByRole('combobox', { name: '核心类型' }) as HTMLSelectElement).value).toBe('forge');
  expect(screen.getByRole('option', { name: '自动识别' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '复制并导入' })).toBeTruthy();
});

test('the multiplayer page defaults to "Direct Connection": copyable addresses are listed, with a way over to the virtual LAN', async () => {
  const user = userEvent.setup();
  const baseFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    const data = url === '/api/instances/test/local-network' ? { port: 25565, addresses: ['192.168.1.23', '10.0.0.5'], publicIpv4: [], publicIpv6: ['2408:8207:ab::10'], publicHost: null, serverIpBlocked: false, serverIpIsUnboundPublicHost: false, panelPort: 3000, platform: 'win32' }
      : url === '/api/lan/runtime' ? { version: '0.0.0', installed: true, platformSupported: true }
      : url === '/api/instances/test/lan' ? { instanceId: 'test', enabled: false, status: 'disabled', localPort: 25565, virtualIp: null, joinAddress: null, serverIpBlocked: false, runtimeInstalled: true, peers: [], useSharedPeers: true, sharedPeers: ['tcp://public.easytier.example:11010'], listenPort: null, detail: null, warning: null }
      : null;
    return data ? new Response(JSON.stringify(data)) : baseFetch(url, options);
  }));
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  mount(<MultiplayerPage />);
  expect(await screen.findByRole('button', { name: '直接连接', pressed: true })).toBeTruthy();
  expect(await screen.findByText('192.168.1.23:25565')).toBeTruthy();
  expect(screen.getByText('10.0.0.5:25565')).toBeTruthy();
  expect(screen.getByText('有多个地址时，玩家可以逐个试。')).toBeTruthy();
  // When the instance is not running, it first prompts to start it.
  expect(screen.getByText('服务器没在运行，启动后玩家才能加入。')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '复制 192.168.1.23:25565' }));
  expect(writeText).toHaveBeenCalledWith('192.168.1.23:25565');
  expect(await screen.findByText('已复制 192.168.1.23:25565。')).toBeTruthy();
  // With a public IPv6 another address with square brackets is given, with a reminder to allow only the port.
  expect(screen.getByText('IPv6 加入地址')).toBeTruthy();
  expect(screen.getByText(/只放行这台电脑的 25565 端口/)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '复制 [2408:8207:ab::10]:25565' }));
  expect(writeText).toHaveBeenCalledWith('[2408:8207:ab::10]:25565');
  await user.click(screen.getByRole('button', { name: '改用虚拟局域网' }));
  expect(await screen.findByRole('button', { name: '虚拟局域网', pressed: true })).toBeTruthy();
});

test('the multiplayer guide column can be closed and is remembered; manual install is collapsed by default when the client is not installed', async () => {
  const user = userEvent.setup();
  const baseFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    const data = url === '/api/instances/test/local-network' ? { port: 25565, addresses: ['192.168.1.23'], publicIpv4: [], publicIpv6: [], publicHost: null, serverIpBlocked: false, serverIpIsUnboundPublicHost: false, panelPort: 3000, platform: 'linux' }
      : url === '/api/lan/runtime' ? { version: '2.6.4', installed: false, platformSupported: true, archive: { name: 'easytier.zip', sha256: 'a'.repeat(64), url: 'https://example.invalid/easytier.zip', maxBytes: 1 } }
      : url === '/api/instances/test/lan' ? { instanceId: 'test', enabled: false, status: 'disabled', localPort: 25565, virtualIp: null, joinAddress: null, serverIpBlocked: false, runtimeInstalled: false, peers: [], useSharedPeers: true, sharedPeers: [], listenPort: null, detail: null, warning: null }
      : null;
    return data ? new Response(JSON.stringify(data)) : baseFetch(url, options);
  }));
  mount(<MultiplayerPage />);
  expect(await screen.findByRole('heading', { name: '指引' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '关闭指引' }));
  expect(screen.queryByRole('heading', { name: '指引' })).toBeNull();
  expect(localStorage.getItem('mystry_multiplayer_guide')).toBe('closed');
  // After the clicked button disappears, focus goes to the button that takes its place.
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '显示指引' }));
  await user.click(screen.getByRole('button', { name: '显示指引' }));
  expect(screen.getByRole('heading', { name: '指引' })).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '关闭指引' }));
  expect(localStorage.getItem('mystry_multiplayer_guide')).toBeNull();

  await user.click(screen.getByRole('button', { name: '虚拟局域网' }));
  expect(await screen.findByText('未安装 EasyTier 客户端。')).toBeTruthy();
  // Without the client installed only the install prompt is left; the switch and relay peers appear once it is installed.
  expect(screen.queryByRole('switch', { name: '对玩家开放这个实例' })).toBeNull();
  expect(screen.queryByText('中继节点')).toBeNull();
  expect(screen.queryByText(/SHA-256 一致才会安装/)).toBeNull();
  await user.click(screen.getByRole('button', { name: '手动安装' }));
  expect(screen.getByText(/SHA-256 一致才会安装/)).toBeTruthy();
  expect(screen.getByRole('button', { name: '上传压缩包' })).toBeTruthy();
});

test('the virtual LAN switch saves immediately with only the relay peers saved on the server; on failure the switch returns to its place', async () => {
  const user = userEvent.setup();
  const baseFetch = globalThis.fetch;
  const lanState = { instanceId: 'test', enabled: false, status: 'disabled', localPort: 25565, virtualIp: null as string | null, joinAddress: null as string | null, serverIpBlocked: false, runtimeInstalled: true, peers: ['tcp://relay.example.com:11010'], useSharedPeers: true, sharedPeers: ['tcp://public.example:11010'], listenPort: null, detail: null, warning: null };
  const bodies: string[] = [];
  let failNext = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/instances/test/lan' && options?.method === 'PUT') {
      bodies.push(String(options.body));
      if (failNext) {
        failNext = false;
        return new Response(JSON.stringify({ error: 'Run the panel as administrator.' }), { status: 500 });
      }
      Object.assign(lanState, JSON.parse(String(options.body)), { status: 'running', virtualIp: '10.126.3.1', joinAddress: '10.126.3.1:25565' });
      return new Response(JSON.stringify(lanState));
    }
    const data = url === '/api/instances/test/local-network' ? { port: 25565, addresses: ['192.168.1.23'], publicIpv4: [], publicIpv6: [], publicHost: null, serverIpBlocked: false, serverIpIsUnboundPublicHost: false, panelPort: 3000, platform: 'linux' }
      : url === '/api/lan/runtime' ? { version: '2.6.4', installed: true, platformSupported: true, archive: null }
      : url === '/api/instances/test/lan' ? lanState
      : null;
    return data ? new Response(JSON.stringify(data)) : baseFetch(url, options);
  }));
  mount(<MultiplayerPage />);
  await user.click(await screen.findByRole('button', { name: '虚拟局域网' }));
  const toggle = await screen.findByRole('switch', { name: '对玩家开放这个实例' }) as HTMLInputElement;
  expect(toggle.checked).toBe(false);
  // Own relay peers already filled in: the collapsible section is expanded by default, so settings already in effect are not hidden.
  expect((screen.getByText('中继节点').closest('details') as HTMLDetailsElement).open).toBe(true);
  // Unsaved changes in the text box are not carried along by the switch.
  await user.type(screen.getByLabelText('自己的中继节点'), '\ntcp://draft.example.com:11010');

  await user.click(toggle);
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(toggle.checked).toBe(false);
  expect(screen.queryByRole('heading', { name: '让玩家加入' })).toBeNull();

  await user.click(toggle);
  expect(await screen.findByRole('heading', { name: '让玩家加入' })).toBeTruthy();
  expect(toggle.checked).toBe(true);
  expect(screen.getByText('10.126.3.1:25565')).toBeTruthy();
  expect(bodies.map((body) => JSON.parse(body))).toEqual([
    { enabled: true, peers: ['tcp://relay.example.com:11010'], useSharedPeers: true },
    { enabled: true, peers: ['tcp://relay.example.com:11010'], useSharedPeers: true },
  ]);

  // Relay peers are saved separately, with the server's current switch state; while on, there is a reminder to resend the join instructions.
  await user.click(screen.getByRole('button', { name: '保存中继节点' }));
  expect(await screen.findByText('中继节点已保存。要把新的加入说明重新发给玩家。')).toBeTruthy();
  expect(JSON.parse(bodies[2])).toEqual({ enabled: true, peers: ['tcp://relay.example.com:11010', 'tcp://draft.example.com:11010'], useSharedPeers: true });
});

function mountLanTab(runtime: Record<string, unknown>, lan: Record<string, unknown>) {
  const baseFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    const data = url === '/api/instances/test/local-network' ? { port: 25565, addresses: ['192.168.1.23'], publicIpv4: [], publicIpv6: [], publicHost: null, serverIpBlocked: false, serverIpIsUnboundPublicHost: false, panelPort: 3000, platform: 'win32' }
      : url === '/api/lan/runtime' ? { version: '2.6.4', installed: true, platformSupported: true, archive: null, needsAdmin: false, runsAsAdmin: false, ...runtime }
      : url === '/api/instances/test/lan' ? { instanceId: 'test', enabled: true, status: 'stopped', localPort: 25565, virtualIp: null, joinAddress: null, serverIpBlocked: false, runtimeInstalled: true, peers: [], useSharedPeers: true, sharedPeers: [], listenPort: null, detail: null, warning: null, ...lan }
      : null;
    return data ? new Response(JSON.stringify(data)) : baseFetch(url, options);
  }));
  mount(<MultiplayerPage />);
}

test('virtual LAN without administrator rights: the restart steps come first, and no join instructions are offered while the server is stopped', async () => {
  const user = userEvent.setup();
  mountLanTab({ needsAdmin: true, installed: false, archive: { name: 'easytier.zip', sha256: 'a'.repeat(64), url: 'https://example.invalid/easytier.zip', maxBytes: 1 } }, { enabled: false, status: 'disabled', runtimeInstalled: false });
  await user.click(await screen.findByRole('button', { name: '虚拟局域网' }));
  // Said before the client is downloaded, not after the switch fails.
  expect(await screen.findByText(/面板没有以管理员身份运行/)).toBeTruthy();
  // The page names the manual steps.
  expect(screen.getByText(/右键 mdash\.cmd，选「以管理员身份运行」，再在菜单里选「重启面板」/)).toBeTruthy();
  // No confirmation comes before the manual steps, so the guide says what running as administrator means.
  expect(screen.getByRole('heading', { name: '以管理员身份运行时' })).toBeTruthy();
  expect(screen.getByText('服务器和其中的插件、模组也会有管理员权限，只装信任的。')).toBeTruthy();
  expect(screen.getByRole('button', { name: '下载 EasyTier' })).toBeTruthy();
  cleanup();

  // Already on from an earlier elevated run: EasyTier only starts with the game, so a stopped server shows no failure yet.
  mountLanTab({ needsAdmin: true }, { detail: { key: 'server.lan.notRunning' } });
  await user.click(await screen.findByRole('button', { name: '虚拟局域网' }));
  expect(await screen.findByText(/面板没有以管理员身份运行/)).toBeTruthy();
  const toggle = await screen.findByRole('switch', { name: '对玩家开放这个实例' }) as HTMLInputElement;
  expect(toggle.checked).toBe(true);
  expect(toggle.disabled).toBe(false);
  expect(screen.queryByRole('heading', { name: '让玩家加入' })).toBeNull();
  expect(screen.queryByRole('button', { name: '复制加入说明' })).toBeNull();
});

test('virtual LAN that failed: the reason is an alert, the join instructions are withdrawn, and the administrator failure is not said twice', async () => {
  const user = userEvent.setup();
  mountLanTab({ needsAdmin: true }, { status: 'error', detail: { key: 'server.lan.needsAdminWindows' } });
  await user.click(await screen.findByRole('button', { name: '虚拟局域网' }));
  expect(await screen.findByText(/面板没有以管理员身份运行/)).toBeTruthy();
  expect(screen.queryByText(/建虚拟网卡需要管理员权限/)).toBeNull();
  expect(screen.queryByRole('button', { name: '复制加入说明' })).toBeNull();
  cleanup();

  mountLanTab({}, { status: 'error', detail: { key: 'server.lan.exited' } });
  await user.click(await screen.findByRole('button', { name: '虚拟局域网' }));
  expect((await screen.findByRole('alert')).textContent).toContain('虚拟局域网客户端已停止');
  expect(screen.queryByText(/面板没有以管理员身份运行/)).toBeNull();
  expect(screen.queryByRole('heading', { name: '让玩家加入' })).toBeNull();
  expect(screen.queryByRole('button', { name: '复制加入说明' })).toBeNull();
});

test('panel running as administrator: the row stays above the switch as granted and says the servers have the same rights', async () => {
  const user = userEvent.setup();
  mountLanTab({ runsAsAdmin: true }, { enabled: false, status: 'disabled' });
  await user.click(await screen.findByRole('button', { name: '虚拟局域网' }));
  const row = (await screen.findByText('已获得')).closest('.list-row') as HTMLElement;
  expect(within(row).getByText('管理员身份')).toBeTruthy();
  expect(within(row).getByText('服务器和其中的插件、模组也有管理员权限，只装信任的。')).toBeTruthy();
  // Nothing is left to do, so the row has no button and the manual steps are gone.
  expect(within(row).queryByRole('button')).toBeNull();
  expect(screen.queryByText(/右键 mdash\.cmd/)).toBeNull();
  expect(screen.queryByText(/面板没有以管理员身份运行/)).toBeNull();
  expect(row.parentElement).toBe(screen.getByRole('switch', { name: '对玩家开放这个实例' }).closest('.list-group'));
  expect(screen.getByText('玩家那边也要以管理员身份运行。')).toBeTruthy();
});

test('the first save of frp tunnel settings is "Save and Open", and afterwards the tunnel settings are tucked into the collapsible section', async () => {
  const user = userEvent.setup();
  const baseFetch = globalThis.fetch;
  const tunnelState = { instanceId: 'test', enabled: false, endpointId: null as string | null, mode: 'public', remotePort: null as number | null, visitorBindPort: 25566, localPort: 25565, status: 'disabled', joinAddress: null as string | null, serverIpBlocked: false, runtimeInstalled: true, detail: null };
  const bodies: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/instances/test/tunnel' && options?.method === 'PUT') {
      bodies.push(String(options.body));
      Object.assign(tunnelState, JSON.parse(String(options.body)), { status: 'running', joinAddress: 'frp.example.com:25565' });
      return new Response(JSON.stringify(tunnelState));
    }
    const data = url === '/api/instances/test/local-network' ? { port: 25565, addresses: ['192.168.1.23'], publicIpv4: [], publicIpv6: [], publicHost: null, serverIpBlocked: false, serverIpIsUnboundPublicHost: false, panelPort: 3000, platform: 'linux' }
      : url === '/api/frp/runtime' ? { version: '0.71.1', installed: true, platformSupported: true, archive: null }
      : url === '/api/frp/endpoints' ? [{ id: 'e1', name: 'Hong Kong', serverAddr: 'frp.example.com', serverPort: 7000, visitHost: '', transport: 'tcp', tls: true, tokenSet: true }]
      : url === '/api/instances/test/tunnel' ? tunnelState
      : null;
    return data ? new Response(JSON.stringify(data)) : baseFetch(url, options);
  }));
  mount(<MultiplayerPage />);
  await user.click(await screen.findByRole('button', { name: 'frp 穿透' }));
  // Tunnel settings never saved yet: there is no switch, and the button is "Save and Open" directly.
  const saveOpen = await screen.findByRole('button', { name: '保存并开放' });
  expect(screen.queryByRole('switch', { name: '对玩家开放这个实例' })).toBeNull();
  await user.click(saveOpen);
  expect(await screen.findByText('frp.example.com:25565')).toBeTruthy();
  expect(JSON.parse(bodies[0])).toEqual({ enabled: true, endpointId: 'e1', mode: 'public', remotePort: 25565, visitorBindPort: 25566 });
  const toggle = screen.getByRole('switch', { name: '对玩家开放这个实例' }) as HTMLInputElement;
  expect(toggle.checked).toBe(true);
  expect((screen.getByText('穿透设置').closest('details') as HTMLDetailsElement).open).toBe(false);

  // Turning it off with the switch afterwards sends the settings saved on the server.
  await user.click(toggle);
  await waitFor(() => expect(bodies).toHaveLength(2));
  expect(JSON.parse(bodies[1])).toEqual({ enabled: false, endpointId: 'e1', mode: 'public', remotePort: 25565, visitorBindPort: 25566 });
});

test('after a successful password change the new token is swapped in and it says other devices have to sign in again', async () => {
  const user = userEvent.setup();
  const baseFetch = globalThis.fetch;
  const bodies: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/auth/password' && options?.method === 'POST') {
      bodies.push(String(options.body));
      return new Response(JSON.stringify({ ok: true, token: 'fresh-token', user: { id: 'tester', username: '测试员' } }));
    }
    return baseFetch(url, options);
  }));
  localStorage.setItem('mystry_token', 'stale-token');
  render(<ChangePasswordDialog onClose={() => {}} />);
  await user.type(screen.getByLabelText('当前密码'), 'password1234');
  await user.type(screen.getByLabelText('新密码'), 'changed-password');
  await user.click(screen.getByRole('button', { name: '修改密码' }));
  expect(await screen.findByText('密码已修改。当前页面保持登录，其他浏览器和设备需要用新密码重新登录。')).toBeTruthy();
  expect(getToken()).toBe('fresh-token');
  expect(bodies).toEqual(['{"currentPassword":"password1234","newPassword":"changed-password"}']);
});

test('once the token has been reissued, a 401 for a request with the old token does not clear the new token', async () => {
  let respond!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { respond = resolve; })));
  const onUnauthorized = vi.fn();
  window.addEventListener('mystry:unauthorized', onUnauthorized);
  try {
    localStorage.setItem('mystry_token', 'stale-token');
    const stale = api('/api/system/metrics').catch((error: unknown) => error);
    localStorage.setItem('mystry_token', 'fresh-token');
    respond(new Response(JSON.stringify({ error: 'expired', code: 'server.common.unauthorized' }), { status: 401 }));
    await stale;
    expect(getToken()).toBe('fresh-token');
    expect(onUnauthorized).not.toHaveBeenCalled();

    // When the current token itself is rejected, sign out as usual.
    const current = api('/api/system/metrics').catch((error: unknown) => error);
    respond(new Response(JSON.stringify({ error: 'expired', code: 'server.common.unauthorized' }), { status: 401 }));
    await current;
    expect(getToken()).toBeNull();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  } finally {
    window.removeEventListener('mystry:unauthorized', onUnauthorized);
  }
});

test('multiplayer page public direct connection: after a public address is entered it gives "address:game port" and a checklist', async () => {
  const user = userEvent.setup();
  const baseFetch = globalThis.fetch;
  let publicHost: string | null = null;
  const saved: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/system/public-host' && options?.method === 'PUT') {
      saved.push(String(options.body));
      const host = (JSON.parse(String(options.body)) as { host: string | null }).host;
      if (host?.includes(':')) return new Response(JSON.stringify({ error: 'port', code: 'server.publicHost.hasPort' }), { status: 400 });
      publicHost = host;
      return new Response(JSON.stringify({ publicHost }));
    }
    const data = url === '/api/instances/test/local-network'
      ? { port: 25570, addresses: ['172.16.0.8'], publicIpv4: [], publicIpv6: [], publicHost, serverIpBlocked: false, serverIpIsUnboundPublicHost: false, panelPort: 3000, platform: 'linux' }
      : null;
    return data ? new Response(JSON.stringify(data)) : baseFetch(url, options);
  }));
  mount(<MultiplayerPage />);
  expect(await screen.findByText('172.16.0.8:25570')).toBeTruthy();
  // The LAN address heading always says "same network"; without a public address the public card is not shown, and on Linux the Windows prompt hint is not shown.
  expect(screen.getByText('同一网络的加入地址')).toBeTruthy();
  expect(screen.queryByText('公网加入地址')).toBeNull();
  expect(screen.queryByText(/Windows 可能弹窗/)).toBeNull();
  await user.click(screen.getByRole('button', { name: '填写公网地址' }));
  const input = screen.getByLabelText('公网 IP 或域名');
  await user.type(input, '192.168.1.5');
  expect(screen.getByText('这像是内网地址，其他网络的玩家连不上。')).toBeTruthy();
  await user.clear(input);
  await user.type(input, '203.0.113.10:25570');
  // With a port there is no need to wait for a server error: it is explained right below the input, and the save button is disabled.
  expect(await screen.findByText(/端口不用填，会自动用服务器的游戏端口/)).toBeTruthy();
  expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
  await user.clear(input);
  await user.type(input, '203.0.113.10');
  await user.click(screen.getByRole('button', { name: '保存' }));
  expect(await screen.findByText('203.0.113.10:25570')).toBeTruthy();
  expect(saved.at(-1)).toBe('{"host":"203.0.113.10"}');
  // Once there is a public address, the LAN address uses the "same network" heading, so it is not mistaken for a public join address.
  expect(screen.getByText('同一网络的加入地址')).toBeTruthy();
  expect(screen.getByText(/放行入方向 TCP 25570（游戏端口）。面板端口 3000 只在/)).toBeTruthy();
  expect(screen.getByText('sudo ufw allow 25570/tcp')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '清除' }));
  await waitFor(() => expect(screen.queryByText('203.0.113.10:25570')).toBeNull());
  expect(saved.at(-1)).toBe('{"host":null}');
});

test('a dedicated notice is given when server-ip is set to a public IP', async () => {
  const baseFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    const data = url === '/api/instances/test/local-network'
      ? { port: 25565, addresses: [], publicIpv4: [], publicIpv6: [], publicHost: '203.0.113.10', serverIpBlocked: true, serverIpIsUnboundPublicHost: true, panelPort: 3000, platform: 'linux' }
      : null;
    return data ? new Response(JSON.stringify(data)) : baseFetch(url, options);
  }));
  mount(<MultiplayerPage />);
  expect(await screen.findByText(/server-ip 填了公网 IP，云服务器网卡上没有这个地址/)).toBeTruthy();
});

const remoteStatus = (direct: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  managedByConfig: false,
  configuredHost: null,
  port: 3000,
  frontendServed: true,
  platform: 'win32',
  interfaces: [
    { name: 'WLAN', address: '192.168.2.163', cidr: '192.168.2.163/24', kind: 'lan' },
    { name: 'Meta', address: '198.18.0.1', cidr: '198.18.0.1/30', kind: 'proxy' },
  ],
  publicHost: null,
  certificate: null,
  direct: { enabled: false, interfaceName: null, restrictToSubnet: false, https: true, urls: [], problem: null, firewall: null, ...direct },
  overlay: { enabled: false, interfaceName: null, restrictToSubnet: false, https: false, urls: [], problem: null, firewall: null },
  panelNetwork: { enabled: false, platformSupported: true, installed: false, state: 'stopped', detail: null, virtualIp: null, url: null, devices: [], useSharedPeers: true, customPeers: [], sharedPeers: ['tcp://shared.example:11010'], firewall: null },
  ...extra,
});

test('open on other devices: direct access is enabled with HTTPS by default, shows the QR code, URLs and firewall result, and can be disabled', async () => {
  const user = userEvent.setup();
  const baseFetch = globalThis.fetch;
  let current = remoteStatus();
  const bodies: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/system/remote-access/direct' && options?.method === 'PUT') {
      bodies.push(String(options.body));
      const body = JSON.parse(String(options.body)) as { enabled: boolean; https: boolean; interfaceName: string | null; restrictToSubnet: boolean };
      current = remoteStatus(body.enabled ? {
        ...body,
        firewall: 'failed',
        urls: [
          { url: `${body.https ? 'https' : 'http'}://192.168.2.163:3000/`, interfaceName: 'WLAN', kind: 'lan', listening: true, problem: null },
          { url: `${body.https ? 'https' : 'http'}://198.18.0.1:3000/`, interfaceName: 'Meta', kind: 'proxy', listening: false, problem: 'listenFailed' },
        ],
      } : body, body.enabled && body.https ? { certificate: { fingerprint256: 'AB:CD', notAfter: '2029-01-25T08:00:00.000Z', addresses: ['192.168.2.163'] } } : {});
      return new Response(JSON.stringify(current));
    }
    if (url === '/api/system/remote-access') return new Response(JSON.stringify(current));
    return baseFetch(url, options);
  }));
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const onClose = vi.fn();
  render(<RemoteAccessDialog onClose={onClose} />);
  expect(await screen.findByText('面板现在只允许这台电脑访问，其他设备打不开。')).toBeTruthy();
  // Defaults: all interfaces, HTTPS on, no source restriction.
  expect((screen.getByLabelText('网卡') as HTMLSelectElement).value).toBe('');
  expect((screen.getByRole('switch', { name: '使用 HTTPS' }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole('switch', { name: '只允许同一网段的设备' }) as HTMLInputElement).checked).toBe(false);
  expect(screen.getByRole('option', { name: 'Meta（198.18.0.1）' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '开启' }));
  expect(bodies).toEqual(['{"enabled":true,"interfaceName":null,"restrictToSubnet":false,"https":true}']);
  // After enabling: the QR code, URL explanation, addresses that could not be attached with reasons, the certificate fingerprint, and the firewall failure notice.
  expect(await screen.findByRole('img', { name: 'https://192.168.2.163:3000/ 的二维码' })).toBeTruthy();
  expect(screen.getByText('同一个 Wi-Fi 或路由器下的设备用这个。')).toBeTruthy();
  expect(screen.getByText('面板没能在这个地址上监听，3000 端口可能被别的程序占用。')).toBeTruthy();
  expect(screen.getByText(/第一次打开会提示不安全/)).toBeTruthy();
  expect(screen.getByText('AB:CD')).toBeTruthy();
  expect(screen.getByText(/Windows 防火墙规则没加上/)).toBeTruthy();
  expect(screen.getByText(/安全组放行入方向 TCP 3000/)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '复制 https://192.168.2.163:3000/' }));
  expect(writeText).toHaveBeenCalledWith('https://192.168.2.163:3000/');
  expect(await screen.findByText('已复制 https://192.168.2.163:3000/。')).toBeTruthy();
  // After enabling, changing a switch takes effect immediately.
  await user.click(screen.getByRole('switch', { name: '使用 HTTPS' }));
  expect(bodies.at(-1)).toBe('{"enabled":true,"interfaceName":null,"restrictToSubnet":false,"https":false}');
  expect(await screen.findByRole('img', { name: 'http://192.168.2.163:3000/ 的二维码' })).toBeTruthy();
  expect(screen.queryByText('AB:CD')).toBeNull();
  // "Close" at the bottom of the dialog only closes the dialog; the button that disables an access mode has a different name.
  await user.click(screen.getByRole('button', { name: '关闭此方式' }));
  await waitFor(() => expect(JSON.parse(bodies.at(-1)!).enabled).toBe(false));
  expect(await screen.findByText('面板现在只允许这台电脑访问，其他设备打不开。')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '关闭' }));
  expect(onClose).toHaveBeenCalled();
});

test('open on other devices: only URLs are shown when HOST is decided by the config file; it can be enabled without encryption when the certificate fails', async () => {
  const user = userEvent.setup();
  const baseFetch = globalThis.fetch;
  let managed = true;
  const bodies: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/system/remote-access/direct' && options?.method === 'PUT') {
      bodies.push(String(options.body));
      const body = JSON.parse(String(options.body)) as { https: boolean };
      if (body.https) return new Response(JSON.stringify({ error: 'cert', code: 'server.remoteAccess.certificateFailed' }), { status: 500 });
      return new Response(JSON.stringify(remoteStatus({ enabled: true, https: false, firewall: 'skipped', urls: [{ url: 'http://192.168.2.163:3000/', interfaceName: 'WLAN', kind: 'lan', listening: true, problem: null }] }, { platform: 'linux' })));
    }
    if (url === '/api/system/remote-access') {
      return new Response(JSON.stringify(managed
        ? remoteStatus({ enabled: true, https: false, urls: [{ url: 'http://192.168.2.163:3000/', interfaceName: 'WLAN', kind: 'lan', listening: true, problem: null }] }, { managedByConfig: true, configuredHost: '0.0.0.0' })
        : remoteStatus()));
    }
    return baseFetch(url, options);
  }));
  const view = render(<RemoteAccessDialog onClose={() => {}} />);
  expect(await screen.findByText('访问方式由配置文件决定（HOST=0.0.0.0），这里不用再开启。')).toBeTruthy();
  expect(screen.getByRole('img', { name: 'http://192.168.2.163:3000/ 的二维码' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: '开启' })).toBeNull();
  expect(screen.queryByRole('switch', { name: '使用 HTTPS' })).toBeNull();
  view.unmount();

  managed = false;
  render(<RemoteAccessDialog onClose={() => {}} />);
  await user.click(await screen.findByRole('button', { name: '开启' }));
  expect(await screen.findByText('HTTPS 证书生成或读取失败')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '不加密开启' }));
  expect(bodies.at(-1)).toBe('{"enabled":true,"interfaceName":null,"restrictToSubnet":false,"https":false}');
  expect(await screen.findByText(/sudo ufw allow 3000\/tcp/)).toBeTruthy();
});

test('open on other devices: after the built-in panel network is enabled the join info is given, and the secret is requested only when opened', async () => {
  const user = userEvent.setup();
  const baseFetch = globalThis.fetch;
  let network = remoteStatus().panelNetwork as Record<string, unknown>;
  let joinRequests = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/system/remote-access/panel-network' && options?.method === 'PUT') {
      const body = JSON.parse(String(options.body)) as { enabled: boolean };
      network = body.enabled
        ? { ...network, enabled: true, installed: true, state: 'running', virtualIp: '10.127.0.1', url: 'http://10.127.0.1:3000/', devices: [{ hostname: 'Pixel-8', virtualIp: '10.127.0.2', connection: 'direct' }] }
        : { ...network, enabled: false, state: 'stopped', url: null, devices: [] };
      return new Response(JSON.stringify(network));
    }
    if (url === '/api/system/remote-access/panel-network/join') {
      joinRequests += 1;
      return new Response(JSON.stringify({ networkName: 'mystry-panel-abc', networkSecret: 'abcdefghijklmnopqrstuvwxyz', peers: ['tcp://shared.example:11010'], easytierVersion: '2.6.4', androidDownloadUrl: 'https://github.com/EasyTier/EasyTier/releases/tag/v2.6.4' }));
    }
    if (url === '/api/system/remote-access') return new Response(JSON.stringify({ ...remoteStatus(), panelNetwork: network }));
    return baseFetch(url, options);
  }));
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  render(<RemoteAccessDialog onClose={() => {}} />);
  await user.click(await screen.findByRole('button', { name: '虚拟组网' }));
  // "Built into the panel" is the default when no overlay interface is detected.
  expect(screen.getByRole('button', { name: '面板自带', pressed: true })).toBeTruthy();
  expect(screen.getByText('未开启')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '开启' }));
  expect(await screen.findByRole('img', { name: 'http://10.127.0.1:3000/ 的二维码' })).toBeTruthy();
  expect(screen.getByText('Pixel-8')).toBeTruthy();
  expect(screen.getByText('直连')).toBeTruthy();
  expect(joinRequests).toBe(0);
  await user.click(screen.getByRole('button', { name: '显示加入信息' }));
  expect(await screen.findByText('mystry-panel-abc')).toBeTruthy();
  // The secret is displayed in groups of 4, what is copied is the original without spaces, and the notice echoes nothing beyond the full secret.
  expect(screen.getByText('abcd efgh ijkl mnop qrst uvwx yz')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '复制 网络密钥' }));
  expect(writeText).toHaveBeenCalledWith('abcdefghijklmnopqrstuvwxyz');
  expect(screen.getByRole('img', { name: '加入信息的二维码' })).toBeTruthy();
  expect(joinRequests).toBe(1);
  await user.click(screen.getByRole('button', { name: 'iPhone' }));
  expect(screen.getByText(/官方下载页没有 iPhone 客户端/)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '电脑' }));
  const command = screen.getByText(/easytier-core --dhcp --network-name "mystry-panel-abc"/).textContent ?? '';
  // EasyTier 2.6.4 rejects "--no-listener=true" (exit code 2) but requires a value for --private-mode.
  expect(command).toMatch(/--no-listener(?=\s)/);
  expect(command).not.toMatch(/--no-listener=/);
  expect(command).toMatch(/--private-mode=true/);
});

test('QR code matrix size, the three finder corners and the result are stable; Chinese content is not truncated', () => {
  const matrix = qrMatrix('https://192.168.2.163:3000/')!;
  // 27 bytes at error correction level M: version 2 fits only 26 bytes, so it is version 3, 29×29.
  expect(matrix.length).toBe(29);
  expect(matrix.every((row) => row.length === 29)).toBe(true);
  const finder = (top: number, left: number) => {
    for (let y = 0; y < 7; y += 1) {
      for (let x = 0; x < 7; x += 1) {
        const ring = y === 0 || y === 6 || x === 0 || x === 6;
        const core = y >= 2 && y <= 4 && x >= 2 && x <= 4;
        if (matrix[top + y]![left + x] !== (ring || core)) return false;
      }
    }
    return true;
  };
  expect(finder(0, 0)).toBe(true);
  expect(finder(0, 22)).toBe(true);
  expect(finder(22, 0)).toBe(true);
  expect(qrMatrix('https://192.168.2.163:3000/')).toEqual(matrix);
  expect(qrMatrix('https://192.168.2.164:3000/')).not.toEqual(matrix);
  // Chinese is encoded as UTF-8: there are more bytes than characters, and the matrix is larger than for ASCII of the same character count.
  expect(qrMatrix('网络密钥'.repeat(8))!.length).toBeGreaterThan(qrMatrix('abcd'.repeat(8))!.length);
  expect(qrMatrix('x'.repeat(5000))).toBeNull();
});

test('copy: without navigator.clipboard (insecure context) it falls back to execCommand, and returns false when neither works', async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  expect(await copyText('a')).toBe(true);
  expect(writeText).toHaveBeenCalledWith('a');

  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  const copied: string[] = [];
  document.execCommand = vi.fn((command: string) => {
    copied.push(`${command}:${(document.activeElement as HTMLTextAreaElement).value}`);
    return true;
  });
  const button = document.createElement('button');
  document.body.appendChild(button);
  button.focus();
  expect(await copyText('http://192.168.2.163:3000/')).toBe(true);
  expect(copied).toEqual(['copy:http://192.168.2.163:3000/']);
  // The temporary text box is removed right after use, and focus returns to the original button.
  expect(document.querySelector('textarea')).toBeNull();
  expect(document.activeElement).toBe(button);

  // It also falls back when the standard API is rejected.
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
  expect(await copyText('b')).toBe(true);
  document.execCommand = vi.fn(() => false);
  expect(await copyText('c')).toBe(false);
  button.remove();
});

// ---- Java picker: new instances auto-select the recommended version, with one-click install when it is missing ----

const java21 = { id: 'rt21', path: 'C:/Java/jdk-21/bin/java.exe', version: '21.0.5', majorVersion: 21, source: 'scan', verifiedAt: '2026-11-01T00:00:00Z', available: true };
const java8 = { id: 'rt8', path: 'C:/Java/jre8/bin/java.exe', version: '1.8.0_492', majorVersion: 8, source: 'scan', verifiedAt: '2026-11-01T00:00:00Z', available: true };

let installingStates: boolean[] = [];
function recordInstalling(installing: boolean) { installingStates.push(installing); }
function JavaSelectHarness({ autoSelect, initial = null, onValue }: { autoSelect?: boolean; initial?: string | null; onValue: (value: string | null) => void }) {
  const [value, setValue] = useState<string | null>(initial);
  const [mcVersion, setMcVersion] = useState('1.21.1');
  return (
    <>
      <JavaRuntimeSelect value={value} onChange={(next) => { onValue(next); setValue(next); }} mcVersion={mcVersion} autoSelect={autoSelect} onInstallingChange={recordInstalling} />
      <button type="button" onClick={() => setMcVersion('1.16.5')}>切到 1.16.5</button>
    </>
  );
}

function stubJava(state: { runtimes: unknown[]; installable: number[] }, extra?: (url: string, options?: RequestInit) => Response | null) {
  installingStates = [];
  const baseFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    const custom = extra?.(String(url), options);
    if (custom) return custom;
    if (String(url).startsWith('/api/system/java-runtimes')) return new Response(JSON.stringify(state));
    if (url === '/api/system/java') return new Response(JSON.stringify({ available: true, version: '1.8.0_492', majorVersion: 8 }));
    return baseFetch(url, options);
  }));
}

test('Java picker: a new instance auto-selects the recommended version, and no longer changes automatically after a manual change', async () => {
  stubJava({ runtimes: [java21, java8], installable: [8, 17, 21, 25] });
  const values: Array<string | null> = [];
  const user = userEvent.setup();
  render(<JavaSelectHarness autoSelect onValue={(value) => values.push(value)} />);
  const select = await screen.findByLabelText(/^Java 运行时/) as HTMLSelectElement;
  // The default Java is 8 and Minecraft 1.21.1 recommends 21: the installed Java 21 is selected automatically, and no install button appears.
  await waitFor(() => expect(select.value).toBe('rt21'));
  expect(screen.queryByRole('button', { name: /安装 Java/ })).toBeNull();
  // The recommended version is the one in use: "Recommended: Java 21" is no longer written, and the label does not carry it either.
  expect(screen.queryByText('推荐 Java 21')).toBeNull();
  expect(screen.getByRole('combobox', { name: 'Java 运行时' })).toBe(select);
  // Change to 1.16.5: the default Java 8 fits exactly, so it goes back to the default.
  await user.click(screen.getByRole('button', { name: '切到 1.16.5' }));
  await waitFor(() => expect(select.value).toBe(''));
  // After the user picks 21 by hand, it is no longer changed back automatically.
  await user.selectOptions(select, 'rt21');
  expect(select.value).toBe('rt21');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(select.value).toBe('rt21');
  expect(values.at(-1)).toBe('rt21');
  // The recommended Java 8 is already installed: the mismatch notice only asks to choose another, without a download link.
  expect(await screen.findByText(/所选 Java 是 Java 21，推荐使用 Java 8/)).toBeTruthy();
  expect(screen.queryByRole('link', { name: /下载 Java/ })).toBeNull();
});

test('Java picker: the instance settings page does not automatically change a saved choice', async () => {
  stubJava({ runtimes: [java21, java8], installable: [21] });
  const values: Array<string | null> = [];
  render(<JavaSelectHarness onValue={(value) => values.push(value)} />);
  const select = await screen.findByLabelText(/^Java 运行时/) as HTMLSelectElement;
  await screen.findByText(/系统默认 Java 是 Java 8/);
  expect(select.value).toBe('');
  expect(values).toEqual([]);
});

test('Java picker: one-click install when the recommended version is missing, and it is selected automatically once installed', async () => {
  const state = { runtimes: [java8] as unknown[], installable: [8, 17, 21, 25] };
  const installed = { ...java21, id: 'panel21', path: 'D:/data/runtimes/java/temurin-jdk-21.0.13_9/bin/java.exe', version: '21.0.13', source: 'panel' };
  const posted: unknown[] = [];
  stubJava(state, (url, options) => {
    if (url === '/api/system/java-runtimes/install' && options?.method === 'POST') {
      posted.push(JSON.parse(String(options.body)));
      return new Response(JSON.stringify({ id: 'install21', type: 'download', status: 'running', progress: 40, message: '', createdAt: '', updatedAt: '' }));
    }
    if (url === '/api/tasks/install21') {
      state.runtimes = [installed, java8];
      return new Response(JSON.stringify({ id: 'install21', type: 'download', status: 'completed', progress: 100, message: '', result: { javaRuntimeId: 'panel21' }, createdAt: '', updatedAt: '' }));
    }
    return null;
  });
  const values: Array<string | null> = [];
  const user = userEvent.setup();
  render(<JavaSelectHarness autoSelect onValue={(value) => values.push(value)} />);
  const button = await screen.findByRole('button', { name: '安装 Java 21' });
  expect(installingStates).toEqual([false]);
  // The status dot, recommended version, install button and manual download link sit on one row, in this order; the download source and size are only in the confirmation dialog.
  const row = button.closest('.java-status-row') as HTMLElement;
  expect([...row.children].map((child) => child.textContent)).toEqual(['系统默认 Java 1.8.0_492 可用', '推荐 Java 21', '安装 Java 21', '自己下载安装']);
  expect(screen.queryByText(/这台电脑还没装/)).toBeNull();
  // The manual download link is kept as a fallback.
  expect(screen.getByRole('link', { name: '自己下载安装' }).getAttribute('href')).toBe('https://adoptium.net/temurin/releases/?version=21');
  // Clicking the button first shows a confirmation stating the download source and size; clicking "Cancel" sends nothing.
  await user.click(button);
  let dialog = screen.getByRole('dialog', { name: '安装 Java 21？' });
  expect(within(dialog).getByText(/Eclipse Temurin.*40–60 MB.*下载期间可以取消/)).toBeTruthy();
  await user.click(within(dialog).getByRole('button', { name: '取消' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(posted).toEqual([]);
  expect(installingStates).toEqual([false]);
  // The download starts only after confirming.
  await user.click(button);
  dialog = screen.getByRole('dialog', { name: '安装 Java 21？' });
  await user.click(within(dialog).getByRole('button', { name: '安装 Java 21' }));
  const select = screen.getByLabelText(/^Java 运行时/) as HTMLSelectElement;
  await waitFor(() => expect(select.value).toBe('panel21'));
  expect(posted).toEqual([{ major: 21 }]);
  expect(values.at(-1)).toBe('panel21');
  // During the install the page is told to pause submission, and it resumes afterwards.
  await waitFor(() => expect(installingStates).toEqual([false, true, false]));
  expect(screen.queryByRole('button', { name: /安装 Java/ })).toBeNull();
});

test('Java picker: with no Java installed there is no orange warning, and the recommended version still follows the status dot', async () => {
  stubJava({ runtimes: [], installable: [] }, (url) => (
    url === '/api/system/java' ? new Response(JSON.stringify({ available: false })) : null
  ));
  render(<JavaSelectHarness autoSelect onValue={() => {}} />);
  const recommended = await screen.findByText('推荐 Java 21');
  expect(recommended.closest('.java-status-row')!.textContent).toContain('未找到系统默认 Java');
  expect(screen.queryByText(/推荐使用 Java/)).toBeNull();
  // When the panel cannot install it (installable lacks 21) there is no install button, only the download link.
  expect(screen.queryByRole('button', { name: /安装 Java/ })).toBeNull();
  expect(screen.getByRole('link', { name: '下载 Java 21' })).toBeTruthy();
});

test('Java picker: a download can be cancelled, no error is shown after cancelling, and the button returns to "Install Java 21"', async () => {
  let cancelRequested = false;
  const running = { id: 'install21', type: 'download', status: 'running', progress: 30, message: '', messageI18n: { key: 'server.jvm.javaInstall.downloading', params: { major: 21 } }, createdAt: '', updatedAt: '' };
  stubJava({ runtimes: [java8], installable: [21] }, (url, options) => {
    if (url === '/api/system/java-runtimes/install' && options?.method === 'POST') return new Response(JSON.stringify(running));
    if (url === '/api/system/java-runtimes/install/install21/cancel' && options?.method === 'POST') {
      cancelRequested = true;
      return new Response(JSON.stringify(running));
    }
    if (url === '/api/tasks/install21') {
      return new Response(JSON.stringify(cancelRequested
        ? { ...running, status: 'failed', message: 'Cancelled', messageI18n: { key: 'server.tasks.cancelled' }, error: 'x', errorI18n: { key: 'server.tasks.cancelledByUser' } }
        : running));
    }
    return null;
  });
  const user = userEvent.setup();
  render(<JavaSelectHarness autoSelect onValue={() => {}} />);
  await user.click(await screen.findByRole('button', { name: '安装 Java 21' }));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '安装 Java 21' }));

  // "Cancel install" is in the progress bar's text row, to the right of the percentage.
  const cancel = await screen.findByRole('button', { name: '取消安装' });
  expect(cancel.closest('.task-progress')).toBeTruthy();
  expect(screen.getByRole('progressbar', { name: 'Java 21 安装进度' })).toBeTruthy();
  // The text no longer writes a separate download percentage; there is only the one overall progress on the right.
  expect(cancel.closest('.task-progress-text')!.textContent).toBe('正在下载 Java 2130%取消安装');
  await user.click(cancel);
  expect(cancelRequested).toBe(true);
  expect((screen.getByRole('button', { name: '正在取消…' }) as HTMLButtonElement).disabled).toBe(true);

  // The next poll gets "cancelled": the progress bar collapses, no error is shown, and it can be installed again.
  await waitFor(() => expect(screen.queryByRole('progressbar')).toBeNull(), { timeout: 4000 });
  expect(screen.queryByText(/你取消了这个任务/)).toBeNull();
  expect(document.querySelector('p.error')).toBeNull();
  expect((screen.getByRole('button', { name: '安装 Java 21' }) as HTMLButtonElement).disabled).toBe(false);
  expect(installingStates.at(-1)).toBe(false);
});

test('Java picker: an install failure shows the reason and keeps the manual download entry', async () => {
  stubJava({ runtimes: [java8], installable: [21] }, (url, options) => {
    if (url === '/api/system/java-runtimes/install' && options?.method === 'POST') {
      return new Response(JSON.stringify({ id: 'install21', type: 'download', status: 'pending', progress: 0, message: '', createdAt: '', updatedAt: '' }));
    }
    if (url === '/api/tasks/install21') {
      return new Response(JSON.stringify({ id: 'install21', type: 'download', status: 'failed', progress: 10, message: '', error: 'x', errorI18n: { key: 'server.jvm.javaInstall.downloadFailed', params: { major: 21 } }, createdAt: '', updatedAt: '' }));
    }
    return null;
  });
  const user = userEvent.setup();
  render(<JavaSelectHarness autoSelect onValue={() => {}} />);
  await user.click(await screen.findByRole('button', { name: '安装 Java 21' }));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '安装 Java 21' }));
  expect(await screen.findByText(/Java 21 没能下载下来.*国内镜像/)).toBeTruthy();
  expect(screen.getByRole('button', { name: '安装 Java 21' })).toBeTruthy();
  expect(screen.getByRole('link', { name: '自己下载安装' })).toBeTruthy();
});

test('overview: an instance whose chosen Java is no longer available counts as abnormal, with the reason in the row and a link to instance settings', async () => {
  const baseFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => (
    url === '/api/instances'
      ? new Response(JSON.stringify([{ ...instance, id: 'gone', name: '旧服', javaRuntimeId: 'rt-gone', startIssue: { kind: 'java-unavailable', requiredJava: null } }]))
      : baseFetch(url, options)
  )));
  mount(<DashboardPage />);
  expect(await screen.findByText('这个服务器选择的 Java 已不可用')).toBeTruthy();
  expect(screen.getByRole('link', { name: '打开实例设置' }).getAttribute('href')).toBe('/instances/gone/settings');
  expect(screen.getByRole('button', { name: '异常 1' })).toBeTruthy();
});

test('instance page: when the chosen Java is no longer available a notice above the console asks to choose again, without a Java download link', async () => {
  const baseFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => (
    url === '/api/instances/test'
      ? new Response(JSON.stringify({ ...instance, name: '测试服', javaRuntimeId: 'rt-gone', startIssue: { kind: 'java-unavailable', requiredJava: null } }))
      : baseFetch(url, options)
  )));
  render(<RouterProvider router={createMemoryRouter(
    [{ path: '/instances/:id/*', element: <InstancePage /> }],
    { initialEntries: ['/instances/test'] },
  )} />);
  const banner = await screen.findByRole('alert');
  expect(banner.textContent).toContain('这个服务器选择的 Java 已不可用');
  expect(banner.textContent).toContain('重新选择 Java');
  expect(within(banner).getByRole('link', { name: '打开实例设置' }).getAttribute('href')).toBe('/instances/test/settings');
  expect(within(banner).queryByRole('link', { name: /下载/ })).toBeNull();
});

test('instance page header buttons follow the status: only "Start" while stopped, and stop, restart and force stop inside "⋯" while running', async () => {
  const user = userEvent.setup();
  const baseFetch = globalThis.fetch;
  let status = 'stopped';
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    const method = options?.method ?? 'GET';
    if (url === '/api/instances/test' && method === 'GET') return new Response(JSON.stringify({ ...instance, name: '测试服', status }));
    if (method === 'POST' && String(url).startsWith('/api/instances/test/') && !String(url).includes('console-ticket')) {
      calls.push(`${url} ${options?.body ?? ''}`.trim());
      return new Response('{}');
    }
    return baseFetch(url, options);
  }));
  const open = () => render(<RouterProvider router={createMemoryRouter(
    [{ path: '/instances/:id/*', element: <InstancePage /> }],
    { initialEntries: ['/instances/test'] },
  )} />);

  const stopped = open();
  expect(await screen.findByRole('button', { name: '启动' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: '停止' })).toBeNull();
  expect(screen.queryByRole('button', { name: '重启' })).toBeNull();
  expect(screen.queryByRole('button', { name: '更多操作' })).toBeNull();
  stopped.unmount();

  status = 'running';
  const running = open();
  expect(await screen.findByRole('button', { name: '停止' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: '启动' })).toBeNull();
  expect((screen.getByRole('button', { name: '重启' }) as HTMLButtonElement).disabled).toBe(false);
  await user.click(screen.getByRole('button', { name: '更多操作' }));
  await user.click(screen.getByRole('menuitem', { name: '强制停止' }));
  await user.click(within(screen.getByRole('dialog', { name: '强制停止实例「测试服」？' })).getByRole('button', { name: '确认强制停止' }));
  await waitFor(() => expect(calls).toEqual(['/api/instances/test/stop?force=1']));
  running.unmount();

  // While starting it can neither be stopped nor restarted; only force stop is left.
  status = 'starting';
  open();
  expect(await screen.findByRole('button', { name: '更多操作' })).toBeTruthy();
  expect((screen.getByRole('button', { name: '重启' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: '启动' })).toBeNull();
  expect(screen.queryByRole('button', { name: '停止' })).toBeNull();
});

test('instance settings: the instance can be deleted at the bottom of the page, not while it is not stopped; it can be deleted with unsaved changes too, returning to the overview afterwards', async () => {
  const user = userEvent.setup();
  const baseFetch = globalThis.fetch;
  let status = 'running';
  let failDelete = true;
  const deletes: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    const method = options?.method ?? 'GET';
    if (url === '/api/instances/test' && method === 'GET') {
      return new Response(JSON.stringify({ ...instance, name: '测试服', status, acceptEula: true, javaRuntimeId: null }));
    }
    if (method === 'DELETE') {
      deletes.push(String(url));
      return failDelete
        ? new Response(JSON.stringify({ error: '测试删除失败' }), { status: 500 })
        : new Response(JSON.stringify({ ok: true }));
    }
    return baseFetch(url, options);
  }));
  // A route navigation constructs Node's own Request with jsdom's AbortSignal, and the two do not accept each other; replaced with a stub carrying only the fields the router uses.
  vi.stubGlobal('Request', class {
    method = 'GET';
    headers = new Headers();
    signal: AbortSignal | undefined;
    constructor(public url: string, init?: { signal?: AbortSignal }) { this.signal = init?.signal; }
  });
  const open = () => render(<RouterProvider router={createMemoryRouter(
    [{ path: '/instances/:id/*', element: <InstancePage /> }, { path: '/', element: <p>总览页</p> }],
    { initialEntries: ['/instances/test/settings'] },
  )} />);

  const running = open();
  const blocked = await screen.findByRole('button', { name: '删除实例' }) as HTMLButtonElement;
  expect(blocked.disabled).toBe(true);
  expect(screen.getByText('实例仍在运行，请先停止后再删除')).toBeTruthy();
  running.unmount();

  status = 'stopped';
  open();
  const remove = await screen.findByRole('button', { name: '删除实例' }) as HTMLButtonElement;
  expect(remove.disabled).toBe(false);
  // Change one item without saving first: after deleting, leaving the page should no longer be blocked by "unsaved changes".
  await user.type(screen.getByRole('textbox', { name: '名称' }), '改');
  await user.click(remove);
  const dialog = screen.getByRole('dialog', { name: '删除实例「测试服」？' });
  const confirm = within(dialog).getByRole('button', { name: '永久删除' }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  await user.type(within(dialog).getByRole('textbox', { name: /请输入/ }), '测试服');
  await user.click(confirm);
  // Delete fails: the dialog stays open and the reason is shown inside it.
  expect((await within(dialog).findByRole('alert')).textContent).toContain('测试删除失败');
  expect(screen.queryByText('总览页')).toBeNull();
  failDelete = false;
  await user.click(within(dialog).getByRole('button', { name: '永久删除' }));
  expect(await screen.findByText('总览页')).toBeTruthy();
  expect(deletes).toEqual(['/api/instances/test', '/api/instances/test']);
});

test('multiplayer page: an instance that is not running can be started directly; with a problem to handle first it leads to the instance page', async () => {
  const user = userEvent.setup();
  const baseFetch = globalThis.fetch;
  let current: Record<string, unknown> = { ...instance, name: '测试服' };
  const starts: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/instances' && !options?.method) return new Response(JSON.stringify([current]));
    if (url === '/api/instances/test/start' && options?.method === 'POST') {
      starts.push(String(url));
      current = { ...current, status: 'starting' };
      return new Response('{}');
    }
    if (url === '/api/instances/test/local-network') {
      return new Response(JSON.stringify({ port: 25565, addresses: ['192.168.1.23'], publicIpv4: [], publicIpv6: [], publicHost: null, serverIpBlocked: false, serverIpIsUnboundPublicHost: false, panelPort: 3000, platform: 'win32' }));
    }
    return baseFetch(url, options);
  }));

  const first = mount(<MultiplayerPage />);
  expect(await screen.findByText('服务器没在运行，启动后玩家才能加入。')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '启动' }));
  await waitFor(() => expect(starts).toEqual(['/api/instances/test/start']));
  // The status is re-read right after the start request is sent: the notice changes to "Starting", the button collapses, and it cannot be clicked again.
  expect(await screen.findByText('服务器正在启动，启动完成后玩家才能加入。')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '启动' })).toBeNull();
  first.unmount();

  current = { ...instance, name: '测试服', startIssue: { kind: 'eula', requiredJava: null } };
  mount(<MultiplayerPage />);
  expect(await screen.findByText('服务器没在运行，要先处理一个问题才能启动。')).toBeTruthy();
  expect(screen.getByRole('link', { name: '打开实例' }).getAttribute('href')).toBe('/instances/test');
  expect(screen.queryByRole('button', { name: '启动' })).toBeNull();
});

test('task center: the entry shows no number when no task is running; a cancelled task says "Cancelled", not "Failed"', async () => {
  const user = userEvent.setup();
  const baseFetch = globalThis.fetch;
  const createdAt = new Date().toISOString();
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => (
    url === '/api/tasks'
      ? new Response(JSON.stringify({ tasks: [
        { id: 'cancelled', type: 'deploy', status: 'failed', progress: 40, message: 'Cancelled', messageI18n: { key: 'server.tasks.cancelled' }, error: 'You cancelled this task.', errorI18n: { key: 'server.tasks.cancelledByUser' }, createdAt },
        { id: 'broken', type: 'import', status: 'failed', progress: 10, message: 'Failed', messageI18n: { key: 'server.tasks.failed' }, error: '磁盘空间不足', createdAt },
      ] }))
      : baseFetch(url, options)
  )));
  mount(<TaskCenter />);
  const trigger = screen.getByRole('button', { name: /打开任务中心/ });
  await user.click(trigger);
  const cancelled = (await screen.findByText('你取消了这个任务')).closest('article') as HTMLElement;
  // There are two tasks in the history but both have ended: no number on the entry.
  expect(trigger.querySelector('.toolbar-badge')).toBeNull();
  expect(cancelled.className).toContain('status-cancelled');
  expect(within(cancelled).getAllByText('已取消')).toHaveLength(1);
  expect(within(cancelled).queryByText('失败')).toBeNull();
  expect(cancelled.querySelector('.task-card-error')).toBeNull();
  const broken = screen.getByText('磁盘空间不足').closest('article') as HTMLElement;
  expect(broken.className).toContain('status-failed');
  expect(within(broken).getAllByText('失败')).toHaveLength(1);
  expect(broken.querySelector('.task-card-error')?.textContent).toBe('磁盘空间不足');
});

test('backups page: the automatic backup row says why the last one failed, and the switch saves with the time and count already saved', async () => {
  const backup = { id: '20261026-010203-abcdef', instanceId: 'test', instanceName: '测试', source: 'scheduled', createdAt: '2026-10-26T01:02:03.000Z', sizeBytes: 2048, fileCount: 3, contentBytes: 4096, coreType: null, mcVersion: null, wasRunning: false, sha256: 'x' };
  let schedule = {
    enabled: false,
    time: '04:00',
    keep: 7,
    utcOffsetMinutes: -new Date().getTimezoneOffset() || 0,
    lastBackupAt: '2026-10-25T20:00:00.000Z',
    lastFailure: { at: '2026-10-26T20:00:00.000Z', error: 'x', errorI18n: { key: 'server.backups.schedule.diskSpace', params: { needed: 300, available: 100 } } },
  };
  const saved: unknown[] = [];
  const baseFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/instances/test/backups' && !options?.method) return new Response(JSON.stringify({ backups: [backup] }));
    if (url === '/api/instances/test/backup-schedule') {
      if (options?.method === 'PUT') {
        const body = JSON.parse(String(options.body));
        saved.push(body);
        // The schedule is read again after a save, so what was saved has to be what a read then returns.
        schedule = { ...schedule, ...body };
      }
      return new Response(JSON.stringify(schedule));
    }
    return baseFetch(url, options);
  }));
  const user = userEvent.setup();
  mount(<BackupsTab instance={instance as never} onRestored={() => {}} />);
  const toggle = await screen.findByRole('switch', { name: '每天定时备份' }) as HTMLInputElement;
  await waitFor(() => expect(toggle.disabled).toBe(false));
  expect(toggle.checked).toBe(false);
  expect(screen.getByText(/· 保留 7 份/)).toBeTruthy();
  const scheduleSection = toggle.closest('section') as HTMLElement;
  expect(within(scheduleSection).getByText('失败')).toBeTruthy();
  const failureAlert = within(scheduleSection).getByRole('alert');
  expect(failureAlert.textContent).toContain('上次定时备份失败');
  expect(failureAlert.textContent).toContain('磁盘空间不足：定时备份约需 300 字节，当前只剩 100 字节');
  expect(failureAlert.textContent).toContain('上一次成功：');
  // The backup list tags where an automatic backup came from.
  expect(screen.getByText('定时备份')).toBeTruthy();

  await user.click(toggle);
  await waitFor(() => expect(saved).toEqual([{ enabled: true, time: '04:00', keep: 7 }]));
  await waitFor(() => expect(toggle.checked).toBe(true));
});

test('backups page: a read of the automatic backup that was under way when the switch was saved does not put the old state back', async () => {
  const schedule = { enabled: true, time: '04:00', keep: 7, utcOffsetMinutes: 0, lastBackupAt: null, lastFailure: null };
  let enabled = true;
  let reads = 0;
  let answerHeldRead!: (response: Response) => void;
  const baseFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url !== '/api/instances/test/backup-schedule') return baseFetch(url, options);
    if (options?.method === 'PUT') {
      enabled = JSON.parse(String(options.body)).enabled;
      return new Response(JSON.stringify({ ...schedule, enabled }));
    }
    reads += 1;
    // The second read is the one still under way when the switch is turned off; it answers only at the end.
    if (reads === 2) return new Promise<Response>((resolve) => { answerHeldRead = resolve; });
    return new Response(JSON.stringify({ ...schedule, enabled }));
  }));
  const user = userEvent.setup();
  const view = mount(<BackupScheduleSection instanceId="test" scheduledCount={0} reloadSignal={0} />);
  const toggle = await screen.findByRole('switch', { name: '每天定时备份' }) as HTMLInputElement;
  await waitFor(() => expect(toggle.checked).toBe(true));

  // The backup list was read again, as after a backup ends, and the schedule with it.
  view.rerender(<MemoryRouter><BackupScheduleSection instanceId="test" scheduledCount={0} reloadSignal={1} /><Location /></MemoryRouter>);
  await waitFor(() => expect(reads).toBe(2));
  await user.click(toggle);
  await waitFor(() => expect(toggle.checked).toBe(false));
  // The read made after the save is the one that counts from here on.
  await waitFor(() => expect(reads).toBe(3));

  await act(async () => {
    answerHeldRead(new Response(JSON.stringify({ ...schedule, enabled: true })));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(toggle.checked).toBe(false);
  expect(toggle.disabled).toBe(false);
});

test('backups page: the clock of the panel computer is named by its offset from UTC, to the minute', async () => {
  const schedule = { enabled: true, time: '04:00', keep: 7, lastBackupAt: null, lastFailure: null };
  let utcOffsetMinutes = 0;
  const baseFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => (
    url === '/api/instances/test/backup-schedule'
      ? new Response(JSON.stringify({ ...schedule, utcOffsetMinutes }))
      : baseFetch(url, options)
  )));
  const user = userEvent.setup();
  const cases: Array<[number, string]> = [[0, 'UTC'], [480, 'UTC+8'], [-300, 'UTC-5'], [345, 'UTC+5:45'], [-210, 'UTC-3:30']];
  for (const [offset, label] of cases) {
    utcOffsetMinutes = offset;
    const view = mount(<BackupScheduleSection instanceId="test" scheduledCount={0} reloadSignal={0} />);
    await user.click(await screen.findByRole('button', { name: '修改计划' }));
    expect(screen.getByText(`按面板所在电脑的时间（${label}）。`)).toBeTruthy();
    view.unmount();
  }
});

test('backups page: keeping fewer automatic backups than there are asks first, and saves only after confirming', async () => {
  const backups = ['20261024-040000-aaaaaa', '20261025-040000-bbbbbb', '20261026-040000-cccccc'].map((id, index) => (
    { id, instanceId: 'test', instanceName: '测试', source: 'scheduled', createdAt: `2026-10-2${4 + index}T04:00:00.000Z`, sizeBytes: 2048, fileCount: 3, contentBytes: 4096, coreType: null, mcVersion: null, wasRunning: false, sha256: 'x' }
  ));
  let schedule = { enabled: true, time: '04:00', keep: 7, utcOffsetMinutes: 0, lastBackupAt: '2026-10-26T04:00:00.000Z', lastFailure: null };
  const saved: unknown[] = [];
  const baseFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/instances/test/backups' && !options?.method) return new Response(JSON.stringify({ backups }));
    if (url === '/api/instances/test/backup-schedule') {
      if (options?.method === 'PUT') {
        const body = JSON.parse(String(options.body));
        saved.push(body);
        schedule = { ...schedule, ...body };
      }
      return new Response(JSON.stringify(schedule));
    }
    return baseFetch(url, options);
  }));
  const user = userEvent.setup();
  mount(<BackupsTab instance={instance as never} onRestored={() => {}} />);
  await user.click(await screen.findByText('修改计划'));
  const keep = screen.getByLabelText('保留份数') as HTMLInputElement;
  expect(keep.value).toBe('7');
  expect((screen.getByLabelText('备份时间') as HTMLInputElement).value).toBe('04:00');
  const save = screen.getByRole('button', { name: '保存计划' }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);

  await user.clear(keep);
  await user.type(keep, '2');
  await user.click(save);
  const dialog = screen.getByRole('dialog', { name: '只保留最新的 2 份定时备份？' });
  expect(dialog.textContent).toContain('这个服务器现有 3 份定时备份');
  expect(saved).toEqual([]);
  await user.click(within(dialog).getByRole('button', { name: '保留 2 份' }));
  await waitFor(() => expect(saved).toEqual([{ enabled: true, time: '04:00', keep: 2 }]));
  expect(await screen.findByText('计划已保存')).toBeTruthy();

  // A count that deletes nothing is saved without asking.
  await user.clear(keep);
  await user.type(keep, '9');
  await user.click(save);
  await waitFor(() => expect(saved).toEqual([{ enabled: true, time: '04:00', keep: 2 }, { enabled: true, time: '04:00', keep: 9 }]));
  expect(screen.queryByRole('dialog')).toBeNull();

  await user.clear(keep);
  await user.type(keep, '0');
  await user.tab();
  expect(screen.getByText('填写 1–365 之间的整数')).toBeTruthy();
  expect(save.disabled).toBe(true);
});

test('backups page: row download and restore move into the overflow menu on narrow screens', async () => {
  const backup = { id: '20261026-010203-abcdef', instanceId: 'test', instanceName: '测试', source: 'manual', createdAt: '2026-10-26T01:02:03.000Z', sizeBytes: 2048, fileCount: 3, contentBytes: 4096, coreType: null, mcVersion: null, wasRunning: false, sha256: 'x' };
  const baseFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/instances/test/backups' && !options?.method) return new Response(JSON.stringify({ backups: [backup] }));
    return baseFetch(url, options);
  }));
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: query === '(max-width: 768px)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })));
  const user = userEvent.setup();
  mount(<BackupsTab instance={instance as never} onRestored={() => {}} />);
  const menuTrigger = await screen.findByRole('button', { name: /的备份操作$/ });
  expect(screen.queryByRole('button', { name: '还原' })).toBeNull();
  expect(screen.queryByRole('button', { name: '下载' })).toBeNull();
  await user.click(menuTrigger);
  expect(screen.getByRole('menuitem', { name: '下载' })).toBeTruthy();
  expect(screen.getByRole('menuitem', { name: '还原' })).toBeTruthy();
  expect(screen.getByRole('menuitem', { name: '删除' })).toBeTruthy();
});

test('files: a binary file opens read-only with a warning and no Save, while a text file still opens for editing', async () => {
  const modifiedAt = '2026-11-25T08:00:00.000Z';
  const baseFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/instances/test/files?path=') {
      return new Response(JSON.stringify([
        { name: 'level.dat', path: 'level.dat', isDirectory: false, size: 10, modifiedAt },
        { name: 'notes.txt', path: 'notes.txt', isDirectory: false, size: 5, modifiedAt },
      ]));
    }
    if (url === '/api/instances/test/files/content?path=level.dat') {
      return new Response(JSON.stringify({ path: 'level.dat', content: '\u001f\uFFFD\b\u0000', binary: true }));
    }
    if (url === '/api/instances/test/files/content?path=notes.txt') {
      return new Response(JSON.stringify({ path: 'notes.txt', content: 'hello', binary: false }));
    }
    return baseFetch(url, options);
  }));
  const user = userEvent.setup();
  mount(<FilesTab instanceId="test" />);
  const dialog = () => within(document.querySelector<HTMLElement>('.file-edit-dialog')!);

  await user.click(await screen.findByTitle('编辑 level.dat'));
  expect(await dialog().findByText('这是二进制文件，保存会把它写坏，所以这里只能查看。')).toBeTruthy();
  expect(dialog().getByRole<HTMLTextAreaElement>('textbox', { name: '文件内容：level.dat' }).readOnly).toBe(true);
  expect(dialog().queryByRole('button', { name: '保存' })).toBeNull();
  await user.click(dialog().getByRole('button', { name: '关闭', exact: true }));
  expect(document.querySelector<HTMLDialogElement>('.file-edit-dialog')!.open).toBe(false);

  await user.click(screen.getByTitle('编辑 notes.txt'));
  const textarea = await dialog().findByRole<HTMLTextAreaElement>('textbox', { name: '文件内容：notes.txt' });
  expect(textarea.readOnly).toBe(false);
  expect(dialog().queryByText(/二进制文件/)).toBeNull();
  const save = dialog().getByRole<HTMLButtonElement>('button', { name: '保存' });
  expect(save.disabled).toBe(true);
  await user.type(textarea, '!');
  expect(save.disabled).toBe(false);
});
