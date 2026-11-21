// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MultiplayerTab } from '../src/components/MultiplayerTab';
import { setupFormTestEnv } from './form-test-env';

beforeEach(setupFormTestEnv);

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const HOST_ERROR = '请填写主机名或 IP 地址，不要带协议、路径或端口';
const PORT_ERROR = '端口填写 1–65535 之间的整数';

interface Backend {
  endpoints: Record<string, unknown>[];
  tunnel: Record<string, unknown>;
  /** Records all write requests in order. */
  writes: { method: string; url: string; body: Record<string, unknown> }[];
}

/** Stubs only the frp-related endpoints, without touching the real network or running frpc. */
function mountTab(options: { endpoints?: Record<string, unknown>[]; tunnel?: Record<string, unknown> } = {}): Backend {
  const backend: Backend = {
    endpoints: options.endpoints ?? [],
    tunnel: {
      instanceId: 'test', enabled: false, endpointId: null, mode: 'public', remotePort: null, visitorBindPort: 25566,
      localPort: 25565, status: 'disabled', joinAddress: null, serverIpBlocked: false, runtimeInstalled: true, detail: null,
      ...options.tunnel,
    },
    writes: [],
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      backend.writes.push({ method, url, body });
      if (url === '/api/frp/endpoints') {
        const { token: _token, ...rest } = body;
        const created = { id: `e${backend.endpoints.length + 1}`, ...rest, tokenSet: true };
        backend.endpoints = [...backend.endpoints, created];
        return new Response(JSON.stringify(created));
      }
      if (method === 'DELETE' && url.startsWith('/api/frp/endpoints/')) {
        backend.endpoints = backend.endpoints.filter((endpoint) => `/api/frp/endpoints/${String(endpoint.id)}` !== url);
        return new Response('{}');
      }
      if (url === '/api/instances/test/tunnel') {
        // Same as the server: the remote port is stored empty when not in public port mode.
        backend.tunnel = { ...backend.tunnel, ...body, remotePort: body.mode === 'public' ? body.remotePort : null };
        return new Response(JSON.stringify(backend.tunnel));
      }
    }
    const data = url === '/api/frp/endpoints' ? backend.endpoints
      : url === '/api/frp/runtime' ? { version: '0.71.1', installed: true, platformSupported: true, archive: null }
      : url === '/api/instances/test/tunnel' ? backend.tunnel
      : null;
    return data ? new Response(JSON.stringify(data)) : new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }));
  render(<MultiplayerTab instanceId="test" guide={{ open: false, onClose: () => {} }} />);
  return backend;
}

const savedEndpoint = { id: 'e1', name: 'Hong Kong', serverAddr: 'frp.example.com', serverPort: 7000, visitHost: '', transport: 'tcp', tls: true, tokenSet: true };
const savedTunnel = { endpointId: 'e1', mode: 'public', remotePort: 25565, visitorBindPort: 25566 };

function describedTexts(input: HTMLElement): string[] {
  return (input.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? '');
}

test('frp server form: fields keep their original ids, optional items are marked "(optional)", the port is a number box and the token can be revealed', async () => {
  const user = userEvent.setup();
  mountTab();
  const name = await screen.findByLabelText('名称');
  expect(name.id).toBe('frp-name');
  // Only "Address players connect to", which really is optional, is marked optional, and the description is still associated with the input.
  const visit = screen.getByLabelText('玩家连接的地址（可选）');
  expect(visit.id).toBe('frp-visit');
  expect(describedTexts(visit)).toEqual(['和服务器地址相同时留空。']);
  expect(screen.queryByLabelText('服务器地址（可选）')).toBeNull();
  expect(screen.getByLabelText('服务器地址').id).toBe('frp-address');
  expect(screen.getByLabelText('传输协议').id).toBe('frp-transport');

  const port = screen.getByLabelText('服务器端口') as HTMLInputElement;
  expect(port.id).toBe('frp-port');
  expect(port.type).toBe('text');
  expect(port.inputMode).toBe('numeric');
  await user.clear(port);
  await user.type(port, '70x0e0');
  expect(port.value).toBe('7000');

  const token = screen.getByLabelText('令牌') as HTMLInputElement;
  expect(token.id).toBe('frp-token');
  expect(token.type).toBe('password');
  expect(token.getAttribute('autocomplete')).toBe('off');
  await user.type(token, 'secret-token');
  await user.click(screen.getByRole('button', { name: '显示密码' }));
  expect(token.type).toBe('text');
  expect(token.value).toBe('secret-token');
});

