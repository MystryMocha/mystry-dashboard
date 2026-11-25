// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom';
import { useState } from 'react';
import type { DetectedJvmConfig, RemoteAccessStatus } from '@mystry/shared';
import { JavaRuntimeSelect } from '../src/components/JavaRuntimeSelect';
import { JvmSettingsEditor } from '../src/components/JvmSettingsEditor';
import { RemoteAccessMode } from '../src/components/RemoteAccessMode';
import { ImportPage } from '../src/pages/ImportPage';
import { InstancePage } from '../src/pages/InstancePage';
import { setupFormTestEnv } from './form-test-env';

// Display logic problems found later: what the form shows differs from what is actually submitted.

beforeEach(() => {
  setupFormTestEnv();
  vi.stubGlobal('WebSocket', class { close() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const javaDefault = { available: true, version: '21.0.4', majorVersion: 21 };

/** Text of the selected option; when the value is not among the options the browser selects the first item, and what needs checking here is the item actually displayed. */
const shownOption = (select: HTMLSelectElement) => select.options[select.selectedIndex]?.textContent ?? '';

test('Java picker: a selected Java not in the list is still displayed, with different wording for loading, failed to read and really missing', async () => {
  const user = userEvent.setup();
  let respond: (() => void) | null = null;
  let fail = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).startsWith('/api/system/java-runtimes')) {
      // Keep the first read pending, to look at the loading display.
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

  // The rescan failed but it was read before: the list is still there and still says unavailable.
  fail = true;
  await user.click(screen.getByRole('button', { name: '重新扫描' }));
  await waitFor(() => expect(screen.getByText(/测试读取失败/)).toBeTruthy());
  expect(shownOption(select)).toBe('已不可用的 Java');
});

test('Java picker: when the list has never been read, the selected Java shows as "the selected Java", not as no longer available', async () => {
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

/** Mounts instance settings and records the request bodies of all write requests. */
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

test('instance settings: an invalid Java is not displayed as "System default" in the dropdown; changing only the name submits only the name and is not blocked by the invalid Java', async () => {
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

test('overlay interface: with no interface at open and one appearing later, the dropdown says "Choose an interface" instead of displaying the first interface', async () => {
  const user = userEvent.setup();
  const { rerender } = render(<RemoteAccessMode mode="overlay" status={remoteStatus([])} onStatus={() => {}} />);
  const select = screen.getByRole('combobox', { name: '网卡' }) as HTMLSelectElement;
  expect(shownOption(select)).toBe('无');

  // Polling picked up an overlay interface that just connected.
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

const detectedWithExtra: DetectedJvmConfig = {
  source: 'user_jvm_args.txt',
  raw: '-Xms2G -Xmx6G -Dfoo=bar',
  canonicalArgs: '-Xms2G -Xmx6G -Dfoo=bar',
  issues: [],
};

/** Looks at the notice bar only: the parent stores "whether to adopt", and the arguments themselves are untouched. */
function DetectedHost({ detected }: { detected: DetectedJvmConfig }) {
  const [applied, setApplied] = useState(Boolean(detected.canonicalArgs));
  return (
    <JvmSettingsEditor
      value="-Xms1G -Xmx2G"
      onChange={() => {}}
      coreType="forge"
      javaMajor={17}
      detectedJvmConfig={detected}
      detectedApplied={applied}
      onDetectedAppliedChange={setApplied}
    />
  );
}

test('JVM: a detected config file shows just one line plus "Cancel", and "Reapply" is available after cancelling; when the file is unusable the reason is given without buttons', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('fetch', vi.fn(async () => json([])));
  render(<DetectedHost detected={detectedWithExtra} />);
  expect(screen.getByText('已检测到配置文件 user_jvm_args.txt，已自动配置。')).toBeTruthy();
  // No more three-way radio group, and no need to choose first before filling in memory.
  expect(screen.queryByRole('radio')).toBeNull();
  expect((screen.getByLabelText('最大内存') as HTMLInputElement).disabled).toBe(false);

  await user.click(screen.getByRole('button', { name: '取消' }));
  expect(screen.getByText('没有使用配置文件 user_jvm_args.txt。')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '重新应用' }));
  expect(screen.getByText('已检测到配置文件 user_jvm_args.txt，已自动配置。')).toBeTruthy();
  cleanup();

  render(<DetectedHost detected={{
    source: 'user_jvm_args.txt',
    raw: '-Xms4G -Xmx2G',
    canonicalArgs: null,
    issues: [{ code: 'MEMORY_ORDER', severity: 'error', message: 'Initial memory cannot exceed max memory.', key: 'server.jvm.issue.memoryOrder' }],
  }} />);
  expect(screen.getByText('检测到配置文件 user_jvm_args.txt，但内容无法使用，没有采用。')).toBeTruthy();
  expect(screen.getByText('初始内存不能大于最大内存')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /取消|重新应用/ })).toBeNull();
});

test('import: a detected config file is adopted automatically and can be cancelled and reapplied; it is no longer adopted after switching folders, and arguments the user entered are kept across sources', async () => {
  const user = userEvent.setup();
  const source = (id: string, detected?: DetectedJvmConfig) => ({
    id, launchTarget: 'server.jar', coreType: 'forge', mcVersion: '1.20.1', modifiedAt: '2026-11-01T00:00:00.000Z', ready: true,
    ...(detected ? { detectedJvmConfig: detected } : {}),
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/import/sources')) {
      return json({ sources: [source('with-args', detectedWithExtra), source('plain'), source('plain-2')] });
    }
    if (String(url).startsWith('/api/system/java-runtimes')) return json({ runtimes: [], installable: [] });
    if (url === '/api/system/java') return json(javaDefault);
    if (url === '/api/nodes') return json([]);
    return json({});
  }));
  render(<MemoryRouter><ImportPage /></MemoryRouter>);
  const sourceRadio = (id: string) => screen.getByRole('radio', { name: id }) as HTMLInputElement;
  await screen.findByRole('radio', { name: 'with-args' });
  await waitFor(() => expect(sourceRadio('with-args').checked).toBe(true));
  const maxMemory = () => (screen.getByLabelText('最大内存') as HTMLInputElement).value;
  const preview = () => screen.getByLabelText('最终 JVM 参数').textContent;
  // Adopted without clicking anything; with extra arguments the advanced section expands, so they are not submitted while hidden.
  await screen.findByText('已检测到配置文件 user_jvm_args.txt，已自动配置。');
  expect(maxMemory()).toBe('6');
  expect(preview()).toContain('-Dfoo=bar');
  expect(screen.getByText('高级 JVM 参数').closest('details')!.open).toBe(true);

  // Cancel: back to the arguments from before adopting; reapply: adopt once more.
  await user.click(screen.getByRole('button', { name: '取消' }));
  expect(maxMemory()).toBe('2');
  expect(preview()).not.toContain('-Dfoo=bar');
  await user.click(screen.getByRole('button', { name: '重新应用' }));
  expect(maxMemory()).toBe('6');

  await user.click(sourceRadio('plain'));
  // The with-args row in the source list still says it comes with user_jvm_args.txt; only the import settings area is checked.
  expect(within(screen.getByRole('heading', { name: '导入设置' }).closest('section')!).queryByText(/user_jvm_args\.txt/)).toBeNull();
  expect(maxMemory()).toBe('2');
  expect(preview()).not.toContain('-Dfoo=bar');

  // What the user filled in is not a detection result: it is kept when switching to another folder without a detection result;
  // switching midway to a folder with a detection result adopts it, and switching away restores what the user filled in.
  await user.clear(screen.getByLabelText('最大内存'));
  await user.type(screen.getByLabelText('最大内存'), '3');
  await user.click(sourceRadio('plain-2'));
  expect(maxMemory()).toBe('3');
  await user.click(sourceRadio('with-args'));
  expect(maxMemory()).toBe('6');
  await user.click(sourceRadio('plain'));
  expect(maxMemory()).toBe('3');
});

test('instance settings: Forge / NeoForge instances show the args file path (read-only) without the internal marker, and it is not submitted when saving a rename', async () => {
  const user = userEvent.setup();
  const argsPath = 'libraries/net/minecraftforge/forge/1.20.1-47.2.0/win_args.txt';
  const patches = mountSettings({ coreType: 'forge', jarFile: `@args:${argsPath}` });

  const launch = await screen.findByRole('textbox', { name: '启动文件' }) as HTMLInputElement;
  expect(launch.value).toBe(argsPath);
  expect(launch.title).toBe(argsPath);
  expect(launch.readOnly).toBe(true);
  expect(screen.queryByRole('textbox', { name: 'Jar 文件名' })).toBeNull();
  expect(screen.queryByDisplayValue(/@args:/)).toBeNull();
  expect(screen.getByText(/Forge \/ NeoForge 通过这个参数文件启动/)).toBeTruthy();

  await user.type(screen.getByRole('textbox', { name: '名称' }), '2');
  await user.click(screen.getByRole('button', { name: '保存设置' }));
  await waitFor(() => expect(patches).toHaveLength(1));
  expect(patches[0]).toEqual({ name: '测试服2' });
});

test('instance settings: an instance whose mod loader is not installed yet does not show "@modloader"', async () => {
  mountSettings({ coreType: 'neoforge', jarFile: '@modloader' });
  const launch = await screen.findByRole('textbox', { name: '启动文件' }) as HTMLInputElement;
  expect(launch.readOnly).toBe(true);
  // The state is shown as body text, not as a low-contrast placeholder.
  expect(launch.value).toBe('未安装');
  expect(launch.placeholder).toBe('');
  expect(screen.queryByDisplayValue('@modloader')).toBeNull();
  expect(screen.getByText(/还没有安装完成/)).toBeTruthy();
});

test('import: when the launch target of a Forge folder is an args file, the source list shows only the core and version, not the @args: marker or the args file path', async () => {
  const argsPath = 'libraries/net/minecraftforge/forge/1.20.1-47.2.0/win_args.txt';
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/import/sources')) {
      return json({ sources: [{ id: 'forge-server', launchTarget: `@args:${argsPath}`, coreType: 'forge', mcVersion: '1.20.1', modifiedAt: '2026-11-01T00:00:00.000Z', ready: true }] });
    }
    if (String(url).startsWith('/api/system/java-runtimes')) return json({ runtimes: [], installable: [] });
    if (url === '/api/system/java') return json(javaDefault);
    return json({});
  }));
  render(<MemoryRouter><ImportPage /></MemoryRouter>);
  const radio = await screen.findByRole('radio', { name: 'forge-server' }) as HTMLInputElement;
  await waitFor(() => expect(radio.checked).toBe(true));
  expect(document.getElementById(radio.getAttribute('aria-describedby')!)!.textContent).toBe('Forge 1.20.1');
  expect(document.body.textContent).not.toContain('@args:');
  expect(document.body.textContent).not.toContain(argsPath);
});
