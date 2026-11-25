// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { useState } from 'react';
import { ConfigTab } from '../src/components/ConfigTab';
import type { RestartControl } from '../src/components/SaveBar';
import { InstancePage } from '../src/pages/InstancePage';
import { setupFormTestEnv } from './form-test-env';

beforeEach(() => {
  setupFormTestEnv();
  vi.stubGlobal('WebSocket', class { close() {} });
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** Mounts the config editor alone (no restart entry, as if the instance is not running) and records what is submitted on save. */
function mountConfigTab(fileProps: Record<string, string>, mcVersion?: string) {
  const saves: Record<string, string>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => {
    if (options?.method === 'PUT') saves.push(JSON.parse(String(options.body)) as Record<string, string>);
    return json(fileProps);
  }));
  // useBlocker needs a data router, so MemoryRouter cannot be used here.
  const router = createMemoryRouter([{ path: '/', element: <ConfigTab instanceId="test" mcVersion={mcVersion} /> }]);
  render(<RouterProvider router={router} />);
  return saves;
}

/** Mounts the whole instance page and records all write requests; the restart entries of both the config editor and instance settings go through it. */
function mountInstancePage(tab: 'config' | 'settings', status: 'running' | 'stopped', fileProps: Record<string, string> = {}) {
  const calls: string[] = [];
  const instance = {
    id: 'test', name: '测试服', coreType: 'custom', status, jarFile: 'server.jar', jvmArgs: '-Xms1G -Xmx2G',
    nodeId: 'local', acceptEula: true, javaRuntimeId: null, mcVersion: null, installPath: null, requiresMigration: false,
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    const method = options?.method ?? 'GET';
    if (method !== 'GET') {
      calls.push(`${method} ${url} ${options?.body ?? ''}`.trim());
      return json({});
    }
    if (url === '/api/instances/test') return json(instance);
    if (String(url).includes('/config/server.properties')) return json(fileProps);
    if (String(url).includes('java-runtimes')) return json({ runtimes: [], defaultRuntime: null });
    if (url === '/api/nodes') return json([]);
    return json({});
  }));
  const router = createMemoryRouter(
    [{ path: '/instances/:id/*', element: <InstancePage /> }],
    { initialEntries: [`/instances/test/${tab}`] },
  );
  render(<RouterProvider router={router} />);
  return calls;
}

const saveButton = () => screen.queryByRole('button', { name: '保存配置' }) as HTMLButtonElement | null;

test('config editor: number items are text boxes with a numeric keyboard, and a dirty value in the file is shown as is, is not a change and does not block saving', async () => {
  const user = userEvent.setup();
  const saves = mountConfigTab({ 'view-distance': 'abc', motd: 'Old' });

  const view = await screen.findByRole('textbox', { name: '视距（区块）' }) as HTMLInputElement;
  await waitFor(() => expect(view.value).toBe('abc'));
  expect(view.type).toBe('text');
  expect(view.inputMode).toBe('numeric');
  // A dirty value is not marked red and the save bar does not appear.
  expect(view.getAttribute('aria-invalid')).toBeNull();
  expect(view.closest('.config-row')!.hasAttribute('data-field-invalid')).toBe(false);
  expect(saveButton()).toBeNull();

  // Changing another item can still be saved, and the dirty value is sent back as is.
  const motd = screen.getByRole('textbox', { name: '服务器简介' });
  await user.clear(motd);
  await user.type(motd, 'New');
  expect(saveButton()!.disabled).toBe(false);
  await user.click(saveButton()!);
  await waitFor(() => expect(saves).toEqual([{ 'view-distance': 'abc', motd: 'New' }]));

  // Digits only: letters, decimal points and a disallowed minus sign are filtered out directly.
  const maxPlayers = screen.getByRole('textbox', { name: '最大在线人数' }) as HTMLInputElement;
  await user.type(maxPlayers, '-1e2.5');
  expect(maxPlayers.value).toBe('125');
});

