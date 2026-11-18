// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthProvider } from '../src/auth';
import { LoginPage } from '../src/pages/LoginPage';
import { setupFormTestEnv } from './form-test-env';

const TOKEN = 'a1b2c3d4'.repeat(8);
const TOKEN_ERROR = (count: number) => `令牌是 64 个字符，现在有 ${count} 个。`;

let needsSetup: boolean;
let posts: { url: string; token: string | null; body: unknown }[];

beforeEach(() => {
  setupFormTestEnv();
  needsSetup = true;
  posts = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/auth/status') return new Response(JSON.stringify({ needsSetup }));
    posts.push({
      url: String(url),
      token: new Headers(options?.headers).get('X-Setup-Token'),
      body: typeof options?.body === 'string' ? JSON.parse(options.body) : null,
    });
    return new Response(JSON.stringify({ token: 'session-token', user: { id: 'u1', username: 'admin' } }));
  }));
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function mountSetup() {
  render(<AuthProvider><LoginPage /></AuthProvider>);
  const token = await screen.findByLabelText('初始化令牌') as HTMLInputElement;
  return {
    token,
    username: screen.getByLabelText('用户名') as HTMLInputElement,
    password: screen.getByLabelText('密码') as HTMLInputElement,
    submit: screen.getByRole('button', { name: '创建并进入' }) as HTMLButtonElement,
  };
}

/** aria-describedby 指向的各段文字。 */
function descriptions(input: HTMLElement): string[] {
  return (input.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '');
}

test('初始化令牌：看得见的等宽文本框，实时计数，粘贴去掉首尾空白', async () => {
  const user = userEvent.setup();
  const { token } = await mountSetup();
  expect(token.type).toBe('text');
  expect(token.getAttribute('autocomplete')).toBe('off');
  expect(token.getAttribute('spellcheck')).toBe('false');
  expect(token.classList.contains('token-input')).toBe(true);
  // 不靠 maxLength 截断：多贴的字符要看得出来。
  expect(token.hasAttribute('maxlength')).toBe(false);
  // 计数和说明都关联到输入框，读屏能读到。
  expect(descriptions(token)).toContain('0 / 64');
  expect(descriptions(token).some((text) => text.includes('SETUP_TOKEN'))).toBe(true);

  await user.click(token);
  await user.paste(`  ${TOKEN.slice(0, 61)}\r\n`);
  expect(token.value).toBe(TOKEN.slice(0, 61));
  expect(descriptions(token)).toContain('61 / 64');
  // 还在这个框里：只有计数，不报错。
  expect(screen.queryByText(TOKEN_ERROR(61))).toBeNull();
  expect(token.getAttribute('aria-invalid')).toBeNull();

  await user.tab();
  const error = screen.getByText(TOKEN_ERROR(61));
  expect(error.id).toBe('setup-token-error');
  expect(token.getAttribute('aria-describedby')!.split(' ')).toContain(error.id);
  expect(token.getAttribute('aria-invalid')).toBe('true');

  // 已经在报错：每次按键重算，补够 64 个马上消失。
  await user.type(token, 'xy');
  expect(screen.getByText(TOKEN_ERROR(63))).toBeTruthy();
  await user.type(token, 'z');
  expect(screen.queryByText(/令牌是 64 个字符/)).toBeNull();
  expect(token.getAttribute('aria-invalid')).toBeNull();
  expect(descriptions(token)).toContain('64 / 64');

  // 贴多了也说得出现在有几个。
  await user.type(token, 'q');
  expect(descriptions(token)).toContain('65 / 64');
  expect(screen.getByText(TOKEN_ERROR(65))).toBeTruthy();
});

test('初始化：密码和用户名不在输入途中报错，失焦后才报，改对马上消失', async () => {
  const user = userEvent.setup();
  const { username, password, submit } = await mountSetup();
  expect(password.type).toBe('password');
  expect(password.getAttribute('autocomplete')).toBe('new-password');
  expect(password.required).toBe(true);
  expect(descriptions(password)).toEqual(['密码至少 12 个字符。']);

  await user.type(password, 'short');
  expect(screen.queryByText('密码至少 12 位')).toBeNull();
  expect(password.getAttribute('aria-invalid')).toBeNull();
  expect(submit.disabled).toBe(true);

  await user.tab();
  // Tab 先到密码的显示按钮，焦点已经离开输入框。
  const passwordError = screen.getByText('密码至少 12 位');
  expect(passwordError.id).toBe('password-error');
  expect(password.getAttribute('aria-describedby')!.split(' ')).toEqual(['password-error', 'password-help']);
  expect(password.getAttribute('aria-invalid')).toBe('true');

  await user.click(screen.getByRole('button', { name: '显示密码' }));
  expect(password.type).toBe('text');

  await user.type(password, '-longer');
  expect(screen.queryByText('密码至少 12 位')).toBeNull();
  expect(password.getAttribute('aria-invalid')).toBeNull();

  await user.clear(username);
  await user.type(username, 'a');
  expect(screen.queryByText('用户名至少 2 个字符')).toBeNull();
  await user.tab();
  const nameError = screen.getByText('用户名至少 2 个字符');
  expect(nameError.id).toBe('username-error');
  expect(username.getAttribute('aria-describedby')).toBe('username-error');
  expect(username.getAttribute('aria-invalid')).toBe('true');
  await user.type(username, 'b');
  expect(screen.queryByText('用户名至少 2 个字符')).toBeNull();

  // 清空的必填项不标红。
  await user.clear(username);
  await user.tab();
  expect(username.getAttribute('aria-invalid')).toBeNull();
});

