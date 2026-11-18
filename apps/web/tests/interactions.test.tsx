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
import { InstancePage } from '../src/pages/InstancePage';
import { MultiplayerPage } from '../src/pages/MultiplayerPage';
import { TaskCenter } from '../src/components/TaskCenter';
import { ConsolePanel } from '../src/components/ConsolePanel';
import { BackupsTab } from '../src/components/BackupsTab';
import { ConfigTab } from '../src/components/ConfigTab';
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
    // 与 xterm 一致：只有值真正变化时才重建读屏层，这里记录每次变化。
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
  // 这组回归按中文原文查元素，固定界面语言为 zh-CN；语言切换与英文文案见 i18n.test.tsx。
  document.documentElement.lang = 'zh-CN'; document.documentElement.dataset.localePreference = 'zh-CN';
  requests = []; nodes = []; failNodes = false; terminal.text = ''; terminal.written = ''; terminal.created = []; terminal.srChanges = []; terminal.current = null;
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} });
  // jsdom 不实现原生模态层；此替身仅验证开关状态与应用的焦点恢复逻辑。
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
      : String(url).includes('/import/sources') ? { sources: [] }
      : String(url).includes('java-runtimes') ? { runtimes: [], defaultRuntime: null }
      : {};
    return new Response(JSON.stringify(data));
  }));
  vi.stubGlobal('WebSocket', class { close() {} });
});