test('config editor: a lone "-" counts as unfinished and is not saved as a clear; the reason shows only after blur', async () => {
  const user = userEvent.setup();
  const saves = mountConfigTab({ 'network-compression-threshold': '256' });

  const threshold = await screen.findByRole('textbox', { name: '网络压缩阈值' }) as HTMLInputElement;
  await waitFor(() => expect(threshold.value).toBe('256'));
  await user.clear(threshold);
  await user.type(threshold, '-');
  expect(threshold.value).toBe('-');
  const row = threshold.closest('.config-row')!;
  // An invalid value blocks saving right away and the row container is flagged; the red text shows only after blur.
  expect(saveButton()!.disabled).toBe(true);
  expect(row.hasAttribute('data-field-invalid')).toBe(true);
  expect(threshold.getAttribute('aria-invalid')).toBeNull();
  expect(within(row as HTMLElement).queryByText('填写不小于 -1 的整数')).toBeNull();

  await user.tab();
  const error = within(row as HTMLElement).getByText('填写不小于 -1 的整数');
  expect(threshold.getAttribute('aria-invalid')).toBe('true');
  expect(threshold.getAttribute('aria-describedby')!.split(' ')).toContain(error.id);
  expect(saves).toEqual([]);

  // A field already showing an error is recomputed on every keystroke: completing it to -1 clears it at once, and it can be saved.
  await user.type(threshold, '1');
  expect(threshold.value).toBe('-1');
  expect(threshold.getAttribute('aria-invalid')).toBeNull();
  expect(row.hasAttribute('data-field-invalid')).toBe(false);
  await user.click(saveButton()!);
  await waitFor(() => expect(saves).toEqual([{ 'network-compression-threshold': '-1' }]));
});

test('config editor save bar: appears only with changes and states how many, the status text jumps to the field to fix, and discarding returns to the loaded values', async () => {
  const user = userEvent.setup();
  const saves = mountConfigTab({ motd: 'Old', 'view-distance': '12', 'online-mode': 'true' });

  const motd = await screen.findByRole('textbox', { name: '服务器简介' }) as HTMLInputElement;
  await waitFor(() => expect(motd.value).toBe('Old'));
  // No changes: no save bar, and the placeholder container is always there.
  expect(document.querySelector('.save-bar-slot')).toBeTruthy();
  expect(document.querySelector('.save-bar')).toBeNull();
  expect(screen.queryByRole('button', { name: '放弃修改' })).toBeNull();

  await user.type(motd, '!');
  expect(screen.getByRole('status').textContent).toBe('1 项修改未保存');
  const onlineMode = screen.getByRole('switch', { name: '正版验证（在线模式）' }) as HTMLInputElement;
  await user.click(onlineMode);
  expect(screen.getByRole('status').textContent).toBe('2 项修改未保存');
  // Neither the page nor the dirty save bar repeats the restart note before saving.
  expect(screen.queryByText(/重启生效|重启实例后生效/)).toBeNull();
  // The primary button is the submit button, and every other button explicitly has type="button".
  expect(saveButton()!.type).toBe('submit');
  expect(document.querySelectorAll('form button:not([type])')).toHaveLength(0);
  expect((screen.getByRole('button', { name: '放弃修改' }) as HTMLButtonElement).type).toBe('button');

  // One item filled in wrong: save is disabled, and the status text names this item and is clickable.
  const view = screen.getByRole('textbox', { name: '视距（区块）' }) as HTMLInputElement;
  await user.clear(view);
  await user.type(view, '99');
  expect(saveButton()!.disabled).toBe(true);
  expect(screen.queryByText('填写 3–32 之间的整数')).toBeNull();
  motd.focus();
  const fix = within(screen.getByRole('status')).getByRole('button', { name: '先修正「视距（区块）」' });
  expect(fix.className).toContain('link-button');
  fireEvent.click(fix);
  expect(document.activeElement).toBe(view);
  expect(screen.getByText('填写 3–32 之间的整数')).toBeTruthy();
  expect(view.getAttribute('aria-invalid')).toBe('true');

  // Discard changes: back to the values at load time, with the red text and the "touched" records cleared together.
  await user.click(screen.getByRole('button', { name: '放弃修改' }));
  expect(motd.value).toBe('Old');
  expect(view.value).toBe('12');
  expect(onlineMode.checked).toBe(true);
  expect(document.querySelector('.save-bar')).toBeNull();
  expect(screen.queryByText('填写 3–32 之间的整数')).toBeNull();
  await user.clear(view);
  await user.type(view, '99');
  expect(view.getAttribute('aria-invalid')).toBeNull();
  expect(saves).toEqual([]);
});