test('初始化：按钮禁用时按 Enter 显示全部原因并跳到第一个出错的字段', async () => {
  const user = userEvent.setup();
  const { username, token, password, submit } = await mountSetup();
  // 直接改值，不经过失焦：三个字段都没「碰过」。
  await user.type(password, 'short');
  await user.click(token);
  await user.paste('abc');
  expect(screen.queryByText(TOKEN_ERROR(3))).toBeNull();
  expect(submit.disabled).toBe(true);

  // 密码框在后面，令牌是第一个出错的；此时焦点在令牌框，换到用户名再按。
  username.focus();
  await user.keyboard('{Enter}');
  expect(screen.getByText(TOKEN_ERROR(3))).toBeTruthy();
  expect(screen.getByText('密码至少 12 位')).toBeTruthy();
  expect(document.activeElement).toBe(token);
  expect(posts).toEqual([]);

  // 令牌改对后再按 Enter，跳到下一个出错的密码框。
  await user.clear(token);
  await user.paste(TOKEN);
  await user.keyboard('{Enter}');
  expect(document.activeElement).toBe(password);
  expect(posts).toEqual([]);
});

test('初始化：只是还空着时按 Enter 不标红，焦点到第一个没填的字段', async () => {
  const user = userEvent.setup();
  const { username, token, password } = await mountSetup();
  username.focus();
  await user.keyboard('{Enter}');
  expect(document.activeElement).toBe(token);
  for (const input of [username, token, password]) expect(input.getAttribute('aria-invalid')).toBeNull();
  expect(document.querySelector('.error')).toBeNull();
});

test('初始化：粘贴带空白的完整令牌后可以提交，Enter 只提交一次', async () => {
  const user = userEvent.setup();
  const { token, password, submit } = await mountSetup();
  await user.click(token);
  await user.paste(` ${TOKEN}\n`);
  expect(token.value).toBe(TOKEN);
  expect(descriptions(token)).toContain('64 / 64');
  // 密码还空着就按 Enter：焦点到密码框，但接着输入时不能第一个字符就报错。
  await user.keyboard('{Enter}');
  expect(document.activeElement).toBe(password);
  expect(posts).toEqual([]);
  await user.type(password, 'short');
  expect(document.querySelector('.error')).toBeNull();
  expect(password.getAttribute('aria-invalid')).toBeNull();
  await user.clear(password);
  await user.type(password, 'long-enough-password');
  expect(submit.disabled).toBe(false);
  await user.keyboard('{Enter}');
  await waitFor(() => expect(posts.length).toBe(1));
  expect(posts[0]).toEqual({ url: '/api/auth/setup', token: TOKEN, body: { username: 'admin', password: 'long-enough-password' } });
  expect(document.querySelector('.error')).toBeNull();
});

test('登录：按钮不预先禁用，失焦和 Enter 都不出字段错误，密码可以点开看', async () => {
  needsSetup = false;
  const user = userEvent.setup();
  render(<AuthProvider><LoginPage /></AuthProvider>);
  const submit = await screen.findByRole('button', { name: '登录' }) as HTMLButtonElement;
  const password = screen.getByLabelText('密码') as HTMLInputElement;
  expect(screen.queryByLabelText('初始化令牌')).toBeNull();
  // 自动填充的密码可能还没进 React 状态，按钮必须一直可点。
  expect(submit.disabled).toBe(false);
  expect(password.getAttribute('autocomplete')).toBe('current-password');
  expect(password.required).toBe(true);
  expect(password.hasAttribute('aria-describedby')).toBe(false);

  await user.type(password, 'x');
  await user.tab();
  expect(password.getAttribute('aria-invalid')).toBeNull();
  expect(document.querySelector('.error')).toBeNull();
  await user.click(screen.getByRole('button', { name: '显示密码' }));
  expect(password.type).toBe('text');

  await user.click(password);
  await user.keyboard('{Enter}');
  await waitFor(() => expect(posts.length).toBe(1));
  expect(posts[0]).toMatchObject({ url: '/api/auth/login', body: { username: 'admin', password: 'x' } });
});
