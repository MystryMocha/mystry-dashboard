// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { DetectedJvmConfig } from '@mystry/shared';
import { JavaRuntimeSelect } from '../src/components/JavaRuntimeSelect';
import { ImportPage } from '../src/pages/ImportPage';
import { setupFormTestEnv } from './form-test-env';

// 导入页简化：选好来源后只露出名称、识别结果和 EULA，核心、版本、Java、内存收进「修改设置」；
// 有要处理的问题时自动展开。共用的 Java 选择器状态行说的是实际要用的那个 Java。
// jsdom 不会真的把收起的 <details> 内容藏起来，所以这里直接看 open 属性，真实收起效果在浏览器里核对。

beforeEach(() => {
  setupFormTestEnv();
  vi.stubGlobal('WebSocket', class { close() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const java21 = { id: 'rt21', path: 'C:/Java/jdk-21/bin/java.exe', version: '21.0.5', majorVersion: 21, source: 'scan', verifiedAt: '2026-11-01T00:00:00Z', available: true };
const java21b = { ...java21, id: 'rt21b', path: 'D:/data/runtimes/java/temurin-jre-21/bin/java.exe', version: '21.0.6', source: 'panel' };
const java8Default = { available: true, version: '1.8.0_492', majorVersion: 8 };
const java21Default = { available: true, version: '21.0.4', majorVersion: 21 };

const detected: DetectedJvmConfig = {
  source: 'user_jvm_args.txt',
  raw: '-Xms2G -Xmx4G',
  canonicalArgs: '-Xms2G -Xmx4G',
  issues: [],
};

function source(id: string, coreType: string, mcVersion: string, extra: Record<string, unknown> = {}) {
  return { id, launchTarget: 'server.jar', coreType, mcVersion, modifiedAt: '2026-11-01T00:00:00.000Z', ready: true, ...extra };
}

/** 挂上导入页（jsdom 里选不了文件夹，默认是「从 imports 文件夹复制」），记下提交的请求体。 */
function mountImport(options: { sources: unknown[]; runtimes?: unknown[]; defaultJava?: unknown }) {
  const posted: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const href = String(url);
    if (href.includes('/import/sources')) return json({ sources: options.sources });
    if (href.startsWith('/api/system/java-runtimes')) return json({ runtimes: options.runtimes ?? [], installable: [] });
    if (href === '/api/system/java') return json(options.defaultJava ?? java21Default);
    if (href === '/api/nodes') return json([]);
    if (href === '/api/import/existing' && init?.method === 'POST') {
      posted.push(JSON.parse(String(init.body)));
      return json({ id: 'task1', type: 'import', status: 'pending', progress: 0, message: '', createdAt: '', updatedAt: '' });
    }
    if (href === '/api/tasks/task1') {
      return json({ id: 'task1', type: 'import', status: 'completed', progress: 100, message: '', result: { instanceId: 'inst1' }, createdAt: '', updatedAt: '' });
    }
    return json({});
  }));
  render(<MemoryRouter><ImportPage /></MemoryRouter>);
  return posted;
}

/** 自动展开要等问题持续一小会儿（300ms），断言「没展开」前多等一点，证明之后也不会展开。 */
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); });

const settingsDisclosure = () => screen.getByText('修改设置').closest('details') as HTMLDetailsElement;
/** imports 里的服务端是一组单选行，可访问名就是文件夹名。 */
const sourceRadio = (id: string) => screen.getByRole('radio', { name: id }) as HTMLInputElement;
const summaryValue = (label: string) => {
  const summary = screen.getByLabelText('识别出的设置');
  const term = within(summary).getByText(label, { selector: 'dt' });
  return term.nextElementSibling!.textContent;
};

test('导入：没选好来源时只有来源区，不出现导入设置', async () => {
  mountImport({ sources: [] });
  await screen.findByText(/imports 里还没有服务端/);
  expect(screen.queryByRole('heading', { name: '导入设置' })).toBeNull();
  expect(screen.queryByText('修改设置')).toBeNull();
  expect(screen.queryByLabelText('实例名称')).toBeNull();
});

test('导入：选好来源后摘要写出识别结果，「修改设置」默认收起；收起时提交的内容和识别结果一致', async () => {
  const user = userEvent.setup();
  const posted = mountImport({
    sources: [source('paper-server', 'paper', '1.21.1', { detectedJvmConfig: detected })],
    runtimes: [java21],
    defaultJava: java8Default,
  });
  await screen.findByRole('heading', { name: '导入设置' });
  // 默认 Java 是 8，Paper 1.21.1 推荐 21：自动选中已装的 Java 21，摘要里不再写「系统默认」。
  await waitFor(() => expect(summaryValue('Java')).toBe('Java 21'));
  expect(summaryValue('服务端')).toBe('Paper 1.21.1');
  expect(summaryValue('内存')).toBe('最多 4 GB来自 user_jvm_args.txt');
  await settle();
  expect(settingsDisclosure().open).toBe(false);
  // 名称和 EULA 不在折叠区里。
  expect(screen.getByLabelText('实例名称').closest('details')).toBeNull();
  expect(screen.getByRole('checkbox', { name: /Minecraft EULA/ }).closest('details')).toBeNull();

  await user.click(screen.getByRole('checkbox', { name: /Minecraft EULA/ }));
  await user.click(screen.getByRole('button', { name: '复制并导入' }));
  await waitFor(() => expect(posted).toHaveLength(1));
  expect(posted[0]).toEqual({
    name: '已有服务器',
    sourceId: 'paper-server',
    coreType: 'paper',
    mcVersion: '1.21.1',
    jvmArgs: '-Xms2G -Xmx4G',
    acceptEula: true,
    javaRuntimeId: 'rt21',
  });
});