test('config editor: Enter in an input saves when valid, jumps to the first failing field when invalid, and does nothing without changes', async () => {
  const user = userEvent.setup();
  const saves = mountConfigTab({ motd: 'Old', 'view-distance': '12', 'server-port': '25565' });

  const motd = await screen.findByRole('textbox', { name: '服务器简介' }) as HTMLInputElement;
  await waitFor(() => expect(motd.value).toBe('Old'));
  await user.type(motd, '{Enter}');
  expect(saves).toEqual([]);

  // Invalid: not saved, the reason is shown and focus jumps there.
  const view = screen.getByRole('textbox', { name: '视距（区块）' }) as HTMLInputElement;
  await user.clear(view);
  await user.type(view, '2');
  await user.type(motd, '!{Enter}');
  expect(saves).toEqual([]);
  expect(document.activeElement).toBe(view);
  expect(view.getAttribute('aria-invalid')).toBe('true');
  expect(screen.getByText('填写 3–32 之间的整数')).toBeTruthy();

  // The Enter that confirms an IME candidate does not submit.
  await user.type(view, '0');
  fireEvent.keyDown(view, { key: 'Enter', isComposing: true });
  expect(saves).toEqual([]);

  // Pressing Enter again after fixing it saves.
  await user.type(view, '{Enter}');
  await waitFor(() => expect(saves).toEqual([{ motd: 'Old!', 'view-distance': '20', 'server-port': '25565' }]));
  // The instance is not running (no restart entry): only a saved notice, no restart button.
  expect((await screen.findByRole('status')).textContent).toBe('已保存，重启实例后生效。');
  expect(screen.queryByRole('button', { name: '重启实例' })).toBeNull();
  expect(saveButton()).toBeNull();
});

test('config editor: saving while the instance is running offers "Restart Instance" through the instance page restart confirmation; it collapses on the next edit or on close', async () => {
  const user = userEvent.setup();
  const calls = mountInstancePage('config', 'running', { motd: 'Old' });

  const motd = await screen.findByRole('textbox', { name: '服务器简介' }) as HTMLInputElement;
  await waitFor(() => expect(motd.value).toBe('Old'));
  await user.type(motd, '1');
  await user.click(saveButton()!);
  await waitFor(() => expect(calls).toEqual(['PUT /api/instances/test/config/server.properties {"motd":"Old1"}']));
  const bar = document.querySelector('.save-bar') as HTMLElement;
  expect(within(bar).getByRole('status').textContent).toBe('已保存，重启实例后生效');
  expect(within(bar).getByRole('button', { name: '重启实例' })).toBeTruthy();

  // Edited again: the notice collapses, replaced by "N unsaved changes".
  await user.type(motd, '2');
  expect(screen.queryByText('已保存，重启实例后生效')).toBeNull();
  expect(screen.getByText('1 项修改未保存')).toBeTruthy();
  await user.click(saveButton()!);
  expect(await screen.findByText('已保存，重启实例后生效')).toBeTruthy();

  // The close button only collapses the notice.
  await user.click(within(document.querySelector('.save-bar') as HTMLElement).getByRole('button', { name: '关闭' }));
  expect(document.querySelector('.save-bar')).toBeNull();

  // The restart entry opens the confirmation dialog in the page header; the restart request is sent only after confirming, and the notice collapses with it.
  await user.type(motd, '3');
  await user.click(saveButton()!);
  await user.click(await screen.findByRole('button', { name: '重启实例' }));
  const dialog = screen.getByRole('dialog', { name: '重启实例「测试服」？' });
  expect(calls.some((call) => call.includes('/restart'))).toBe(false);
  await user.click(within(dialog).getByRole('button', { name: '确认重启' }));
  await waitFor(() => expect(calls.at(-1)).toContain('POST /api/instances/test/restart'));
  expect(screen.queryByText('已保存，重启实例后生效')).toBeNull();
});

