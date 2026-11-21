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

/** The pieces of text that aria-describedby points to. */
function descriptions(input: HTMLElement): string[] {
  return (input.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '');
}

test('setup token: a visible monospace text box with a live count, and surrounding whitespace is trimmed on paste', async () => {
  const user = userEvent.setup();
  const { token } = await mountSetup();
  expect(token.type).toBe('text');
  expect(token.getAttribute('autocomplete')).toBe('off');
  expect(token.getAttribute('spellcheck')).toBe('false');
  expect(token.classList.contains('token-input')).toBe(true);
  // Not truncated with maxLength: extra pasted characters have to be visible.
  expect(token.hasAttribute('maxlength')).toBe(false);
  // Both the count and the description are associated with the input, so screen readers can read them.
  expect(descriptions(token)).toContain('0 / 64');
  expect(descriptions(token).some((text) => text.includes('SETUP_TOKEN'))).toBe(true);

  await user.click(token);
  await user.paste(`  ${TOKEN.slice(0, 61)}\r\n`);
  expect(token.value).toBe(TOKEN.slice(0, 61));
  expect(descriptions(token)).toContain('61 / 64');
  // Still in this box: only the count, no error.
  expect(screen.queryByText(TOKEN_ERROR(61))).toBeNull();
  expect(token.getAttribute('aria-invalid')).toBeNull();

  await user.tab();
  const error = screen.getByText(TOKEN_ERROR(61));
  expect(error.id).toBe('setup-token-error');
  expect(token.getAttribute('aria-describedby')!.split(' ')).toContain(error.id);
  expect(token.getAttribute('aria-invalid')).toBe('true');

  // Already showing an error: recomputed on every keystroke, and it disappears as soon as 64 is reached.
  await user.type(token, 'xy');
  expect(screen.getByText(TOKEN_ERROR(63))).toBeTruthy();
  await user.type(token, 'z');
  expect(screen.queryByText(/令牌是 64 个字符/)).toBeNull();
  expect(token.getAttribute('aria-invalid')).toBeNull();
  expect(descriptions(token)).toContain('64 / 64');

  // Pasting too many also reports how many there are now.
  await user.type(token, 'q');
  expect(descriptions(token)).toContain('65 / 64');
  expect(screen.getByText(TOKEN_ERROR(65))).toBeTruthy();
});

test('setup: the password and username do not report errors while typing, only after blur, and the error disappears as soon as it is fixed', async () => {
  const user = userEvent.setup();
  const { username, password, submit } = await mountSetup();
  expect(password.type).toBe('password');
  expect(password.getAttribute('autocomplete')).toBe('new-password');
  expect(password.required).toBe(true);
  expect(descriptions(password)).toEqual(['密码至少 12 个字符。']);

  await user.type(password, 'short');
  expect(screen.queryByText('密码至少 12 个字符')).toBeNull();
  expect(password.getAttribute('aria-invalid')).toBeNull();
  expect(submit.disabled).toBe(true);

  await user.tab();
  // Tab goes to the password's show button first, and focus has left the input.
  const passwordError = screen.getByText('密码至少 12 个字符');
  expect(passwordError.id).toBe('password-error');
  expect(password.getAttribute('aria-describedby')!.split(' ')).toEqual(['password-error']);
  expect(password.getAttribute('aria-invalid')).toBe('true');

  await user.click(screen.getByRole('button', { name: '显示密码' }));
  expect(password.type).toBe('text');

  await user.type(password, '-longer');
  expect(screen.queryByText('密码至少 12 个字符')).toBeNull();
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

  // A cleared required item is not marked red.
  await user.clear(username);
  await user.tab();
  expect(username.getAttribute('aria-invalid')).toBeNull();
});

test('setup: pressing Enter while the button is disabled shows all reasons and jumps to the first failing field', async () => {
  const user = userEvent.setup();
  const { username, token, password, submit } = await mountSetup();
  // Change the values directly without blur: none of the three fields is "touched".
  await user.type(password, 'short');
  await user.click(token);
  await user.paste('abc');
  expect(screen.queryByText(TOKEN_ERROR(3))).toBeNull();
  expect(submit.disabled).toBe(true);

  // The password box comes later and the token is the first with an error; focus is on the token box now, so switch to the username and press again.
  username.focus();
  await user.keyboard('{Enter}');
  expect(screen.getByText(TOKEN_ERROR(3))).toBeTruthy();
  expect(screen.getByText('密码至少 12 个字符')).toBeTruthy();
  expect(document.activeElement).toBe(token);
  expect(posts).toEqual([]);

  // Pressing Enter again after fixing the token jumps to the next failing field, the password box.
  await user.clear(token);
  await user.paste(TOKEN);
  await user.keyboard('{Enter}');
  expect(document.activeElement).toBe(password);
  expect(posts).toEqual([]);
});

test('setup: when fields are merely empty, Enter marks nothing red and focus goes to the first unfilled field', async () => {
  const user = userEvent.setup();
  const { username, token, password } = await mountSetup();
  username.focus();
  await user.keyboard('{Enter}');
  expect(document.activeElement).toBe(token);
  for (const input of [username, token, password]) expect(input.getAttribute('aria-invalid')).toBeNull();
  expect(document.querySelector('.error')).toBeNull();
});

test('setup: after pasting a full token with whitespace it can be submitted, and Enter submits only once', async () => {
  const user = userEvent.setup();
  const { token, password, submit } = await mountSetup();
  await user.click(token);
  await user.paste(` ${TOKEN}\n`);
  expect(token.value).toBe(TOKEN);
  expect(descriptions(token)).toContain('64 / 64');
  // Press Enter while the password is still empty: focus goes to the password box, but typing next must not report an error on the first character.
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

test('sign-in: the button is not disabled in advance, neither blur nor Enter produces field errors, and the password can be revealed', async () => {
  needsSetup = false;
  const user = userEvent.setup();
  render(<AuthProvider><LoginPage /></AuthProvider>);
  const submit = await screen.findByRole('button', { name: '登录' }) as HTMLButtonElement;
  const password = screen.getByLabelText('密码') as HTMLInputElement;
  expect(screen.queryByLabelText('初始化令牌')).toBeNull();
  // An autofilled password may not have reached React state yet, so the button must always be clickable.
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