test('frp server form: errors show only after blur and are associated with the input, and disappear once fixed; the text beside the button says which item to handle first', async () => {
  const user = userEvent.setup();
  mountTab();
  const address = await screen.findByLabelText('服务器地址');
  const save = screen.getByRole('button', { name: '保存 frp 服务器' }) as HTMLButtonElement;
  // Nothing filled in: required items are not marked red, and the text beside the button says which to fill in first.
  expect(save.disabled).toBe(true);
  expect(screen.getByRole('button', { name: '先填写「名称」' })).toBeTruthy();
  expect(document.querySelector('[aria-invalid]')).toBeNull();

  await user.type(address, 'http://frp.example.com');
  // Still typing: no interruption; but the text beside the button already points at this item.
  expect(screen.queryByText(HOST_ERROR)).toBeNull();
  expect(address.getAttribute('aria-invalid')).toBeNull();
  expect(screen.getByRole('button', { name: '先修正「服务器地址」' })).toBeTruthy();

  await user.tab();
  const error = screen.getByText(HOST_ERROR);
  expect(error.id).toBe('frp-address-error');
  expect(address.getAttribute('aria-describedby')!.split(' ')).toContain(error.id);
  expect(address.getAttribute('aria-invalid')).toBe('true');

  // A field already showing an error is rechecked on every keystroke.
  await user.clear(address);
  await user.type(address, 'frp.example.com');
  expect(screen.queryByText(HOST_ERROR)).toBeNull();
  expect(address.getAttribute('aria-invalid')).toBeNull();

  // A cleared port counts as not filled in and is not marked red; only an out-of-range value reports an error.
  const port = screen.getByLabelText('服务器端口');
  await user.clear(port);
  await user.tab();
  expect(screen.queryByText(PORT_ERROR)).toBeNull();
  await user.type(port, '70000');
  await user.tab();
  expect(screen.getByText(PORT_ERROR).id).toBe('frp-port-error');
  expect(port.getAttribute('aria-describedby')).toBe('frp-port-error');

  // Click the sentence beside the button: it jumps to the field to fix.
  await user.click(screen.getByRole('button', { name: '先修正「服务器端口」' }));
  expect(document.activeElement).toBe(port);
});

test('frp server form: Enter shows the reason and jumps to the failing field when invalid, jumps to the one to fill in when only required items are missing, and submits when valid', async () => {
  const user = userEvent.setup();
  const backend = mountTab();
  const name = await screen.findByLabelText('名称');
  const visit = screen.getByLabelText('玩家连接的地址（可选）');
  const address = screen.getByLabelText('服务器地址');
  const token = screen.getByLabelText('令牌');

  // Only required items missing: there is no field to mark red, so it jumps to the first empty one.
  await user.type(address, 'frp.example.com{Enter}');
  expect(document.activeElement).toBe(name);
  expect(document.querySelector('[aria-invalid]')).toBeNull();
  expect(backend.writes).toHaveLength(0);

  // Something filled in wrong: Enter jumps to the failing field, with the reason associated with it (after Enter is pressed, errors across the whole form show immediately).
  await user.type(name, 'Hong Kong');
  await user.type(token, 'secret-token');
  await user.type(visit, 'play.example.com:25565');
  await user.click(token);
  await user.keyboard('{Enter}');
  expect(screen.getByText(HOST_ERROR).id).toBe('frp-visit-error');
  expect(document.activeElement).toBe(visit);
  expect(backend.writes).toHaveLength(0);

  // After fixing it, pressing Enter in the input submits.
  await user.clear(visit);
  await user.type(visit, 'play.example.com{Enter}');
  await waitFor(() => expect(backend.writes).toHaveLength(1));
  expect(backend.writes[0]).toEqual({
    method: 'POST',
    url: '/api/frp/endpoints',
    body: { name: 'Hong Kong', serverAddr: 'frp.example.com', serverPort: 7000, visitHost: 'play.example.com', transport: 'tcp', tls: true, token: 'secret-token' },
  });
  // After saving it switches to the tunnel settings, with the new server selected.
  expect((await screen.findByLabelText('frp 服务器') as HTMLSelectElement).value).toBe('e1');
});