test('config editor: versions before 1.18 do not show simulation distance, and the old value is sent back as is on save; shown as usual when the version is unknown', async () => {
  const user = userEvent.setup();
  const saves = mountConfigTab({ motd: 'Old', 'simulation-distance': '8' }, '1.17.1');

  const motd = await screen.findByRole('textbox', { name: '服务器简介' }) as HTMLInputElement;
  await waitFor(() => expect(motd.value).toBe('Old'));
  expect(screen.queryByRole('textbox', { name: '模拟距离（区块）' })).toBeNull();
  // Hidden keys do not appear in "Advanced Options" either.
  expect(screen.queryByLabelText('simulation-distance')).toBeNull();
  expect(screen.getByRole('textbox', { name: '视距（区块）' })).toBeTruthy();
  await user.type(motd, '!');
  await user.click(saveButton()!);
  await waitFor(() => expect(saves).toEqual([{ motd: 'Old!', 'simulation-distance': '8' }]));
  cleanup();

  for (const version of ['1.18', '1.21.8', undefined, '21w37a']) {
    mountConfigTab({ motd: 'Old' }, version);
    expect(await screen.findByRole('textbox', { name: '模拟距离（区块）' })).toBeTruthy();
    cleanup();
  }
});

test('config editor: on versions where "spawn animals" is hidden the end of the world group explains why, without mentioning game rules', async () => {
  mountConfigTab({ motd: 'Old' }, '1.21.8');
  const note = await screen.findByText('Minecraft 从 1.21.2 起去掉了「生成动物」这项设置，这个版本不再显示。');
  expect(note.closest('.form-section')!.querySelector('.form-section-title')!.textContent).toBe('世界');
  expect(screen.queryByRole('switch', { name: '生成动物' })).toBeNull();
  expect(screen.queryByText('/gamerule')).toBeNull();
  cleanup();

  // This sentence is not shown for versions that still have this item, or when the version is unknown.
  for (const version of ['1.21.1', undefined]) {
    mountConfigTab({ motd: 'Old' }, version);
    expect(await screen.findByRole('switch', { name: '生成动物' })).toBeTruthy();
    expect(screen.queryByText(/去掉了「生成动物」/)).toBeNull();
    cleanup();
  }
});

test('instance settings: the save bar appears only with changes, a cleared name is named and can be jumped to, discarding restores, and Enter saves but does not submit in multi-line text boxes', async () => {
  const user = userEvent.setup();
  const calls = mountInstancePage('settings', 'stopped');

  const name = await screen.findByRole('textbox', { name: '名称' }) as HTMLInputElement;
  expect(name.value).toBe('测试服');
  const findSave = () => screen.queryByRole('button', { name: '保存设置' }) as HTMLButtonElement | null;
  expect(findSave()).toBeNull();
  expect(document.querySelector('.save-bar-slot')).toBeTruthy();

  // Clear the name: save is disabled and the status text names "Name"; the red text shows only after clicking the status text or blur.
  await user.clear(name);
  expect(findSave()!.disabled).toBe(true);
  expect(findSave()!.type).toBe('submit');
  expect(document.querySelectorAll('form button:not([type])')).toHaveLength(0);
  expect(screen.queryByText('填写实例名称')).toBeNull();
  const jarFile = screen.getByRole('textbox', { name: 'Jar 文件名' }) as HTMLInputElement;
  jarFile.focus();
  // A field that has been blurred shows the reason directly; this also verifies the status text can bring focus back.
  fireEvent.click(within(screen.getByRole('status')).getByRole('button', { name: '先修正「名称」' }));
  expect(document.activeElement).toBe(name);
  const error = screen.getByText('填写实例名称');
  expect(name.getAttribute('aria-describedby')!.split(' ')).toContain(error.id);

  await user.click(screen.getByRole('button', { name: '放弃修改' }));
  expect(name.value).toBe('测试服');
  expect(findSave()).toBeNull();
  expect(screen.queryByText('填写实例名称')).toBeNull();

  // Enter in a multi-line text box is a line break and does not submit.
  await user.type(name, '2');
  expect(screen.getByRole('status').textContent).toBe('1 项修改未保存');
  const textarea = document.querySelector('form textarea') as HTMLTextAreaElement;
  expect(textarea).toBeTruthy();
  fireEvent.keyDown(textarea, { key: 'Enter' });
  expect(calls).toEqual([]);

  // Pressing Enter in the input saves; changing only the name needs no restart, and a saved notice shows briefly.
  await user.type(name, '{Enter}');
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]).toContain('PATCH /api/instances/test ');
  expect(JSON.parse(calls[0]!.slice(calls[0]!.indexOf('{'))).name).toBe('测试服2');
  expect(await screen.findByText('设置已保存。')).toBeTruthy();
  expect(findSave()).toBeNull();
  expect(screen.queryByRole('button', { name: '重启实例' })).toBeNull();
});

