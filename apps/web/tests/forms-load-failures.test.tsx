// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { JavaRuntimeSelect, type JavaMatchStatus } from '../src/components/JavaRuntimeSelect';
import { MultiplayerTab } from '../src/components/MultiplayerTab';
import { ImportPage } from '../src/pages/ImportPage';
import { setupFormTestEnv } from './form-test-env';

beforeEach(setupFormTestEnv);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

test('Java 选择器：列表读取失败时状态是「不知道」，不说没检测到 Java，重新扫描成功后恢复', async () => {
  const user = userEvent.setup();
  let fail = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).startsWith('/api/system/java-runtimes')) return fail ? json({ error: '测试读取失败' }, 500) : json({ runtimes: [], installable: [] });
    if (url === '/api/system/java') return json({ available: true, version: '21.0.4', majorVersion: 21 });
    return json({});
  }));
  const statuses: JavaMatchStatus[] = [];
  render(<JavaRuntimeSelect value={null} onChange={() => {}} mcVersion="1.21.1" onMatchStatusChange={(status) => statuses.push(status)} />);
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('无法读取本机 Java 列表');
  expect(alert.textContent).toContain('重新扫描');
  expect(statuses.at(-1)).toBe('unknown');
  expect(statuses).not.toContain('mismatch');
  // 没读到就不能说「没检测到」。
  expect(screen.queryByText(/未检测到|没有检测到/)).toBeNull();

  fail = false;
  await user.click(screen.getByRole('button', { name: '重新扫描' }));
  await waitFor(() => expect(statuses.at(-1)).toBe('match'));
  expect(screen.queryByRole('alert')).toBeNull();
});

test('frp：第一次读取就失败时不显示「添加服务器」表单，只报错并给重试；重试成功后照常显示', async () => {
  const user = userEvent.setup();
  let fail = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (fail && url === '/api/frp/endpoints') return json({ error: '测试读取失败' }, 503);
    const data = url === '/api/frp/endpoints' ? []
      : url === '/api/frp/runtime' ? { version: '0.71.1', installed: true, platformSupported: true, archive: null }
        : String(url).includes('/tunnel') ? { instanceId: 'test', endpointId: null, mode: 'public', remotePort: null, visitorBindPort: 25565, enabled: false, status: 'disabled' }
          : {};
    return json(data);
  }));
  render(<MultiplayerTab instanceId="test" guide={{ open: false, onClose: () => {} }} />);
  const retry = await screen.findByRole('button', { name: '重试' });
  expect(screen.getByText('测试读取失败')).toBeTruthy();
  // 读取失败不等于一台都没配过。
  expect(screen.queryByLabelText('服务器地址')).toBeNull();
  expect(screen.queryByRole('button', { name: '保存 frp 服务器' })).toBeNull();

  fail = false;
  await user.click(retry);
  expect(await screen.findByLabelText('服务器地址')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
});

test('导入：切到 ZIP 后不带着文件夹来源识别出的核心和版本，切回文件夹时再填上', async () => {
  const user = userEvent.setup();
  // 已有一份 ZIP 预检，切到 ZIP 时配置区会显示出来。
  sessionStorage.setItem('mystry_import_preview_id', 'p1');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/import/sources')) {
      return json({ sources: [{ id: 'old-forge', launchTarget: 'forge-1.12.2-14.23.5.2860.jar', coreType: 'forge', mcVersion: '1.12.2', modifiedAt: '2026-11-01T00:00:00.000Z', ready: true }] });
    }
    if (String(url).includes('/import/previews/p1')) return json({ id: 'p1', fileName: 'paper.zip', sizeBytes: 1024, expiresAt: '2099-01-01T00:00:00.000Z' });
    if (String(url).startsWith('/api/system/java-runtimes')) return json({ runtimes: [], installable: [] });
    if (url === '/api/system/java') return json({ available: true, version: '21.0.4', majorVersion: 21 });
    if (url === '/api/system/download-source') return json({ source: 'official' });
    return json({});
  }));
  render(<MemoryRouter><ImportPage /></MemoryRouter>);
  // 恢复预检后停在 ZIP 模式；此时文件夹来源也已经读到并自动选中。
  const zipTab = await screen.findByRole('button', { name: '上传 ZIP 压缩包' });
  await waitFor(() => expect(zipTab.getAttribute('aria-pressed')).toBe('true'));
  const version = await screen.findByRole('textbox', { name: 'Minecraft 版本（可选）' }) as HTMLInputElement;
  const core = screen.getByRole('combobox', { name: '核心类型' }) as HTMLSelectElement;
  await waitFor(() => expect(screen.getByRole('button', { name: '从本机文件夹导入' })).toBeTruthy());
  // 给来源列表一点时间回来，再确认它没有写进 ZIP 的表单。
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(version.value).toBe('');
  expect(core.value).toBe('custom');

  await user.click(screen.getByRole('button', { name: '从本机文件夹导入' }));
  await waitFor(() => expect((screen.getByRole('textbox', { name: 'Minecraft 版本（可选）' }) as HTMLInputElement).value).toBe('1.12.2'));
  expect((screen.getByRole('combobox', { name: '核心类型' }) as HTMLSelectElement).value).toBe('forge');

  await user.click(screen.getByRole('button', { name: '上传 ZIP 压缩包' }));
  await waitFor(() => expect((screen.getByRole('textbox', { name: 'Minecraft 版本（可选）' }) as HTMLInputElement).value).toBe(''));
  expect((screen.getByRole('combobox', { name: '核心类型' }) as HTMLSelectElement).value).toBe('custom');
});
