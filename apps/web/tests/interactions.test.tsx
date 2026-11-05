// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { DashboardPage } from '../src/pages/DashboardPage';
import { DeployPage } from '../src/pages/DeployPage';
import { ImportPage } from '../src/pages/ImportPage';
import { NodesPage } from '../src/pages/NodesPage';
import { TaskCenter } from '../src/components/TaskCenter';
import { ConsolePanel } from '../src/components/ConsolePanel';
import { BackupsTab } from '../src/components/BackupsTab';
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
  await user.click(screen.getByRole('button', { name: '异常 0' }));
  expect(screen.getByText('暂无异常实例。')).toBeTruthy();
  expect(screen.queryByRole('link', { name: instance.name })).toBeNull();
  await user.click(screen.getByRole('button', { name: /显示全部/ }));
  expect(screen.getByRole('link', { name: instance.name })).toBeTruthy();
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
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
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
  const eula = screen.getByRole('checkbox', { name: /我已阅读并同意/ }) as HTMLInputElement;
  expect(eula.checked).toBe(false);
  expect(submit.disabled).toBe(true);
  expect(screen.getByText(/勾选后才能开始部署/)).toBeTruthy();

  await user.click(eula);
  await waitFor(() => expect(submit.disabled).toBe(false));
  await user.click(submit);
  await waitFor(() => expect(deployBodies).toHaveLength(1));
  expect(deployBodies[0]).toMatchObject({ coreType: 'paper', mcVersion: '26.3', acceptEula: true });
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
  await user.click(screen.getByRole('button', { name: '上传并预检' }));
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
