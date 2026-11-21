// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { DetectedJvmConfig } from '@mystry/shared';
import { ImportPage } from '../src/pages/ImportPage';
import { setupFormTestEnv } from './form-test-env';

// 「从 imports 文件夹复制」：写出 imports 在面板电脑上的真实路径并能复制，列出里面的服务端，
// 每一行写识别结果，不能导入的行写原因、不能选。jsdom 里选不了文件夹，页面默认就是这个方式。

beforeEach(() => {
  setupFormTestEnv();
  vi.stubGlobal('WebSocket', class { close() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  // 复制失败的用例在 document 上放了自己的 execCommand，删掉后回到 jsdom 原来的实现。
  Reflect.deleteProperty(document, 'execCommand');
});

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const IMPORT_DIR = 'D:\\Mystry\\data\\imports';
const detected: DetectedJvmConfig = { source: 'user_jvm_args.txt', raw: '-Xmx4G', canonicalArgs: '-Xmx4G', issues: [] };
const base = { modifiedAt: '2026-11-01T00:00:00.000Z', ready: true };

/** 按顺序回应每次读取 imports 的请求；最后一个结果之后一直用它。 */
function mountImport(listings: Array<{ status?: number; body: unknown }>) {
  let calls = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const href = String(url);
    if (href.includes('/import/sources')) {
      const listing = listings[Math.min(calls, listings.length - 1)];
      calls += 1;
      return json(listing.body, listing.status ?? 200);
    }
    if (href.startsWith('/api/system/java-runtimes')) return json({ runtimes: [], installable: [] });
    if (href === '/api/system/java') return json({ available: true, version: '17.0.9', majorVersion: 17 });
    if (href === '/api/nodes') return json([]);
    return json({});
  }));
  render(<MemoryRouter><ImportPage /></MemoryRouter>);
  return { calls: () => calls };
}

const radio = (id: string) => screen.getByRole('radio', { name: id }) as HTMLInputElement;
const detail = (id: string) => document.getElementById(radio(id).getAttribute('aria-describedby')!)!.textContent;

test('imports：写出真实路径，「复制路径」复制的就是它并提示已复制', async () => {
  const user = userEvent.setup();
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  mountImport([{ body: { importDir: IMPORT_DIR, sources: [] } }]);

  expect(await screen.findByText(IMPORT_DIR, { selector: 'code' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'imports 文件夹' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '复制路径' }));
  expect(writeText).toHaveBeenCalledWith(IMPORT_DIR);
  expect(await screen.findByText('已复制 imports 文件夹的路径。')).toBeTruthy();
});

test('imports：复制失败时提示手动选中路径', async () => {
  const user = userEvent.setup();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
  // jsdom 的 execCommand 不会真的复制；让它返回 false，走「都失败」的分支。
  const execCommand = vi.fn(() => false);
  Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
  mountImport([{ body: { importDir: IMPORT_DIR, sources: [] } }]);

  await user.click(await screen.findByRole('button', { name: '复制路径' }));
  expect(await screen.findByText('复制失败，请手动选中路径后复制。')).toBeTruthy();
});

test('imports：每一行写识别结果；不能导入的行写原因且不能选；默认选中第一个能导入的', async () => {
  const user = userEvent.setup();
  mountImport([{
    body: {
      importDir: IMPORT_DIR,
      sources: [
        { id: 'big-world', launchTarget: null, coreType: 'custom', ...base },
        { id: 'creative', launchTarget: 'server.jar', coreType: 'vanilla', ...base },
        { id: 'old-backup', launchTarget: null, coreType: 'custom', ...base, ready: false, error: 'no launch target', errorI18n: { key: 'server.imports.existing.noLaunchTarget' } },
        { id: 'survival', launchTarget: '@args:libraries/net/minecraftforge/forge/1.20.1-47.2.0/win_args.txt', coreType: 'forge', mcVersion: '1.20.1', detectedJvmConfig: detected, ...base },
      ],
    },
  }]);

  await screen.findByRole('radio', { name: 'survival' });
  expect(screen.getByRole('radiogroup', { name: 'imports 里的服务端' })).toBeTruthy();
  expect(detail('survival')).toBe('Forge 1.20.1，带 user_jvm_args.txt');
  expect(detail('creative')).toBe('Vanilla（版本未知） · server.jar');
  expect(detail('big-world')).toBe('导入时再检查');
  expect(detail('old-backup')).toBe('未找到服务端 jar 或 Forge/NeoForge 启动参数文件');
  expect(radio('old-backup').disabled).toBe(true);
  expect(document.body.textContent).not.toContain('@args:');

  // 默认选中列表里第一个能导入的 big-world。
  await waitFor(() => expect(radio('big-world').checked).toBe(true));
  await user.click(screen.getByText('creative'));
  expect(radio('creative').checked).toBe(true);
  expect(radio('big-world').checked).toBe(false);
});

test('imports：空的时候说下一步；点「刷新」重新读取，复制进去的服务端出现并被选中', async () => {
  const user = userEvent.setup();
  const mounted = mountImport([
    { body: { importDir: IMPORT_DIR, sources: [] } },
    { body: { importDir: IMPORT_DIR, sources: [{ id: 'paper-survival', launchTarget: 'paper.jar', coreType: 'paper', mcVersion: '1.21.1', ...base }] } },
  ]);

  expect(await screen.findByText('imports 里还没有服务端。复制进去后点「刷新」。')).toBeTruthy();
  expect(screen.queryByRole('radio')).toBeNull();
  await user.click(screen.getByRole('button', { name: '刷新' }));
  await waitFor(() => expect(radio('paper-survival').checked).toBe(true));
  expect(mounted.calls()).toBe(2);
  expect(detail('paper-survival')).toBe('Paper 1.21.1 · paper.jar');
  expect(screen.queryByText(/imports 里还没有服务端/)).toBeNull();
});

test('imports：读取失败时写原因，不显示「还没有服务端」', async () => {
  mountImport([{ status: 500, body: { error: 'Instance directory not found', messageI18n: { key: 'server.files.instanceDirNotFound' } } }]);
  expect(await screen.findByText(/无法读取导入文件夹/)).toBeTruthy();
  expect(screen.queryByText(/imports 里还没有服务端/)).toBeNull();
  expect(screen.queryByRole('button', { name: '复制路径' })).toBeNull();
});