test('总览监测保留过期数据，重试恢复，异常筛选可清除', async () => {
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
  // 可见状态行与读屏播报区各有一份错误文本。
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

test('总览每行给出状态说明和下一步，没有实例时只保留三种添加方式', async () => {
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
  expect(await screen.findByText('可以进服了')).toBeTruthy();
  expect(screen.getByRole('link', { name: '邀请玩家' }).getAttribute('href')).toBe('/multiplayer?instance=ready');
  expect(screen.getByText('这个服务器需要 Java 21')).toBeTruthy();
  expect(screen.getByRole('link', { name: '打开实例设置' }).getAttribute('href')).toBe('/instances/java/settings');
  expect(screen.getByRole('link', { name: '查看并同意' }).getAttribute('href')).toBe('/instances/eula');
  // 未同意 EULA 而停下的实例也算异常。
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
  // 顶部不再重复一套创建按钮。
  expect(screen.getAllByRole('link', { name: /一键部署/ })).toHaveLength(1);
  await user.click(paths.getByRole('button', { name: /创建空实例/ }));
  expect(screen.getByRole('dialog', { name: '创建空实例' })).toBeTruthy();
});

test('监测在隐藏页暂停，回到前台刷新，卸载后停止请求', async () => {
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

test('导航菜单禁用主内容和顶栏右侧，Escape 后解除并恢复入口焦点', async () => {
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

test('导航菜单关闭按钮可点，点击后关菜单并恢复入口焦点', async () => {
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

test('打开导航菜单后点击导航会跳转并关闭菜单', async () => {
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

test('实例操作按钮按 Enter 只执行操作，名称链接仍可导航', async () => {
  const user = userEvent.setup();
  mount(<DashboardPage />);
  const start = await screen.findByRole('button', { name: '启动', exact: true });
  start.focus(); await user.keyboard('{Enter}');
  await waitFor(() => expect(requests).toContain('/api/instances/test/start'));
  expect(screen.getByTestId('location').textContent).toBe('/');
  await user.click(screen.getByRole('link', { name: instance.name }));
  expect(screen.getByTestId('location').textContent).toBe('/instances/test');
});

test('更多操作菜单挂到 body，方向键移动，Escape 恢复焦点，选择后打开确认弹窗', async () => {
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

test('任务抽屉关闭时不可访问，按钮、Escape 和遮罩关闭均恢复入口焦点', async () => {
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

test('部署页默认 Paper 与最新正式版，EULA 需主动勾选，Build 留空交给服务端取最新', async () => {
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
  // 26.3 需要 Java 25，这台电脑没有：不能开始部署，并说明原因。
  expect(await screen.findByRole('button', { name: '先安装或选择 Java 25' })).toBeTruthy();
  expect(submit.disabled).toBe(true);
  // 装好 Java 25 后重新扫描：自动选中，按钮可用。
  javaRuntimes = [java25];
  await user.click(screen.getByRole('button', { name: '重新扫描' }));
  await waitFor(() => expect(submit.disabled).toBe(false));
  expect(screen.queryByText(/先安装或选择 Java 25/)).toBeNull();
  // 取消同意后按钮变灰，操作栏说明要先勾选 EULA；再勾上恢复。
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

test('ZIP 按钮可用键盘触发，选择与拖放拒绝非 ZIP 并允许重新选择', async () => {
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

test('恢复预览和上传期间锁定 ZIP 选择与拖放', async () => {
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

test('节点页展示空态，失败后可主动重试恢复真实离线状态', async () => {
  const user = userEvent.setup();
  mount(<NodesPage />);
  expect(await screen.findByText('暂无节点。')).toBeTruthy();
  failNodes = true;
  await user.click(screen.getByRole('button', { name: '刷新节点' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  failNodes = false;
  nodes = [{ id: 'local', isLocal: true, name: '本机', status: 'offline', instanceCount: 0 }];
  await user.click(screen.getByRole('button', { name: '重试加载' }));
  expect(await screen.findByText('离线')).toBeTruthy();
  expect(screen.queryByText(/健康运转中/)).toBeNull();
});

test('本机环境页切换下载来源：失败时保留原选择，成功后显示说明', async () => {
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
  mount(<NodesPage />);
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

test('复制日志提供空日志、权限拒绝、API 缺失与成功反馈', async () => {
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

test('控制台断线重连后用历史快照替换旧日志，不重复输出', async () => {
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

test('节点轮询失败保留旧数据并标记可能过期', async () => {
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

test('复制提示计时器在控制台卸载时清理', async () => {
  vi.useFakeTimers();
  const view = mount(<ConsolePanel instanceId="test" />);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '复制日志' })));
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test('备份页：运行中禁用还原；还原弹窗默认先备份当前文件，取消勾选时提示无法撤销', async () => {
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
  await user.click(await screen.findByRole('button', { name: /的备份操作$/ }));
  expect((screen.getByRole('menuitem', { name: '还原' }) as HTMLButtonElement).disabled).toBe(true);
  await user.keyboard('{Escape}');
  view.unmount();

  mount(<BackupsTab instance={instance as never} onRestored={() => {}} />);
  await user.click(await screen.findByRole('button', { name: /的备份操作$/ }));
  await user.click(screen.getByRole('menuitem', { name: '还原' }));
  const dialog = screen.getByRole('dialog', { name: '还原这个备份？' });
  const checkbox = screen.getByRole('checkbox', { name: '先备份当前文件' }) as HTMLInputElement;
  expect(checkbox.checked).toBe(true);
  await user.click(checkbox);
  expect(dialog.textContent).toContain('无法撤销');
  await user.click(checkbox);
  await user.click(screen.getByRole('button', { name: '还原', exact: true }));
  await waitFor(() => expect(posted).toEqual([{ url: '/api/instances/test/backups/20261026-010203-abcdef/restore', body: { backupCurrent: true } }]));
  expect(await screen.findByText('备份已还原')).toBeTruthy();
});

test('备份页：还原后实例记录按备份更新时给出说明', async () => {
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
  await user.click(await screen.findByRole('button', { name: /的备份操作$/ }));
  await user.click(screen.getByRole('menuitem', { name: '还原' }));
  await user.click(screen.getByRole('button', { name: '还原', exact: true }));
  expect(await screen.findByText(/服务端文件、核心类型和版本已按备份更新/)).toBeTruthy();
  expect(onRestored).toHaveBeenCalledTimes(1);
});

test('删除实例默认连同备份删除，取消勾选时带 keepBackups=1 并提示备份去向', async () => {
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

test('部署页版本下拉：名称由可见标签加当前值组成，键盘可选择并回到触发按钮', async () => {
  const baseFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/cores/paper/versions') return new Response(JSON.stringify({ versions: ['26.3', '26.2', '1.21.11'] }));
    return baseFetch(url, options);
  }));
  // jsdom 未实现 scrollIntoView，键盘移动活动项时会调用它。
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

/** jsdom 没有真实布局：按桌面实测尺寸模拟下拉面板（每项 34px、提示与内边距 44px、上限 400px）。 */
function mockLazySelectLayout() {
  const contentHeight = (el: HTMLElement) => el.querySelectorAll('[role="option"]').length * 34 + 44;
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return contentHeight(this);
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return Math.min(contentHeight(this), 400);
  });
}

test('部署页版本下拉：首屏填不满面板时继续加载，滚动后能用鼠标选到靠后的版本', async () => {
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
  // 10 项只有 384px，放不满 400px 的面板；加载到 20 项出现滚动条后必须停下，不能一次全部渲染。
  expect(within(listbox).getAllByRole('option')).toHaveLength(20);
  expect(listbox.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: '1.0' }).id);

  listbox.scrollTop = listbox.scrollHeight - listbox.clientHeight;
  fireEvent.scroll(listbox);
  expect(within(listbox).getAllByRole('option')).toHaveLength(30);
  await user.click(screen.getByRole('option', { name: '1.25' }));
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(screen.getByRole('button', { name: '游戏版本 1.25' })).toBeTruthy();
});

test('部署页 Paper 构建下拉：展开后才到达的选项同样填满面板', async () => {
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

test('总览例行刷新不进 live region，只播报出错与恢复', async () => {
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
  // 例行轮询不切换刷新按钮的禁用状态，避免聚焦在按钮上的键盘用户被打断。
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

test('确认弹窗的操作错误显示在弹窗内，以 alert 播报并关联为描述', async () => {
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

test('控制台读屏模式可开关并记住，历史写完和发送命令前重置朗读区', async () => {
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
  // 着色与历史替换不受影响；历史写完后关再开一次，清空 xterm 的朗读计数。
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

test('参数配置遇到选项之外的值时原样显示，不误显示成第一项', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ difficulty: '9', gamemode: 'creative' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )));
  // useBlocker 需要数据路由，这里不能用 MemoryRouter。
  const router = createMemoryRouter([{ path: '/', element: <ConfigTab instanceId="test" /> }]);
  render(<RouterProvider router={router} />);

  const difficulty = await screen.findByRole('combobox', { name: '难度' }) as HTMLSelectElement;
  await waitFor(() => expect(difficulty.value).toBe('9'));
  expect(within(difficulty).getByRole('option', { name: '9' })).toBeTruthy();
  const gamemode = screen.getByRole('combobox', { name: '默认游戏模式' }) as HTMLSelectElement;
  expect(gamemode.value).toBe('creative');
  expect(within(gamemode).queryByRole('option', { name: 'creative' })).toBeNull();
});

// 参数配置的测试共用：按给定文件内容挂载，并记下保存时提交的内容。
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

test('参数配置：文件里没写的键显示游戏默认值，拨回默认值不算修改，保存时只写改过的键', async () => {
  const user = userEvent.setup();
  const saves = mountConfigTab({ motd: 'Imported', 'server-port': '25565' });

  const onlineMode = await screen.findByRole('switch', { name: '正版验证（在线模式）' }) as HTMLInputElement;
  await waitFor(() => expect(onlineMode.disabled).toBe(false));
  // 开关和下拉按默认值显示，数字和文本框把默认值放在占位字里，输入框本身是空的。
  expect(onlineMode.checked).toBe(true);
  expect((screen.getByRole('switch', { name: '启用白名单' }) as HTMLInputElement).checked).toBe(false);
  const difficulty = screen.getByRole('combobox', { name: '难度' }) as HTMLSelectElement;
  expect(difficulty.value).toBe('easy');
  expect(within(difficulty).getByRole('option', { name: '简单（默认）' })).toBeTruthy();
  expect(within(difficulty).queryByRole('option', { name: '请选择' })).toBeNull();
  const maxPlayers = screen.getByRole('spinbutton', { name: '最大在线人数' }) as HTMLInputElement;
  expect(maxPlayers.value).toBe('');
  expect(maxPlayers.placeholder).toBe('20');
  expect((screen.getByRole('textbox', { name: '世界种子' }) as HTMLInputElement).placeholder).toBe('随机');
  const save = screen.getByRole('button', { name: '保存配置' }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);

  // 拨离默认值算修改，拨回去又回到没改。
  await user.click(onlineMode);
  expect(onlineMode.checked).toBe(false);
  expect(save.disabled).toBe(false);
  await user.click(onlineMode);
  expect(onlineMode.checked).toBe(true);
  expect(save.disabled).toBe(true);
  await user.selectOptions(difficulty, 'hard');
  expect(save.disabled).toBe(false);
  await user.selectOptions(difficulty, 'easy');
  expect(save.disabled).toBe(true);
  // 数字框填了再清空同样回到没改。
  await user.type(maxPlayers, '8');
  expect(save.disabled).toBe(false);
  await user.clear(maxPlayers);
  expect(save.disabled).toBe(true);

  // 显示出来的默认值不会跟着写进文件。
  await user.selectOptions(difficulty, 'hard');
  await user.click(save);
  await waitFor(() => expect(saves).toEqual([{ motd: 'Imported', 'server-port': '25565', difficulty: 'hard' }]));
});

test('参数配置：文件里值留空的键按服务端实际生效的情况显示', async () => {
  mountConfigTab({ difficulty: '', 'online-mode': '', 'max-players': '', motd: '', 'level-seed': '' });

  const difficulty = await screen.findByRole('combobox', { name: '难度' }) as HTMLSelectElement;
  // 下拉项和数字留空时服务端用默认值，开关留空等于关，文本留空就是空的（世界种子留空是随机）。
  await waitFor(() => expect(difficulty.value).toBe('easy'));
  expect(within(difficulty).queryByRole('option', { name: '请选择' })).toBeNull();
  expect((screen.getByRole('switch', { name: '正版验证（在线模式）' }) as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole('spinbutton', { name: '最大在线人数' }) as HTMLInputElement).placeholder).toBe('20');
  expect((screen.getByRole('textbox', { name: '服务器简介' }) as HTMLInputElement).placeholder).toBe('');
  expect((screen.getByRole('textbox', { name: '世界种子' }) as HTMLInputElement).placeholder).toBe('随机');
  expect((screen.getByRole('button', { name: '保存配置' }) as HTMLButtonElement).disabled).toBe(true);
});

test('参数配置：已有的数字项可以清空保存，填了超范围的值仍然拦住', async () => {
  const user = userEvent.setup();
  const saves = mountConfigTab({ 'view-distance': '12', 'server-port': '25570' });

  const view = await screen.findByRole('spinbutton', { name: '视距（区块）' }) as HTMLInputElement;
  await waitFor(() => expect(view.value).toBe('12'));
  const port = screen.getByRole('spinbutton', { name: '服务器端口' }) as HTMLInputElement;
  const save = screen.getByRole('button', { name: '保存配置' }) as HTMLButtonElement;

  // 清空后不报错，占位字是服务端会用的默认值。
  await user.clear(view);
  await user.clear(port);
  expect(view.getAttribute('aria-invalid')).toBeNull();
  expect(view.placeholder).toBe('10');
  expect(port.placeholder).toBe('25565');
  expect(save.disabled).toBe(false);

  await user.type(view, '99');
  expect(view.getAttribute('aria-invalid')).toBe('true');
  expect(save.disabled).toBe(true);
  expect(screen.getByRole('status').textContent).toBe('先修正「视距（区块）」');

  await user.clear(view);
  await user.click(save);
  await waitFor(() => expect(saves).toEqual([{ 'view-distance': '', 'server-port': '' }]));
});

test('参数配置：文件读取失败时不把游戏默认值当成文件内容显示', async () => {
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
  expect((screen.getByRole('spinbutton', { name: '最大在线人数' }) as HTMLInputElement).placeholder).toBe('');
  expect((screen.getByRole('textbox', { name: '世界种子' }) as HTMLInputElement).placeholder).toBe('');
});

test('参数配置：按实例游戏版本隐藏已改成游戏规则的项，文件里的旧值保存时原样带回', async () => {
  const user = userEvent.setup();
  const saves = mountConfigTab({ motd: 'Old', pvp: 'false', 'spawn-animals': 'false' }, '26.3');

  const motd = await screen.findByRole('textbox', { name: '服务器简介' }) as HTMLInputElement;
  await waitFor(() => expect(motd.value).toBe('Old'));
  for (const name of ['玩家对战（PVP）', '开启下界', '生成怪物', '生成动物']) {
    expect(screen.queryByRole('switch', { name })).toBeNull();
  }
  // 藏起来的键不出现在「高级选项」里，两个分组末尾说明去哪里设置。
  expect(screen.queryByLabelText('pvp')).toBeNull();
  expect(screen.queryByLabelText('spawn-animals')).toBeNull();
  expect(screen.getAllByText('/gamerule')).toHaveLength(2);
  expect(screen.getByRole('switch', { name: '正版验证（在线模式）' })).toBeTruthy();

  await user.clear(motd);
  await user.type(motd, 'New');
  await user.click(screen.getByRole('button', { name: '保存配置' }));
  await waitFor(() => expect(saves).toEqual([{ motd: 'New', pvp: 'false', 'spawn-animals': 'false' }]));
});

test('参数配置：旧版本和版本未知时不隐藏仍在用的项', async () => {
  mountConfigTab({ motd: 'Old' }, '1.21.8');
  // 1.21.8：生成动物已在 1.21.2 移除，其余三项到 1.21.9 才移除。
  const pvp = await screen.findByRole('switch', { name: '玩家对战（PVP）' }) as HTMLInputElement;
  await waitFor(() => expect(pvp.disabled).toBe(false));
  expect(pvp.checked).toBe(true);
  expect(screen.getByRole('switch', { name: '开启下界' })).toBeTruthy();
  expect(screen.getByRole('switch', { name: '生成怪物' })).toBeTruthy();
  expect(screen.queryByRole('switch', { name: '生成动物' })).toBeNull();
  expect(screen.queryByText('/gamerule')).toBeNull();
  cleanup();

  // 快照号、自定义 Jar 等认不出版本的实例全部照常显示。
  for (const version of [undefined, '25w35a']) {
    mountConfigTab({ motd: 'Old' }, version);
    expect(await screen.findByRole('switch', { name: '生成动物' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: '玩家对战（PVP）' })).toBeTruthy();
    expect(screen.queryByText('/gamerule')).toBeNull();
    cleanup();
  }
});

test('未同意 EULA 的启动失败给出提示，「同意并启动」先保存同意再启动', async () => {
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

test('Java 版本不符的启动失败给出需要的版本、下载链接和实例设置入口', async () => {
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

test('服务器完成启动后提示可以进服并指向联机；点「不再提示」后不再出现', async () => {
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

  // 还在加载世界时不提示。
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

  // 关掉后重新打开页面也不再出现。
  open();
  expect(await screen.findByRole('heading', { name: '测试服' })).toBeTruthy();
  expect(screen.queryByText('服务器已启动，现在可以进服了。')).toBeNull();
});

test('从本机文件夹导入时带出识别到的核心类型和 Minecraft 版本', async () => {
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

test('联机页默认「直接连接」：列出可复制的地址，并能转到虚拟局域网', async () => {
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
  // 实例没在运行时先提示启动。
  expect(screen.getByText('服务器没在运行，启动后玩家才能加入。')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '复制 192.168.1.23:25565' }));
  expect(writeText).toHaveBeenCalledWith('192.168.1.23:25565');
  expect(await screen.findByText('已复制 192.168.1.23:25565。')).toBeTruthy();
  // 有公网 IPv6 时另给一个带方括号的地址，并提醒只放行端口。
  expect(screen.getByText('IPv6 加入地址')).toBeTruthy();
  expect(screen.getByText(/只放行这台电脑的 25565 端口/)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '复制 [2408:8207:ab::10]:25565' }));
  expect(writeText).toHaveBeenCalledWith('[2408:8207:ab::10]:25565');
  await user.click(screen.getByRole('button', { name: '改用虚拟局域网' }));
  expect(await screen.findByRole('button', { name: '虚拟局域网', pressed: true })).toBeTruthy();
});

test('联机页指引栏可以关闭并记住；客户端未安装时手动安装默认收起', async () => {
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
  // 被点的按钮消失后，焦点交给接替它的按钮。
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '显示指引' }));
  await user.click(screen.getByRole('button', { name: '显示指引' }));
  expect(screen.getByRole('heading', { name: '指引' })).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '关闭指引' }));
  expect(localStorage.getItem('mystry_multiplayer_guide')).toBeNull();

  await user.click(screen.getByRole('button', { name: '虚拟局域网' }));
  expect(await screen.findByText('未安装 EasyTier 客户端。')).toBeTruthy();
  // 没装客户端时只留安装提示，开关和中继节点等装好再出现。
  expect(screen.queryByRole('switch', { name: '对玩家开放这个实例' })).toBeNull();
  expect(screen.queryByText('中继节点')).toBeNull();
  expect(screen.queryByText(/SHA-256 一致才会安装/)).toBeNull();
  await user.click(screen.getByRole('button', { name: '手动安装' }));
  expect(screen.getByText(/SHA-256 一致才会安装/)).toBeTruthy();
  expect(screen.getByRole('button', { name: '上传压缩包' })).toBeTruthy();
});

test('虚拟局域网开关立即保存，只带服务端已保存的中继节点；失败时开关回到原位', async () => {
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
  // 已经填过自己的中继节点：折叠区默认展开，不藏着已生效的设置。
  expect((screen.getByText('中继节点').closest('details') as HTMLDetailsElement).open).toBe(true);
  // 文本框里没保存的改动不会被开关带走。
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

  // 中继节点单独保存，带上服务端当前的开关；开着时提醒重新发加入说明。
  await user.click(screen.getByRole('button', { name: '保存中继节点' }));
  expect(await screen.findByText('中继节点已保存。要把新的加入说明重新发给玩家。')).toBeTruthy();
  expect(JSON.parse(bodies[2])).toEqual({ enabled: true, peers: ['tcp://relay.example.com:11010', 'tcp://draft.example.com:11010'], useSharedPeers: true });
});

test('frp 第一次保存穿透设置就是「保存并开放」，之后穿透设置收进折叠区', async () => {
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
  // 还没保存过穿透设置：没有开关，按钮直接是「保存并开放」。
  const saveOpen = await screen.findByRole('button', { name: '保存并开放' });
  expect(screen.queryByRole('switch', { name: '对玩家开放这个实例' })).toBeNull();
  await user.click(saveOpen);
  expect(await screen.findByText('frp.example.com:25565')).toBeTruthy();
  expect(JSON.parse(bodies[0])).toEqual({ enabled: true, endpointId: 'e1', mode: 'public', remotePort: 25565, visitorBindPort: 25566 });
  const toggle = screen.getByRole('switch', { name: '对玩家开放这个实例' }) as HTMLInputElement;
  expect(toggle.checked).toBe(true);
  expect((screen.getByText('穿透设置').closest('details') as HTMLDetailsElement).open).toBe(false);

  // 之后用开关关掉，带的是服务端已保存的设置。
  await user.click(toggle);
  await waitFor(() => expect(bodies).toHaveLength(2));
  expect(JSON.parse(bodies[1])).toEqual({ enabled: false, endpointId: 'e1', mode: 'public', remotePort: 25565, visitorBindPort: 25566 });
});

test('修改密码成功后换上新令牌并说明其他设备需重新登录', async () => {
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

test('令牌已换发时，旧令牌请求返回的 401 不会清掉新令牌', async () => {
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

    // 当前令牌本身被拒绝时照常退出登录。
    const current = api('/api/system/metrics').catch((error: unknown) => error);
    respond(new Response(JSON.stringify({ error: 'expired', code: 'server.common.unauthorized' }), { status: 401 }));
    await current;
    expect(getToken()).toBeNull();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  } finally {
    window.removeEventListener('mystry:unauthorized', onUnauthorized);
  }
});

test('联机页公网直连：填写公网地址后给出「地址:游戏端口」和检查清单', async () => {
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
  // 局域网地址的标题始终写明「同一网络」；没有公网地址时不显示公网卡片，Linux 上不显示 Windows 弹窗提示。
  expect(screen.getByText('同一网络的加入地址')).toBeTruthy();
  expect(screen.queryByText('公网加入地址')).toBeNull();
  expect(screen.queryByText(/Windows 可能弹窗/)).toBeNull();
  await user.click(screen.getByRole('button', { name: '填写公网地址' }));
  const input = screen.getByLabelText('公网 IP 或域名');
  await user.type(input, '192.168.1.5');
  expect(screen.getByText('这像是内网地址，其他网络的玩家连不上。')).toBeTruthy();
  await user.clear(input);
  await user.type(input, '203.0.113.10:25570');
  // 带端口时不用等服务端报错：输入框下直接说明，保存按钮不可点。
  expect(await screen.findByText(/端口不用填，会自动用服务器的游戏端口/)).toBeTruthy();
  expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
  await user.clear(input);
  await user.type(input, '203.0.113.10');
  await user.click(screen.getByRole('button', { name: '保存' }));
  expect(await screen.findByText('203.0.113.10:25570')).toBeTruthy();
  expect(saved.at(-1)).toBe('{"host":"203.0.113.10"}');
  // 有公网地址后，局域网地址改用「同一网络」标题，避免被当成公网加入地址。
  expect(screen.getByText('同一网络的加入地址')).toBeTruthy();
  expect(screen.getByText(/放行入方向 TCP 25570（游戏端口）。面板端口 3000 只在/)).toBeTruthy();
  expect(screen.getByText('sudo ufw allow 25570/tcp')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '清除' }));
  await waitFor(() => expect(screen.queryByText('203.0.113.10:25570')).toBeNull());
  expect(saved.at(-1)).toBe('{"host":null}');
});

test('server-ip 填成公网 IP 时给出专门提示', async () => {
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

test('在其他设备上打开：默认 HTTPS 开启直接访问，显示二维码、网址和防火墙结果，可关闭', async () => {
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
  // 默认值：所有网卡、HTTPS 开、不限来源。
  expect((screen.getByLabelText('网卡') as HTMLSelectElement).value).toBe('');
  expect((screen.getByRole('switch', { name: '使用 HTTPS' }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole('switch', { name: '只允许同一网段的设备' }) as HTMLInputElement).checked).toBe(false);
  expect(screen.getByRole('option', { name: 'Meta（198.18.0.1）' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '开启' }));
  expect(bodies).toEqual(['{"enabled":true,"interfaceName":null,"restrictToSubnet":false,"https":true}']);
  // 开启后：二维码、网址说明、没挂上的地址和原因、证书指纹、防火墙失败提示。
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
  // 开启后改开关立即生效。
  await user.click(screen.getByRole('switch', { name: '使用 HTTPS' }));
  expect(bodies.at(-1)).toBe('{"enabled":true,"interfaceName":null,"restrictToSubnet":false,"https":false}');
  expect(await screen.findByRole('img', { name: 'http://192.168.2.163:3000/ 的二维码' })).toBeTruthy();
  expect(screen.queryByText('AB:CD')).toBeNull();
  // 弹窗底部的「关闭」只关弹窗；停用访问方式的按钮另有名字。
  await user.click(screen.getByRole('button', { name: '关闭此方式' }));
  await waitFor(() => expect(JSON.parse(bodies.at(-1)!).enabled).toBe(false));
  expect(await screen.findByText('面板现在只允许这台电脑访问，其他设备打不开。')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '关闭' }));
  expect(onClose).toHaveBeenCalled();
});

test('在其他设备上打开：HOST 由配置文件决定时只显示网址；证书失败时可不加密开启', async () => {
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

test('在其他设备上打开：面板自带网络开启后给出加入信息，密钥只在点开时请求', async () => {
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
  // 没检测到组网网卡时默认「面板自带」。
  expect(screen.getByRole('button', { name: '面板自带', pressed: true })).toBeTruthy();
  expect(screen.getByText('未开启')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '开启' }));
  expect(await screen.findByRole('img', { name: 'http://10.127.0.1:3000/ 的二维码' })).toBeTruthy();
  expect(screen.getByText('Pixel-8')).toBeTruthy();
  expect(screen.getByText('直连')).toBeTruthy();
  expect(joinRequests).toBe(0);
  await user.click(screen.getByRole('button', { name: '显示加入信息' }));
  expect(await screen.findByText('mystry-panel-abc')).toBeTruthy();
  // 密钥每 4 个一组显示，复制的是不带空格的原文，提示里不回显完整密钥以外的内容。
  expect(screen.getByText('abcd efgh ijkl mnop qrst uvwx yz')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '复制 网络密钥' }));
  expect(writeText).toHaveBeenCalledWith('abcdefghijklmnopqrstuvwxyz');
  expect(screen.getByRole('img', { name: '加入信息的二维码' })).toBeTruthy();
  expect(joinRequests).toBe(1);
  await user.click(screen.getByRole('button', { name: 'iPhone' }));
  expect(screen.getByText(/官方下载页没有 iPhone 客户端/)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '电脑' }));
  expect(screen.getByText(/easytier-core --dhcp --network-name "mystry-panel-abc"/)).toBeTruthy();
});

test('二维码矩阵尺寸、三个定位角和结果稳定；中文内容不被截断', () => {
  const matrix = qrMatrix('https://192.168.2.163:3000/')!;
  // 27 个字节、纠错等级 M：版本 2 只放得下 26 个字节，所以是版本 3，29×29。
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
  // 中文按 UTF-8 编码：字节数比字符数多，矩阵比同样字符数的 ASCII 大。
  expect(qrMatrix('网络密钥'.repeat(8))!.length).toBeGreaterThan(qrMatrix('abcd'.repeat(8))!.length);
  expect(qrMatrix('x'.repeat(5000))).toBeNull();
});

test('复制：没有 navigator.clipboard（非安全上下文）时退回 execCommand，都不行时返回 false', async () => {
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
  // 临时文本框用完即删，焦点回到原来的按钮。
  expect(document.querySelector('textarea')).toBeNull();
  expect(document.activeElement).toBe(button);

  // 标准接口被拒绝时同样退回。
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
  expect(await copyText('b')).toBe(true);
  document.execCommand = vi.fn(() => false);
  expect(await copyText('c')).toBe(false);
  button.remove();
});

// ---- Java 选择器：新建实例自动选推荐版本，没有时一键安装（D-034） ----

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

test('Java 选择器：新建实例自动选推荐版本，手动改过后不再自动改', async () => {
  stubJava({ runtimes: [java21, java8], installable: [8, 17, 21, 25] });
  const values: Array<string | null> = [];
  const user = userEvent.setup();
  render(<JavaSelectHarness autoSelect onValue={(value) => values.push(value)} />);
  const select = await screen.findByLabelText(/^Java 运行时/) as HTMLSelectElement;
  // 默认 Java 是 8，Minecraft 1.21.1 推荐 21：自动选已装的 Java 21，不出现安装按钮。
  await waitFor(() => expect(select.value).toBe('rt21'));
  expect(screen.queryByRole('button', { name: /安装 Java/ })).toBeNull();
  // 换成 1.16.5：默认 Java 8 正好合适，回到默认。
  await user.click(screen.getByRole('button', { name: '切到 1.16.5' }));
  await waitFor(() => expect(select.value).toBe(''));
  // 用户亲手选了 21 之后，不再被自动改回。
  await user.selectOptions(select, 'rt21');
  expect(select.value).toBe('rt21');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(select.value).toBe('rt21');
  expect(values.at(-1)).toBe('rt21');
  // 推荐的 Java 8 已经装了：不符提示只让改选，不再给下载链接。
  expect(await screen.findByText(/所选 Java 是 Java 21，推荐使用 Java 8/)).toBeTruthy();
  expect(screen.queryByRole('link', { name: /下载 Java/ })).toBeNull();
});

test('Java 选择器：实例设置页不自动改已保存的选择', async () => {
  stubJava({ runtimes: [java21, java8], installable: [21] });
  const values: Array<string | null> = [];
  render(<JavaSelectHarness onValue={(value) => values.push(value)} />);
  const select = await screen.findByLabelText(/^Java 运行时/) as HTMLSelectElement;
  await screen.findByText(/系统默认 Java 是 Java 8/);
  expect(select.value).toBe('');
  expect(values).toEqual([]);
});

test('Java 选择器：推荐版本没装时一键安装，装好后自动选中', async () => {
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
  expect(screen.getByText(/这台电脑还没装 Java 21/)).toBeTruthy();
  // 手动下载链接留作后备。
  expect(screen.getByRole('link', { name: '自己下载安装' }).getAttribute('href')).toBe('https://adoptium.net/temurin/releases/?version=21');
  await user.click(button);
  const select = screen.getByLabelText(/^Java 运行时/) as HTMLSelectElement;
  await waitFor(() => expect(select.value).toBe('panel21'));
  expect(posted).toEqual([{ major: 21 }]);
  expect(values.at(-1)).toBe('panel21');
  // 安装期间通知页面暂停提交，结束后恢复。
  await waitFor(() => expect(installingStates).toEqual([false, true, false]));
  expect(screen.queryByRole('button', { name: /安装 Java/ })).toBeNull();
});

test('Java 选择器：安装失败显示原因，保留手动下载入口', async () => {
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
  expect(await screen.findByText(/Java 21 没能下载下来.*国内镜像/)).toBeTruthy();
  expect(screen.getByRole('button', { name: '安装 Java 21' })).toBeTruthy();
  expect(screen.getByRole('link', { name: '自己下载安装' })).toBeTruthy();
});