test('the two forms are not nested and each has only one submit button; cancelling returns to untouched', async () => {
  const user = userEvent.setup();
  mountTab({ endpoints: [savedEndpoint], tunnel: savedTunnel });
  await user.click(await screen.findByRole('button', { name: '添加 frp 服务器' }));
  const address = screen.getByLabelText('服务器地址');
  expect(document.querySelectorAll('form')).toHaveLength(2);
  expect(document.querySelectorAll('form form')).toHaveLength(0);
  for (const form of document.querySelectorAll('form')) {
    const submits = [...form.querySelectorAll('button')].filter((button) => button.getAttribute('type') !== 'button');
    expect(submits).toHaveLength(1);
    expect(submits[0]!.getAttribute('type')).toBe('submit');
  }
  expect(screen.getByRole('button', { name: '保存穿透设置' }).getAttribute('type')).toBe('submit');
  expect(screen.getByRole('button', { name: '保存 frp 服务器' }).getAttribute('type')).toBe('submit');
  expect(screen.getByRole('button', { name: '删除 frp 服务器' }).getAttribute('type')).toBe('button');
  expect(screen.getByRole('button', { name: '取消' }).getAttribute('type')).toBe('button');

  // Pressing Enter makes the whole form show errors; the other form is unaffected.
  await user.type(address, 'bad host{Enter}');
  expect(screen.getByText(HOST_ERROR)).toBeTruthy();
  expect(screen.getByLabelText('远程端口').getAttribute('aria-invalid')).toBeNull();

  // Reopen after cancelling: the draft is cleared, and a new mistake again waits for blur before reporting.
  await user.click(screen.getByRole('button', { name: '取消' }));
  await user.click(screen.getByRole('button', { name: '添加 frp 服务器' }));
  const reopened = screen.getByLabelText('服务器地址') as HTMLInputElement;
  expect(reopened.value).toBe('');
  await user.type(reopened, 'bad host');
  expect(screen.queryByText(HOST_ERROR)).toBeNull();
});

