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

/** 单独挂载参数配置（没有重启入口，相当于实例没在运行），记下保存时提交的内容。 */
function mountConfigTab(fileProps: Record<string, string>, mcVersion?: string) {
  const saves: Record<string, string>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => {
    if (options?.method === 'PUT') saves.push(JSON.parse(String(options.body)) as Record<string, string>);
    return json(fileProps);
  }));
  // useBlocker 需要数据路由，这里不能用 MemoryRouter。
  const router = createMemoryRouter([{ path: '/', element: <ConfigTab instanceId="test" mcVersion={mcVersion} /> }]);
  render(<RouterProvider router={router} />);
  return saves;
}

/** 挂载整个实例页，记下所有写请求；参数配置和实例设置的重启入口都要经过它。 */
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

test('参数配置：数字项是带数字键盘的文本框，文件里的脏值原样显示、不算修改、不拦保存', async () => {
  const user = userEvent.setup();
  const saves = mountConfigTab({ 'view-distance': 'abc', motd: 'Old' });

  const view = await screen.findByRole('textbox', { name: '视距（区块）' }) as HTMLInputElement;
  await waitFor(() => expect(view.value).toBe('abc'));
  expect(view.type).toBe('text');
  expect(view.inputMode).toBe('numeric');
  // 脏值不标红、不出现保存栏。
  expect(view.getAttribute('aria-invalid')).toBeNull();
  expect(view.closest('.config-row')!.hasAttribute('data-field-invalid')).toBe(false);
  expect(saveButton()).toBeNull();

  // 改别的项仍然能保存，脏值原样带回。
  const motd = screen.getByRole('textbox', { name: '服务器简介' });
  await user.clear(motd);
  await user.type(motd, 'New');
  expect(saveButton()!.disabled).toBe(false);
  await user.click(saveButton()!);
  await waitFor(() => expect(saves).toEqual([{ 'view-distance': 'abc', motd: 'New' }]));

  // 只能输数字：字母、小数点和不允许的负号直接被滤掉。
  const maxPlayers = screen.getByRole('textbox', { name: '最大在线人数' }) as HTMLInputElement;
  await user.type(maxPlayers, '-1e2.5');
  expect(maxPlayers.value).toBe('125');
});

test('参数配置：只输了「-」算没输完，不会被当成清空保存；失焦后才显示原因', async () => {
  const user = userEvent.setup();
  const saves = mountConfigTab({ 'network-compression-threshold': '256' });

  const threshold = await screen.findByRole('textbox', { name: '网络压缩阈值' }) as HTMLInputElement;
  await waitFor(() => expect(threshold.value).toBe('256'));
  await user.clear(threshold);
  await user.type(threshold, '-');
  expect(threshold.value).toBe('-');
  const row = threshold.closest('.config-row')!;
  // 不合法马上拦住保存，行容器带标记；红字等失焦后才显示。
  expect(saveButton()!.disabled).toBe(true);
  expect(row.hasAttribute('data-field-invalid')).toBe(true);
  expect(threshold.getAttribute('aria-invalid')).toBeNull();
  expect(within(row as HTMLElement).queryByText('填写不小于 -1 的整数')).toBeNull();

  await user.tab();
  const error = within(row as HTMLElement).getByText('填写不小于 -1 的整数');
  expect(threshold.getAttribute('aria-invalid')).toBe('true');
  expect(threshold.getAttribute('aria-describedby')!.split(' ')).toContain(error.id);
  expect(saves).toEqual([]);

  // 已经在报错的字段每次按键重算：补成 -1 马上消失，可以保存。
  await user.type(threshold, '1');
  expect(threshold.value).toBe('-1');
  expect(threshold.getAttribute('aria-invalid')).toBeNull();
  expect(row.hasAttribute('data-field-invalid')).toBe(false);
  await user.click(saveButton()!);
  await waitFor(() => expect(saves).toEqual([{ 'network-compression-threshold': '-1' }]));
});

