// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import type { RemoteAccessStatus } from '@mystry/shared';
import { JavaRuntimeSelect } from '../src/components/JavaRuntimeSelect';
import { RemoteAccessMode } from '../src/components/RemoteAccessMode';
import { InstancePage } from '../src/pages/InstancePage';
import { setupFormTestEnv } from './form-test-env';

// 策划案第 8 节「后来考察出的显示逻辑问题」里中优先级的几条：表单显示的和实际要提交的不一致。

beforeEach(() => {
  setupFormTestEnv();
  vi.stubGlobal('WebSocket', class { close() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const javaDefault = { available: true, version: '21.0.4', majorVersion: 21 };

/** 选中的 option 的文字；值不在选项里时浏览器会选中第一项，这里要看到的是实际显示的那一项。 */
const shownOption = (select: HTMLSelectElement) => select.options[select.selectedIndex]?.textContent ?? '';

test('Java 选择器：选中的 Java 不在列表里时照样显示它，读取中、没读到、确实没有三种说法不同', async () => {
  const user = userEvent.setup();
  let respond: (() => void) | null = null;
  let fail = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).startsWith('/api/system/java-runtimes')) {
      // 第一次读取先挂着，看读取中的显示。
      if (!respond) await new Promise<void>((resolve) => { respond = resolve; });
      return fail ? json({ error: '测试读取失败' }, 500) : json({ runtimes: [], installable: [] });
    }
    if (url === '/api/system/java') return json(javaDefault);
    return json({});
  }));
  render(<JavaRuntimeSelect value="rt-gone" onChange={() => {}} />);
  const select = screen.getByRole('combobox') as HTMLSelectElement;
  expect(select.value).toBe('rt-gone');
  expect(shownOption(select)).toBe('加载中…');

  respond!();
  await waitFor(() => expect(shownOption(select)).toBe('已不可用的 Java'));
  expect(select.value).toBe('rt-gone');
  expect(screen.getByRole('alert').textContent).toContain('之前选择的 Java 已不可用');

  // 重新扫描失败但之前读到过：列表还在，照旧说已不可用。
  fail = true;
  await user.click(screen.getByRole('button', { name: '重新扫描' }));
  await waitFor(() => expect(screen.getByText(/测试读取失败/)).toBeTruthy());
  expect(shownOption(select)).toBe('已不可用的 Java');
});

test('Java 选择器：列表一次都没读到时，选中的 Java 显示为「已选的 Java」，不说已不可用', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).startsWith('/api/system/java-runtimes')) return json({ error: '测试读取失败' }, 500);
    if (url === '/api/system/java') return json(javaDefault);
    return json({});
  }));
  render(<JavaRuntimeSelect value="rt-maybe" onChange={() => {}} />);
  const select = screen.getByRole('combobox') as HTMLSelectElement;
  await screen.findByText(/无法读取本机 Java 列表/);
  expect(select.value).toBe('rt-maybe');
  expect(shownOption(select)).toBe('已选的 Java（列表未读取）');
  expect(screen.queryByText(/已不可用/)).toBeNull();
});

/** 挂载实例设置，记下所有写请求的请求体。 */
function mountSettings(instance: Record<string, unknown>) {
  const patches: Record<string, unknown>[] = [];
  const full = {
    id: 'test', name: '测试服', coreType: 'custom', status: 'stopped', jarFile: 'server.jar', jvmArgs: '-Xms1G -Xmx2G',
    nodeId: 'local', acceptEula: true, javaRuntimeId: null, mcVersion: null, installPath: null, requiresMigration: false,
    ...instance,
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'PATCH') {
      patches.push(JSON.parse(String(options.body)) as Record<string, unknown>);
      return json({});
    }
    if (url === '/api/instances/test') return json(full);
    if (String(url).startsWith('/api/system/java-runtimes')) return json({ runtimes: [], installable: [] });
    if (url === '/api/system/java') return json(javaDefault);
    if (url === '/api/nodes') return json([]);
    return json({});
  }));
  const router = createMemoryRouter(
    [{ path: '/instances/:id/*', element: <InstancePage /> }],
    { initialEntries: ['/instances/test/settings'] },
  );
  render(<RouterProvider router={router} />);
  return patches;
}

test('实例设置：Java 已失效时下拉框不显示成「系统默认」；只改名称时只提交名称，不被失效的 Java 拦住', async () => {
  const user = userEvent.setup();
  const patches = mountSettings({ javaRuntimeId: 'rt-gone' });

  const name = await screen.findByRole('textbox', { name: '名称' }) as HTMLInputElement;
  const java = screen.getByRole('combobox', { name: 'Java 运行时' }) as HTMLSelectElement;
  await waitFor(() => expect(shownOption(java)).toBe('已不可用的 Java'));

  await user.type(name, '2');
  await user.click(screen.getByRole('button', { name: '保存设置' }));
  await waitFor(() => expect(patches).toHaveLength(1));
  expect(patches[0]).toEqual({ name: '测试服2' });
});

function remoteStatus(interfaces: RemoteAccessStatus['interfaces']): RemoteAccessStatus {
  const mode = { enabled: false, interfaceName: null, restrictToSubnet: false, https: true, urls: [], problem: null, firewall: null };
  return {
    managedByConfig: false, configuredHost: null, port: 3000, frontendServed: true, platform: 'win32',
    interfaces, publicHost: null, certificate: null, direct: mode, overlay: mode,
    panelNetwork: { enabled: false, platformSupported: true, installed: false } as RemoteAccessStatus['panelNetwork'],
  };
}

test('组网网卡：打开时还没有网卡、之后才出现，下拉框写「选择网卡」而不是显示成第一块网卡', async () => {
  const user = userEvent.setup();
  const { rerender } = render(<RemoteAccessMode mode="overlay" status={remoteStatus([])} onStatus={() => {}} />);
  const select = screen.getByRole('combobox', { name: '网卡' }) as HTMLSelectElement;
  expect(shownOption(select)).toBe('无');

  // 轮询读到了刚连上的组网网卡。
  rerender(<RemoteAccessMode
    mode="overlay"
    status={remoteStatus([
      { name: 'WLAN', address: '192.168.2.10', cidr: '192.168.2.10/24', kind: 'lan' },
      { name: 'Tailscale', address: '100.64.0.2', cidr: null, kind: 'overlay' },
    ])}
    onStatus={() => {}}
  />);
  expect(select.value).toBe('');
  expect(shownOption(select)).toBe('选择网卡');
  expect(screen.getByRole('button', { name: '开启' }).hasAttribute('disabled')).toBe(true);

  await user.selectOptions(select, 'Tailscale');
  expect(shownOption(select)).toBe('Tailscale（100.64.0.2）');
  expect(screen.getByRole('button', { name: '开启' }).hasAttribute('disabled')).toBe(false);
});