test('导入：Java 版本不符时自动展开「修改设置」；用户收起后换来源会重新收起，新来源有问题再展开', async () => {
  const user = userEvent.setup();
  mountImport({
    // Forge 1.20.1 推荐 Java 17，只有系统默认的 Java 21：不符。Paper 1.21.1 推荐 21：正好。
    sources: [source('forge-server', 'forge', '1.20.1'), source('paper-server', 'paper', '1.21.1')],
    defaultJava: java21Default,
  });
  await screen.findByRole('radio', { name: 'forge-server' });
  await waitFor(() => expect(sourceRadio('forge-server').checked).toBe(true));
  await waitFor(() => expect(settingsDisclosure().open).toBe(true));
  expect(summaryValue('Java')).toBe('Java 21（系统默认）推荐 Java 17');

  // 用户收起后不再被自动展开。
  await user.click(screen.getByText('修改设置'));
  expect(settingsDisclosure().open).toBe(false);
  await settle();
  expect(settingsDisclosure().open).toBe(false);

  // 换到没问题的来源：保持收起。
  await user.click(sourceRadio('paper-server'));
  await waitFor(() => expect(summaryValue('服务端')).toBe('Paper 1.21.1'));
  expect(summaryValue('Java')).toBe('Java 21（系统默认）');
  await settle();
  expect(settingsDisclosure().open).toBe(false);

  // 再换回有问题的来源：又自动展开一次。
  await user.click(sourceRadio('forge-server'));
  await waitFor(() => expect(settingsDisclosure().open).toBe(true));
});

test('导入：没有可用的 Java 时摘要写明，并自动展开设置', async () => {
  mountImport({
    sources: [source('unknown-version', 'custom', '')],
    defaultJava: { available: false },
  });
  await screen.findByRole('heading', { name: '导入设置' });
  await waitFor(() => expect(summaryValue('Java')).toBe('没有找到可用的 Java'));
  expect(summaryValue('服务端')).toBe('导入时自动识别');
  await waitFor(() => expect(settingsDisclosure().open).toBe(true));
});

test('导入：Java 可用但不知道 Minecraft 版本时，摘要提醒无法确认，设置保持收起', async () => {
  mountImport({
    sources: [source('unknown-version', 'custom', '')],
    defaultJava: java8Default,
  });
  await screen.findByRole('heading', { name: '导入设置' });
  await waitFor(() => expect(summaryValue('Java')).toBe('Java 8（系统默认）还不知道 Minecraft 版本，无法确认这个 Java 是否合适。'));
  await settle();
  expect(settingsDisclosure().open).toBe(false);
});

test('Java 选择器：选了面板登记的 Java 时状态行说它，不说系统默认；选项只写主版本，同主版本有两个才带路径', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).startsWith('/api/system/java-runtimes')) return json({ runtimes: [java21], installable: [] });
    if (url === '/api/system/java') return json(java8Default);
    return json({});
  }));
  const { rerender } = render(<JavaRuntimeSelect value="rt21" onChange={() => {}} mcVersion="1.21.1" />);
  const select = screen.getByRole('combobox') as HTMLSelectElement;
  await screen.findByText('Java 21.0.5 可用');
  expect(screen.queryByText(/系统默认 Java 1\.8/)).toBeNull();
  expect([...select.options].map((option) => option.textContent)).toEqual(['系统默认 Java', 'Java 21']);
  // 路径放在下拉框的悬停提示里。
  expect(select.title).toBe('C:/Java/jdk-21/bin/java.exe');

  // 没选（用系统默认）时照旧说系统默认 Java。
  rerender(<JavaRuntimeSelect value={null} onChange={() => {}} mcVersion="1.16.5" />);
  await screen.findByText('系统默认 Java 1.8.0_492 可用');
  expect(select.title).toBe('');
});

test('Java 选择器：同一个主版本装了两个时选项带路径区分', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).startsWith('/api/system/java-runtimes')) return json({ runtimes: [java21, java21b], installable: [] });
    if (url === '/api/system/java') return json(java8Default);
    return json({});
  }));
  render(<JavaRuntimeSelect value="rt21b" onChange={() => {}} />);
  await screen.findByText('Java 21.0.6 可用');
  const select = screen.getByRole('combobox') as HTMLSelectElement;
  expect([...select.options].map((option) => option.textContent)).toEqual([
    '系统默认 Java',
    'Java 21 · C:/Java/jdk-21/bin/java.exe',
    'Java 21 · D:/data/runtimes/java/temurin-jre-21/bin/java.exe',
  ]);
});

test('Java 选择器：安装中被卸载时告诉页面不再安装，页面的提交按钮不会一直灰着', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/system/java-runtimes/install' && init?.method === 'POST') {
      return json({ id: 'install21', type: 'download', status: 'running', progress: 10, message: '', createdAt: '', updatedAt: '' });
    }
    if (url === '/api/tasks/install21') {
      return json({ id: 'install21', type: 'download', status: 'running', progress: 10, message: '', createdAt: '', updatedAt: '' });
    }
    if (String(url).startsWith('/api/system/java-runtimes')) return json({ runtimes: [], installable: [21] });
    if (url === '/api/system/java') return json(java8Default);
    return json({});
  }));
  const states: boolean[] = [];
  const { unmount } = render(
    <JavaRuntimeSelect value={null} onChange={() => {}} mcVersion="1.21.1" onInstallingChange={(installing) => states.push(installing)} />,
  );
  await user.click(await screen.findByRole('button', { name: '安装 Java 21' }));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '安装 Java 21' }));
  await waitFor(() => expect(states.at(-1)).toBe(true));
  unmount();
  expect(states.at(-1)).toBe(false);
});
