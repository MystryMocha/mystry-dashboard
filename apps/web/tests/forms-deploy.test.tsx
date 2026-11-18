// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { DeployPage } from '../src/pages/DeployPage';
import { setupFormTestEnv } from './form-test-env';

const java25 = { id: 'rt25', path: 'C:/Java/jdk-25/bin/java.exe', version: '25.0.1', majorVersion: 25, source: 'scan', verifiedAt: '', available: true };

/** 请求替身的可调部分：每个用例开头按需要改。 */
let javaRuntimes: unknown[];
/** 为 true 时 Java 列表一直不返回，页面停在「正在检查 Java」。 */
let javaPending: boolean;
let deployBodies: Array<Record<string, unknown>>;

beforeEach(() => {
  setupFormTestEnv();
  javaRuntimes = [java25];
  javaPending = false;
  deployBodies = [];
  // 只是替身：不发真实请求，更不会真的下载核心。部署任务一直停在运行中，页面保持「部署中」。
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    const path = String(url);
    if (path.startsWith('/api/system/java-runtimes')) {
      if (javaPending) return new Promise<Response>(() => {});
      return new Response(JSON.stringify({ runtimes: javaRuntimes, installable: [] }));
    }
    if (path === '/api/system/java') return new Response(JSON.stringify({ available: false }));
    if (/^\/api\/cores\/[a-z]+\/versions$/.test(path)) return new Response(JSON.stringify({ versions: ['26.3', '26.2'] }));
    if (path === '/api/cores/deploy') {
      deployBodies.push(JSON.parse(String(options?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ id: 'deploy-task', type: 'deploy', status: 'pending', progress: 0 }));
    }
    if (path === '/api/tasks/deploy-task') return new Response(JSON.stringify({ id: 'deploy-task', type: 'deploy', status: 'running', progress: 10 }));
    if (path === '/api/system/download-source') return new Response(JSON.stringify({ source: 'official' }));
    return new Response('{}');
  }));
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mountDeploy() {
  return render(<MemoryRouter><DeployPage /></MemoryRouter>);
}

/** 等版本和 Java 都就绪：这时只差 EULA 没勾。 */
async function waitUntilOnlyEulaMissing() {
  expect(await screen.findByRole('button', { name: '勾选同意 Minecraft EULA 后才能部署' })).toBeTruthy();
}

test('部署页 Java 不符：操作栏状态可点并跳到 Java 选择框，第 4 节不再重复这句话', async () => {
  javaRuntimes = [];
  const user = userEvent.setup();
  mountDeploy();
  const status = await screen.findByRole('button', { name: '先安装或选择 Java 25' });
  expect(status.className).toContain('link-button');
  expect(status.getAttribute('type')).toBe('button');
  // 第 4 节在这种情况下没有别的内容，整节不出现；旧的那句长说明也不在页面上。
  expect(screen.queryByRole('heading', { name: /确认并部署/ })).toBeNull();
  expect(screen.queryByText(/这个版本需要 Java 25/)).toBeNull();

  await user.click(status);
  const javaSelect = document.querySelector<HTMLSelectElement>('.deploy-field-anchor[data-field-invalid] select')!;
  expect(javaSelect).toBeTruthy();
  expect(document.activeElement).toBe(javaSelect);
  expect(javaSelect.scrollIntoView).toHaveBeenCalled();
  expect(deployBodies).toHaveLength(0);
});

test('部署页只是在等数据时，操作栏状态是普通文字', async () => {
  javaPending = true;
  mountDeploy();
  const waiting = await screen.findByText('正在检查 Java…');
  expect(waiting.closest('button')).toBeNull();
  expect(waiting.closest('.action-bar-status')).toBeTruthy();
  expect(document.querySelector('.action-bar-status button')).toBeNull();
});

test('部署页实例名称：错误在失焦后才显示并关联输入框，空着不标红，状态文字跳回名称', async () => {
  const user = userEvent.setup();
  mountDeploy();
  await waitUntilOnlyEulaMissing();
  const name = screen.getByLabelText('实例名称') as HTMLInputElement;
  expect(name.value).toBe('我的服务器');

  await user.clear(name);
  await user.paste('a'.repeat(129));
  // 还在输入：操作栏已经说了原因，字段本身先不打断。
  expect(screen.getByRole('button', { name: '实例名称最多 128 个字符' })).toBeTruthy();
  expect(name.getAttribute('aria-invalid')).toBeNull();
  expect(document.querySelector('.field .error')).toBeNull();

  await user.tab();
  const error = document.querySelector('.field .error')!;
  expect(error.textContent).toBe('实例名称最多 128 个字符');
  expect(name.getAttribute('aria-invalid')).toBe('true');
  expect(name.getAttribute('aria-describedby')!.split(' ')).toContain(error.id);

  // 已经在报错的字段每次按键重新检查，改对了马上消失。
  await user.type(name, '{Backspace}');
  expect(document.querySelector('.field .error')).toBeNull();
  expect(name.getAttribute('aria-invalid')).toBeNull();

  // 空的必填项不标红；点操作栏的状态文字回到名称。
  await user.clear(name);
  await user.tab();
  expect(name.getAttribute('aria-invalid')).toBeNull();
  await user.click(screen.getByRole('button', { name: '填写实例名称' }));
  expect(document.activeElement).toBe(name);
});