test('tunnel settings: the port is a number box, Enter reports the error and stays on the field when invalid, saves when valid, and returns to untouched after saving', async () => {
  const user = userEvent.setup();
  const backend = mountTab({ endpoints: [savedEndpoint], tunnel: savedTunnel });
  const remote = await screen.findByLabelText('远程端口') as HTMLInputElement;
  expect(remote.id).toBe('frp-remote');
  expect(remote.type).toBe('text');
  expect(remote.inputMode).toBe('numeric');
  expect(screen.getByLabelText('frp 服务器').id).toBe('frp-endpoint');
  expect(screen.getByLabelText('穿透模式').id).toBe('frp-mode');

  await user.clear(remote);
  await user.type(remote, '7x0000');
  expect(remote.value).toBe('70000');
  expect(screen.queryByText(PORT_ERROR)).toBeNull();
  expect((screen.getByRole('button', { name: '保存穿透设置' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('button', { name: '先修正「远程端口」' })).toBeTruthy();

  await user.keyboard('{Enter}');
  const error = screen.getByText(PORT_ERROR);
  expect(error.id).toBe('frp-remote-error');
  expect(remote.getAttribute('aria-describedby')).toBe('frp-remote-error');
  expect(remote.getAttribute('aria-invalid')).toBe('true');
  expect(document.activeElement).toBe(remote);
  expect(backend.writes).toHaveLength(0);

  await user.clear(remote);
  await user.type(remote, '25570{Enter}');
  await waitFor(() => expect(backend.writes).toHaveLength(1));
  expect(backend.writes[0]!.body).toEqual({ enabled: false, endpointId: 'e1', mode: 'public', remotePort: 25570, visitorBindPort: 25566 });
  expect(await screen.findByText('穿透设置已保存。')).toBeTruthy();

  // Reset after a successful save: a new mistake waits for blur before reporting.
  await user.clear(remote);
  await user.type(remote, '70000');
  expect(screen.queryByText(PORT_ERROR)).toBeNull();
});

test('tunnel settings: after switching modes the hidden port neither blocks saving nor submits an unsaved draft', async () => {
  const user = userEvent.setup();
  const backend = mountTab({ endpoints: [savedEndpoint], tunnel: savedTunnel });
  const mode = await screen.findByLabelText('穿透模式');
  const save = screen.getByRole('button', { name: '保存穿透设置' }) as HTMLButtonElement;

  // Under STCP, clear "player local port": the current mode needs it, so it cannot be saved.
  await user.selectOptions(mode, 'stcp');
  const visitor = screen.getByLabelText('玩家本机端口') as HTMLInputElement;
  expect(visitor.id).toBe('frp-visitor');
  expect(visitor.inputMode).toBe('numeric');
  await user.clear(visitor);
  expect(save.disabled).toBe(true);
  expect(screen.getByRole('button', { name: '先填写「玩家本机端口」' })).toBeTruthy();

  // Switch back to public port: the invisible box no longer blocks saving, and what is submitted is the 25566 saved on the server, not the cleared draft.
  await user.selectOptions(mode, 'public');
  expect(screen.queryByLabelText('玩家本机端口')).toBeNull();
  expect(save.disabled).toBe(false);
  await user.click(save);
  await waitFor(() => expect(backend.writes).toHaveLength(1));
  expect(backend.writes[0]!.body).toEqual({ enabled: false, endpointId: 'e1', mode: 'public', remotePort: 25565, visitorBindPort: 25566 });

  // The other way round: the public port is filled in wrong and already showing an error; after switching to XTCP the error does not follow onto another field, and the remote port is not submitted.
  const remote = await screen.findByLabelText('远程端口');
  await user.clear(remote);
  await user.type(remote, '70000');
  await user.tab();
  expect(screen.getByText(PORT_ERROR)).toBeTruthy();
  await user.selectOptions(mode, 'xtcp');
  expect(screen.queryByText(PORT_ERROR)).toBeNull();
  expect(screen.getByLabelText('玩家本机端口').getAttribute('aria-invalid')).toBeNull();
  expect(save.disabled).toBe(false);
  await user.click(save);
  await waitFor(() => expect(backend.writes).toHaveLength(2));
  expect(backend.writes[1]!.body).toEqual({ enabled: false, endpointId: 'e1', mode: 'xtcp', visitorBindPort: 25566 });
});

test('after deleting the selected frp server the first remaining one is selected, without getting stuck at "looks selected but cannot be saved"', async () => {
  const user = userEvent.setup();
  const backend = mountTab({ endpoints: [savedEndpoint, { ...savedEndpoint, id: 'e2', name: 'Tokyo' }], tunnel: savedTunnel });
  const select = await screen.findByLabelText('frp 服务器') as HTMLSelectElement;
  expect(select.value).toBe('e1');
  await user.click(screen.getByRole('button', { name: '删除 frp 服务器' }));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除 frp 服务器' }));
  await waitFor(() => expect(backend.writes).toHaveLength(1));
  expect(backend.writes[0]).toMatchObject({ method: 'DELETE', url: '/api/frp/endpoints/e1' });
  await waitFor(() => expect(select.value).toBe('e2'));
  expect((screen.getByRole('button', { name: '保存穿透设置' }) as HTMLButtonElement).disabled).toBe(false);
});