test('参数配置保存栏：有修改才出现并写明几项，状态文字可点着跳到要改的字段，放弃修改回到加载时的值', async () => {
  const user = userEvent.setup();
  const saves = mountConfigTab({ motd: 'Old', 'view-distance': '12', 'online-mode': 'true' });

  const motd = await screen.findByRole('textbox', { name: '服务器简介' }) as HTMLInputElement;
  await waitFor(() => expect(motd.value).toBe('Old'));
  // 没改动：没有保存栏，占位容器一直在。
  expect(document.querySelector('.save-bar-slot')).toBeTruthy();
  expect(document.querySelector('.save-bar')).toBeNull();
  expect(screen.queryByRole('button', { name: '放弃修改' })).toBeNull();

  await user.type(motd, '!');
  expect(screen.getByRole('status').textContent).toBe('1 项修改未保存');
  const onlineMode = screen.getByRole('switch', { name: '正版验证（在线模式）' }) as HTMLInputElement;
  await user.click(onlineMode);
  expect(screen.getByRole('status').textContent).toBe('2 项修改未保存');
  // 页首已经说过要重启，栏里不再重复。
  expect(screen.getAllByText(/重启实例后生效/)).toHaveLength(1);
  // 主按钮是提交按钮，其余按钮都明确写了 type="button"。
  expect(saveButton()!.type).toBe('submit');
  expect(document.querySelectorAll('form button:not([type])')).toHaveLength(0);
  expect((screen.getByRole('button', { name: '放弃修改' }) as HTMLButtonElement).type).toBe('button');

  // 填错一项：保存禁用，状态文字点名这一项并且可以点。
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

  // 放弃修改：回到加载时的值，红字和「碰过」的记录一起清掉。
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

test('参数配置：在输入框里按 Enter，合法就保存，不合法跳到第一个出错的字段，没改动什么都不做', async () => {
  const user = userEvent.setup();
  const saves = mountConfigTab({ motd: 'Old', 'view-distance': '12', 'server-port': '25565' });

  const motd = await screen.findByRole('textbox', { name: '服务器简介' }) as HTMLInputElement;
  await waitFor(() => expect(motd.value).toBe('Old'));
  await user.type(motd, '{Enter}');
  expect(saves).toEqual([]);

  // 不合法：不保存，显示原因并跳过去。
  const view = screen.getByRole('textbox', { name: '视距（区块）' }) as HTMLInputElement;
  await user.clear(view);
  await user.type(view, '2');
  await user.type(motd, '!{Enter}');
  expect(saves).toEqual([]);
  expect(document.activeElement).toBe(view);
  expect(view.getAttribute('aria-invalid')).toBe('true');
  expect(screen.getByText('填写 3–32 之间的整数')).toBeTruthy();

  // 输入法选词的 Enter 不提交。
  await user.type(view, '0');
  fireEvent.keyDown(view, { key: 'Enter', isComposing: true });
  expect(saves).toEqual([]);

  // 改对了再按 Enter 就保存。
  await user.type(view, '{Enter}');
  await waitFor(() => expect(saves).toEqual([{ motd: 'Old!', 'view-distance': '20', 'server-port': '25565' }]));
  // 实例没在运行（没有重启入口）：只提示已保存，没有重启按钮。
  expect((await screen.findByRole('status')).textContent).toBe('已保存，重启实例后生效。');
  expect(screen.queryByRole('button', { name: '重启实例' })).toBeNull();
  expect(saveButton()).toBeNull();
});

test('参数配置：实例在运行时保存后给出「重启实例」，走实例页原有的重启确认；再次修改或关闭就收起', async () => {
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

  // 再次修改：提示收起，换回「N 项修改未保存」。
  await user.type(motd, '2');
  expect(screen.queryByText('已保存，重启实例后生效')).toBeNull();
  expect(screen.getByText('1 项修改未保存')).toBeTruthy();
  await user.click(saveButton()!);
  expect(await screen.findByText('已保存，重启实例后生效')).toBeTruthy();

  // 关闭按钮只收起提示。
  await user.click(within(document.querySelector('.save-bar') as HTMLElement).getByRole('button', { name: '关闭' }));
  expect(document.querySelector('.save-bar')).toBeNull();

  // 重启入口打开的是页头那个确认框，确认后才发重启请求，提示随之收起。
  await user.type(motd, '3');
  await user.click(saveButton()!);
  await user.click(await screen.findByRole('button', { name: '重启实例' }));
  const dialog = screen.getByRole('dialog', { name: '重启实例「测试服」？' });
  expect(calls.some((call) => call.includes('/restart'))).toBe(false);
  await user.click(within(dialog).getByRole('button', { name: '确认重启' }));
  await waitFor(() => expect(calls.at(-1)).toContain('POST /api/instances/test/restart'));
  expect(screen.queryByText('已保存，重启实例后生效')).toBeNull();
});

test('参数配置：1.18 之前的版本不显示模拟距离，旧值保存时原样带回；版本未知照常显示', async () => {
  const user = userEvent.setup();
  const saves = mountConfigTab({ motd: 'Old', 'simulation-distance': '8' }, '1.17.1');

  const motd = await screen.findByRole('textbox', { name: '服务器简介' }) as HTMLInputElement;
  await waitFor(() => expect(motd.value).toBe('Old'));
  expect(screen.queryByRole('textbox', { name: '模拟距离（区块）' })).toBeNull();
  // 藏起来的键也不出现在「高级选项」里。
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

test('参数配置：「生成动物」被隐藏的版本在世界分组末尾说明原因，不提游戏规则', async () => {
  mountConfigTab({ motd: 'Old' }, '1.21.8');
  const note = await screen.findByText('Minecraft 从 1.21.2 起去掉了「生成动物」这项设置，这个版本不再显示。');
  expect(note.closest('.form-section')!.querySelector('.form-section-title')!.textContent).toBe('世界');
  expect(screen.queryByRole('switch', { name: '生成动物' })).toBeNull();
  expect(screen.queryByText('/gamerule')).toBeNull();
  cleanup();

  // 还有这一项的版本和版本未知时不显示这句话。
  for (const version of ['1.21.1', undefined]) {
    mountConfigTab({ motd: 'Old' }, version);
    expect(await screen.findByRole('switch', { name: '生成动物' })).toBeTruthy();
    expect(screen.queryByText(/去掉了「生成动物」/)).toBeNull();
    cleanup();
  }
});

test('实例设置：保存栏有修改才出现，清空名称时点名并可跳过去，放弃修改恢复，Enter 保存而多行文本框里不提交', async () => {
  const user = userEvent.setup();
  const calls = mountInstancePage('settings', 'stopped');

  const name = await screen.findByRole('textbox', { name: '名称' }) as HTMLInputElement;
  expect(name.value).toBe('测试服');
  const findSave = () => screen.queryByRole('button', { name: '保存设置' }) as HTMLButtonElement | null;
  expect(findSave()).toBeNull();
  expect(document.querySelector('.save-bar-slot')).toBeTruthy();

  // 清空名称：保存禁用，状态文字点名「名称」；红字等点了状态文字或失焦后才显示。
  await user.clear(name);
  expect(findSave()!.disabled).toBe(true);
  expect(findSave()!.type).toBe('submit');
  expect(document.querySelectorAll('form button:not([type])')).toHaveLength(0);
  expect(screen.queryByText('填写实例名称')).toBeNull();
  const jarFile = screen.getByRole('textbox', { name: 'Jar 文件名' }) as HTMLInputElement;
  jarFile.focus();
  // 失焦过的字段直接显示原因；这里再验证状态文字能把焦点带回去。
  fireEvent.click(within(screen.getByRole('status')).getByRole('button', { name: '先修正「名称」' }));
  expect(document.activeElement).toBe(name);
  const error = screen.getByText('填写实例名称');
  expect(name.getAttribute('aria-describedby')!.split(' ')).toContain(error.id);

  await user.click(screen.getByRole('button', { name: '放弃修改' }));
  expect(name.value).toBe('测试服');
  expect(findSave()).toBeNull();
  expect(screen.queryByText('填写实例名称')).toBeNull();

  // 多行文本框里的 Enter 是换行，不提交。
  await user.type(name, '2');
  expect(screen.getByRole('status').textContent).toBe('1 项修改未保存');
  const textarea = document.querySelector('form textarea') as HTMLTextAreaElement;
  expect(textarea).toBeTruthy();
  fireEvent.keyDown(textarea, { key: 'Enter' });
  expect(calls).toEqual([]);

  // 输入框里按 Enter 保存；只改了名称不需要重启，短暂提示已保存。
  await user.type(name, '{Enter}');
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]).toContain('PATCH /api/instances/test ');
  expect(JSON.parse(calls[0]!.slice(calls[0]!.indexOf('{'))).name).toBe('测试服2');
  expect(await screen.findByText('设置已保存。')).toBeTruthy();
  expect(findSave()).toBeNull();
  expect(screen.queryByRole('button', { name: '重启实例' })).toBeNull();
});

test('实例设置：实例在运行时，改了启动才读取的设置保存后给出「重启实例」；只改名称不提示重启', async () => {
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
  // 再次修改时上一条提示收起。
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

test('参数配置：下拉和开关上的 Enter 带出来的隐式提交不保存，点保存按钮照常保存', async () => {
  const user = userEvent.setup();
  const saves = mountConfigTab({ motd: 'Old', difficulty: 'easy' });

  const difficulty = await screen.findByRole('combobox', { name: '难度' }) as HTMLSelectElement;
  await waitFor(() => expect(difficulty.value).toBe('easy'));
  await user.selectOptions(difficulty, 'hard');
  const form = difficulty.closest('form')!;
  // jsdom 不模拟隐式提交，这里手动补上浏览器紧跟在 Enter 之后发出的 submit 事件。
  for (const control of [difficulty, screen.getByRole('switch', { name: '启用白名单' })]) {
    const notPrevented = fireEvent.keyDown(control, { key: 'Enter' });
    // 不拦默认行为，控件自己的键盘操作不受影响。
    expect(notPrevented).toBe(true);
    fireEvent.submit(form);
  }
  expect(saves).toEqual([]);

  await user.click(saveButton()!);
  await waitFor(() => expect(saves).toEqual([{ motd: 'Old', difficulty: 'hard' }]));
});

test('参数配置：保存后实例停止再启动，「重启实例后生效」的提示不会重新出现', async () => {
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

  // 在页头停止实例：提示收起；再启动后配置已经生效，提示不该回来。
  act(() => setRunning(false));
  expect(screen.queryByText('已保存，重启实例后生效')).toBeNull();
  act(() => setRunning(true));
  expect(screen.queryByText('已保存，重启实例后生效')).toBeNull();
  expect(document.querySelector('.save-bar')).toBeNull();
});