test('部署页按 Enter：不能部署时显示原因并跳到要改的字段，能部署时只提交一次，多行文本框不提交', async () => {
  const user = userEvent.setup();
  mountDeploy();
  await waitUntilOnlyEulaMissing();
  const name = screen.getByLabelText('实例名称') as HTMLInputElement;
  const eula = screen.getByRole('checkbox', { name: /同意 Minecraft EULA/ }) as HTMLInputElement;
  const submit = screen.getByRole('button', { name: '开始部署' }) as HTMLButtonElement;
  expect(submit.getAttribute('type')).toBe('submit');
  expect(submit.disabled).toBe(true);

  // 名称填错、还没失焦：Enter 让它显示原因，焦点留在名称上。
  await user.clear(name);
  await user.paste('a'.repeat(129));
  expect(document.querySelector('.field .error')).toBeNull();
  await user.keyboard('{Enter}');
  expect(document.querySelector('.field .error')!.textContent).toBe('实例名称最多 128 个字符');
  expect(document.activeElement).toBe(name);

  // 名称改对后只差 EULA：Enter 跳到勾选框，不提交。
  await user.clear(name);
  await user.paste('生存服');
  await user.keyboard('{Enter}');
  expect(document.activeElement).toBe(eula);
  expect(deployBodies).toHaveLength(0);

  // 勾选框里的 Enter 不提交；EULA 仍然要用户自己勾。
  await user.click(eula);
  expect(submit.disabled).toBe(false);
  eula.focus();
  await user.keyboard('{Enter}');
  expect(deployBodies).toHaveLength(0);

  // 多行文本框（JVM 额外参数）里的 Enter 是换行。
  const textarea = document.querySelector<HTMLTextAreaElement>('form textarea')!;
  textarea.focus();
  await user.keyboard('{Enter}');
  expect(deployBodies).toHaveLength(0);
  await user.clear(textarea);
  await waitFor(() => expect(submit.disabled).toBe(false));

  // 可以部署：输入框里按 Enter 提交；连按不会发第二次。
  name.focus();
  await user.keyboard('{Enter}{Enter}');
  await waitFor(() => expect(deployBodies).toHaveLength(1));
  expect(deployBodies[0]).toMatchObject({ name: '生存服', coreType: 'paper', mcVersion: '26.3', acceptEula: true, javaRuntimeId: 'rt25' });
  await waitFor(() => expect(screen.getByRole('button', { name: '部署任务运行中…' })).toBeTruthy());
  // 第 4 节只在有进度或失败原因时出现。
  expect(screen.getByRole('heading', { name: /确认并部署/ })).toBeTruthy();
  expect(deployBodies).toHaveLength(1);
});

test('部署页点主按钮走表单提交，表单里只有它是 submit，可选项统一标「（可选）」', async () => {
  const user = userEvent.setup();
  mountDeploy();
  await waitUntilOnlyEulaMissing();
  expect(screen.getByRole('button', { name: /^Paper 构建版本（可选）/ })).toBeTruthy();
  // 必填项不标。
  expect(screen.getByLabelText('实例名称')).toBeTruthy();
  expect(screen.getByRole('button', { name: /^游戏版本/ }).getAttribute('aria-labelledby')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^游戏版本（可选）/ })).toBeNull();

  await user.click(screen.getByRole('radio', { name: /Fabric/ }));
  expect(await screen.findByRole('button', { name: /^Loader 版本（可选）/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: /^安装器版本（可选）/ })).toBeTruthy();
  await user.click(screen.getByRole('radio', { name: /Paper/ }));
  await waitUntilOnlyEulaMissing();

  // 展开下拉后连同选项一起检查：除主按钮外都必须写明 type="button"，否则点了会误提交。
  await user.click(screen.getByRole('button', { name: /^游戏版本/ }));
  const form = document.querySelector('form')!;
  const buttons = [...form.querySelectorAll('button')];
  expect(buttons.length).toBeGreaterThan(8);
  expect(buttons.filter((button) => button.getAttribute('type') === 'submit')).toHaveLength(1);
  expect(buttons.filter((button) => !['button', 'submit'].includes(button.getAttribute('type') ?? ''))).toHaveLength(0);
  await user.keyboard('{Escape}');

  await user.click(screen.getByRole('checkbox', { name: /同意 Minecraft EULA/ }));
  await user.click(screen.getByRole('button', { name: '开始部署' }));
  await waitFor(() => expect(deployBodies).toHaveLength(1));
  expect(deployBodies[0]?.build).toBeUndefined();
});
