// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { DeployPage } from '../src/pages/DeployPage';
import { setupFormTestEnv } from './form-test-env';

const java25 = { id: 'rt25', path: 'C:/Java/jdk-25/bin/java.exe', version: '25.0.1', majorVersion: 25, source: 'scan', verifiedAt: '', available: true };

/** Adjustable parts of the request stub: changed as needed at the start of each case. */
let javaRuntimes: unknown[];
/** When true the Java list never returns, and the page stays on "checking Java". */
let javaPending: boolean;
let deployBodies: Array<Record<string, unknown>>;

beforeEach(() => {
  setupFormTestEnv();
  javaRuntimes = [java25];
  javaPending = false;
  deployBodies = [];
  // A stub only: no real request is sent, let alone a real core download. The deploy task stays running, and the page stays on "deploying".
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

/** Waits until both the versions and Java are ready: at this point only the EULA is unchecked. */
async function waitUntilOnlyEulaMissing() {
  expect(await screen.findByRole('button', { name: '勾选同意 Minecraft EULA 后才能部署' })).toBeTruthy();
}

test('deploy page Java mismatch: the action bar status is clickable and jumps to the Java picker, and section 4 no longer repeats the sentence', async () => {
  javaRuntimes = [];
  const user = userEvent.setup();
  mountDeploy();
  const status = await screen.findByRole('button', { name: '先安装或选择 Java 25' });
  expect(status.className).toContain('link-button');
  expect(status.getAttribute('type')).toBe('button');
  // Section 4 has nothing else in this case, so the whole section is absent; the old long explanation is not on the page either.
  expect(screen.queryByRole('heading', { name: /确认并部署/ })).toBeNull();
  expect(screen.queryByText(/这个版本需要 Java 25/)).toBeNull();

  await user.click(status);
  const javaSelect = document.querySelector<HTMLSelectElement>('.deploy-field-anchor[data-field-invalid] select')!;
  expect(javaSelect).toBeTruthy();
  expect(document.activeElement).toBe(javaSelect);
  expect(javaSelect.scrollIntoView).toHaveBeenCalled();
  expect(deployBodies).toHaveLength(0);
});

test('deploy page: the action bar status is plain text when only waiting for data', async () => {
  javaPending = true;
  mountDeploy();
  const waiting = await screen.findByText('正在检查 Java…');
  expect(waiting.closest('button')).toBeNull();
  expect(waiting.closest('.action-bar-status')).toBeTruthy();
  expect(document.querySelector('.action-bar-status button')).toBeNull();
});

test('deploy page instance name: the error shows only after blur and is associated with the input, empty is not marked red, and the status text jumps back to the name', async () => {
  const user = userEvent.setup();
  mountDeploy();
  await waitUntilOnlyEulaMissing();
  const name = screen.getByLabelText('实例名称') as HTMLInputElement;
  expect(name.value).toBe('我的服务器');

  await user.clear(name);
  await user.paste('a'.repeat(129));
  // Still typing: the action bar has already given the reason, so the field itself does not interrupt yet.
  expect(screen.getByRole('button', { name: '实例名称最多 128 个字符' })).toBeTruthy();
  expect(name.getAttribute('aria-invalid')).toBeNull();
  expect(document.querySelector('.field .error')).toBeNull();

  await user.tab();
  const error = document.querySelector('.field .error')!;
  expect(error.textContent).toBe('实例名称最多 128 个字符');
  expect(name.getAttribute('aria-invalid')).toBe('true');
  expect(name.getAttribute('aria-describedby')!.split(' ')).toContain(error.id);

  // A field already showing an error is rechecked on every keystroke and clears as soon as it is fixed.
  await user.type(name, '{Backspace}');
  expect(document.querySelector('.field .error')).toBeNull();
  expect(name.getAttribute('aria-invalid')).toBeNull();

  // An empty required item is not marked red; clicking the status text in the action bar goes back to the name.
  await user.clear(name);
  await user.tab();
  expect(name.getAttribute('aria-invalid')).toBeNull();
  await user.click(screen.getByRole('button', { name: '填写实例名称' }));
  expect(document.activeElement).toBe(name);
});

test('deploy page Enter: shows the reason and jumps to the field to fix when it cannot deploy, submits only once when it can, and does not submit in multi-line text boxes', async () => {
  const user = userEvent.setup();
  mountDeploy();
  await waitUntilOnlyEulaMissing();
  const name = screen.getByLabelText('实例名称') as HTMLInputElement;
  const eula = screen.getByRole('checkbox', { name: /同意 Minecraft EULA/ }) as HTMLInputElement;
  const submit = screen.getByRole('button', { name: '开始部署' }) as HTMLButtonElement;
  expect(submit.getAttribute('type')).toBe('submit');
  expect(submit.disabled).toBe(true);

  // Name filled in wrong and not blurred yet: Enter makes it show the reason, and focus stays on the name.
  await user.clear(name);
  await user.paste('a'.repeat(129));
  expect(document.querySelector('.field .error')).toBeNull();
  await user.keyboard('{Enter}');
  expect(document.querySelector('.field .error')!.textContent).toBe('实例名称最多 128 个字符');
  expect(document.activeElement).toBe(name);

  // After the name is fixed only the EULA is missing: Enter jumps to the checkbox without submitting.
  await user.clear(name);
  await user.paste('生存服');
  await user.keyboard('{Enter}');
  expect(document.activeElement).toBe(eula);
  expect(deployBodies).toHaveLength(0);

  // Enter in the checkbox does not submit; the EULA still has to be checked by the user.
  await user.click(eula);
  expect(submit.disabled).toBe(false);
  eula.focus();
  await user.keyboard('{Enter}');
  expect(deployBodies).toHaveLength(0);

  // Enter in the multi-line text box (extra JVM arguments) is a line break.
  const textarea = document.querySelector<HTMLTextAreaElement>('form textarea')!;
  textarea.focus();
  await user.keyboard('{Enter}');
  expect(deployBodies).toHaveLength(0);
  await user.clear(textarea);
  await waitFor(() => expect(submit.disabled).toBe(false));

  // Ready to deploy: pressing Enter in an input submits; pressing repeatedly does not send a second time.
  name.focus();
  await user.keyboard('{Enter}{Enter}');
  await waitFor(() => expect(deployBodies).toHaveLength(1));
  expect(deployBodies[0]).toMatchObject({ name: '生存服', coreType: 'paper', mcVersion: '26.3', acceptEula: true, javaRuntimeId: 'rt25' });
  await waitFor(() => expect(screen.getByRole('button', { name: '部署任务运行中…' })).toBeTruthy());
  // Section 4 appears only when there is progress or a failure reason.
  expect(screen.getByRole('heading', { name: /确认并部署/ })).toBeTruthy();
  expect(deployBodies).toHaveLength(1);
});

test('deploy page: the primary button goes through form submission, it is the only submit in the form, and optional items are uniformly marked "(optional)"', async () => {
  const user = userEvent.setup();
  mountDeploy();
  await waitUntilOnlyEulaMissing();
  expect(screen.getByRole('button', { name: /^Paper 构建版本（可选）/ })).toBeTruthy();
  // Required items are not marked.
  expect(screen.getByLabelText('实例名称')).toBeTruthy();
  expect(screen.getByRole('button', { name: /^游戏版本/ }).getAttribute('aria-labelledby')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^游戏版本（可选）/ })).toBeNull();

  await user.click(screen.getByRole('radio', { name: /Fabric/ }));
  expect(await screen.findByRole('button', { name: /^Loader 版本（可选）/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: /^安装器版本（可选）/ })).toBeTruthy();
  await user.click(screen.getByRole('radio', { name: /Paper/ }));
  await waitUntilOnlyEulaMissing();

  // After opening the dropdown, check it together with its options: everything except the primary button must state type="button", or a click would submit by mistake.
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