test('instance settings: with the instance running, saving settings read only at start offers "Restart Instance"; changing only the name does not prompt a restart', async () => {
  const user = userEvent.setup();
  const calls = mountInstancePage('settings', 'running');

  const name = await screen.findByRole('textbox', { name: '名称' }) as HTMLInputElement;
  await user.type(name, '2');
  await user.click(screen.getByRole('button', { name: '保存设置' }));
  expect(await screen.findByText('设置已保存。')).toBeTruthy();
  expect(document.querySelector('.save-bar')!.querySelector('button')).toBeNull();

  const jarFile = screen.getByRole('textbox', { name: 'Jar 文件名' }) as HTMLInputElement;
  await user.clear(jarFile);
  await user.type(jarFile, 'paper.jar');
  // The previous notice collapses on the next edit.
  expect(screen.queryByText('设置已保存。')).toBeNull();
  await user.click(screen.getByRole('button', { name: '保存设置' }));
  const bar = await waitFor(() => {
    const element = document.querySelector('.save-bar.is-notice') as HTMLElement | null;
    expect(element?.textContent).toContain('已保存，重启实例后生效');
    return element!;
  });
  await user.click(within(bar).getByRole('button', { name: '重启实例' }));
  await user.click(within(screen.getByRole('dialog', { name: '重启实例「测试服」？' })).getByRole('button', { name: '确认重启' }));
  await waitFor(() => expect(calls.at(-1)).toContain('POST /api/instances/test/restart'));
  expect(document.querySelector('.save-bar')).toBeNull();
});

test('config editor: an implicit submit caused by Enter on a dropdown or switch does not save, and clicking the save button saves as usual', async () => {
  const user = userEvent.setup();
  const saves = mountConfigTab({ motd: 'Old', difficulty: 'easy' });

  const difficulty = await screen.findByRole('combobox', { name: '难度' }) as HTMLSelectElement;
  await waitFor(() => expect(difficulty.value).toBe('easy'));
  await user.selectOptions(difficulty, 'hard');
  const form = difficulty.closest('form')!;
  // jsdom does not simulate implicit submission, so the submit event the browser fires right after Enter is added manually here.
  for (const control of [difficulty, screen.getByRole('switch', { name: '启用白名单' })]) {
    const notPrevented = fireEvent.keyDown(control, { key: 'Enter' });
    // The default behavior is not prevented, so the control's own keyboard handling is unaffected.
    expect(notPrevented).toBe(true);
    fireEvent.submit(form);
  }
  expect(saves).toEqual([]);

  await user.click(saveButton()!);
  await waitFor(() => expect(saves).toEqual([{ motd: 'Old', difficulty: 'hard' }]));
});

test('config editor: after saving, stopping and starting the instance does not bring back the "takes effect after restarting the instance" notice', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('fetch', vi.fn(async () => json({ motd: 'Old' })));
  let setRunning: (running: boolean) => void = () => {};
  function Host() {
    const [running, update] = useState(true);
    setRunning = update;
    const restart: RestartControl = { running, disabled: false, signal: 0, request: () => {} };
    return <ConfigTab instanceId="test" restart={restart} />;
  }
  render(<RouterProvider router={createMemoryRouter([{ path: '/', element: <Host /> }])} />);

  const motd = await screen.findByRole('textbox', { name: '服务器简介' }) as HTMLInputElement;
  await waitFor(() => expect(motd.value).toBe('Old'));
  await user.type(motd, '!');
  await user.click(saveButton()!);
  expect(await screen.findByText('已保存，重启实例后生效')).toBeTruthy();

  // Stop the instance in the page header: the notice collapses; after starting again the config is already in effect, so the notice should not come back.
  act(() => setRunning(false));
  expect(screen.queryByText('已保存，重启实例后生效')).toBeNull();
  act(() => setRunning(true));
  expect(screen.queryByText('已保存，重启实例后生效')).toBeNull();
  expect(document.querySelector('.save-bar')).toBeNull();
});
