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
  /** 按顺序记下所有写请求。 */
  writes: { method: string; url: string; body: Record<string, unknown> }[];
}

/** 只替身 frp 相关的接口，不碰真实网络，也不会运行 frpc。 */
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
        // 和服务端一样：不是公网端口模式时远程端口存成空。
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

test('frp 服务器表单：字段保留原来的 id，可选项标「（可选）」，端口是数字框，令牌可以点开看', async () => {
  const user = userEvent.setup();
  mountTab();
  const name = await screen.findByLabelText('名称');
  expect(name.id).toBe('frp-name');
  // 只有确实可选的「玩家连接的地址」标了可选，说明仍然关联着输入框。
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

test('frp 服务器表单：错误在失焦后才显示并关联到输入框，改对了马上消失；按钮旁说出先处理哪一项', async () => {
  const user = userEvent.setup();
  mountTab();
  const address = await screen.findByLabelText('服务器地址');
  const save = screen.getByRole('button', { name: '保存 frp 服务器' }) as HTMLButtonElement;
  // 什么都没填：必填项不标红，按钮旁说先填哪一项。
  expect(save.disabled).toBe(true);
  expect(screen.getByRole('button', { name: '先填写「名称」' })).toBeTruthy();
  expect(document.querySelector('[aria-invalid]')).toBeNull();

  await user.type(address, 'http://frp.example.com');
  // 还在输入：不打断；但按钮旁已经指向这一项。
  expect(screen.queryByText(HOST_ERROR)).toBeNull();
  expect(address.getAttribute('aria-invalid')).toBeNull();
  expect(screen.getByRole('button', { name: '先修正「服务器地址」' })).toBeTruthy();

  await user.tab();
  const error = screen.getByText(HOST_ERROR);
  expect(error.id).toBe('frp-address-error');
  expect(address.getAttribute('aria-describedby')!.split(' ')).toContain(error.id);
  expect(address.getAttribute('aria-invalid')).toBe('true');

  // 已经在报错的字段每次按键重新检查。
  await user.clear(address);
  await user.type(address, 'frp.example.com');
  expect(screen.queryByText(HOST_ERROR)).toBeNull();
  expect(address.getAttribute('aria-invalid')).toBeNull();

  // 清空的端口算没填，不标红；填了超出范围的才报错。
  const port = screen.getByLabelText('服务器端口');
  await user.clear(port);
  await user.tab();
  expect(screen.queryByText(PORT_ERROR)).toBeNull();
  await user.type(port, '70000');
  await user.tab();
  expect(screen.getByText(PORT_ERROR).id).toBe('frp-port-error');
  expect(port.getAttribute('aria-describedby')).toBe('frp-port-error');

  // 点按钮旁的那句话：跳到要改的字段。
  await user.click(screen.getByRole('button', { name: '先修正「服务器端口」' }));
  expect(document.activeElement).toBe(port);
});

test('frp 服务器表单：按 Enter 不合法时显示原因并跳到出错字段，只缺必填项时跳到要填的，合法就提交', async () => {
  const user = userEvent.setup();
  const backend = mountTab();
  const name = await screen.findByLabelText('名称');
  const visit = screen.getByLabelText('玩家连接的地址（可选）');
  const address = screen.getByLabelText('服务器地址');
  const token = screen.getByLabelText('令牌');

  // 只缺必填项：没有可标红的字段，跳到第一个空着的。
  await user.type(address, 'frp.example.com{Enter}');
  expect(document.activeElement).toBe(name);
  expect(document.querySelector('[aria-invalid]')).toBeNull();
  expect(backend.writes).toHaveLength(0);

  // 有填错的：按 Enter 跳到出错的字段，原因和它关联着（按过 Enter 之后整张表单的错误都即时显示）。
  await user.type(name, 'Hong Kong');
  await user.type(token, 'secret-token');
  await user.type(visit, 'play.example.com:25565');
  await user.click(token);
  await user.keyboard('{Enter}');
  expect(screen.getByText(HOST_ERROR).id).toBe('frp-visit-error');
  expect(document.activeElement).toBe(visit);
  expect(backend.writes).toHaveLength(0);

  // 改对后在输入框里按 Enter 就提交。
  await user.clear(visit);
  await user.type(visit, 'play.example.com{Enter}');
  await waitFor(() => expect(backend.writes).toHaveLength(1));
  expect(backend.writes[0]).toEqual({
    method: 'POST',
    url: '/api/frp/endpoints',
    body: { name: 'Hong Kong', serverAddr: 'frp.example.com', serverPort: 7000, visitHost: 'play.example.com', transport: 'tcp', tls: true, token: 'secret-token' },
  });
  // 保存后换成穿透设置，新服务器已选中。
  expect((await screen.findByLabelText('frp 服务器') as HTMLSelectElement).value).toBe('e1');
});

test('两张表单互不嵌套，各自只有一个提交按钮；取消后回到没碰过', async () => {
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

  // 按 Enter 让整张表单显示错误；另一张表单不受影响。
  await user.type(address, 'bad host{Enter}');
  expect(screen.getByText(HOST_ERROR)).toBeTruthy();
  expect(screen.getByLabelText('远程端口').getAttribute('aria-invalid')).toBeNull();

  // 取消后重新打开：草稿清空，再填错也要等失焦才报。
  await user.click(screen.getByRole('button', { name: '取消' }));
  await user.click(screen.getByRole('button', { name: '添加 frp 服务器' }));
  const reopened = screen.getByLabelText('服务器地址') as HTMLInputElement;
  expect(reopened.value).toBe('');
  await user.type(reopened, 'bad host');
  expect(screen.queryByText(HOST_ERROR)).toBeNull();
});

test('穿透设置：端口是数字框，按 Enter 不合法时报错并留在字段上，合法就保存，保存后回到没碰过', async () => {
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

  // 保存成功后重置：再填错要等失焦才报。
  await user.clear(remote);
  await user.type(remote, '70000');
  expect(screen.queryByText(PORT_ERROR)).toBeNull();
});

test('穿透设置：切换模式后，被隐藏的端口既不挡住保存，也不会把没保存的草稿提交上去', async () => {
  const user = userEvent.setup();
  const backend = mountTab({ endpoints: [savedEndpoint], tunnel: savedTunnel });
  const mode = await screen.findByLabelText('穿透模式');
  const save = screen.getByRole('button', { name: '保存穿透设置' }) as HTMLButtonElement;

  // 在 STCP 下把「玩家本机端口」删空：当前模式要用它，所以不能保存。
  await user.selectOptions(mode, 'stcp');
  const visitor = screen.getByLabelText('玩家本机端口') as HTMLInputElement;
  expect(visitor.id).toBe('frp-visitor');
  expect(visitor.inputMode).toBe('numeric');
  await user.clear(visitor);
  expect(save.disabled).toBe(true);
  expect(screen.getByRole('button', { name: '先填写「玩家本机端口」' })).toBeTruthy();

  // 切回公网端口：看不见的那个框不再挡住保存，提交的是服务端已保存的 25566，不是删空后的草稿。
  await user.selectOptions(mode, 'public');
  expect(screen.queryByLabelText('玩家本机端口')).toBeNull();
  expect(save.disabled).toBe(false);
  await user.click(save);
  await waitFor(() => expect(backend.writes).toHaveLength(1));
  expect(backend.writes[0]!.body).toEqual({ enabled: false, endpointId: 'e1', mode: 'public', remotePort: 25565, visitorBindPort: 25566 });

  // 反过来：公网端口填错并且已经报错，切到 XTCP 后错误不跟到另一个字段上，远程端口也不提交。
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

test('删除选中的 frp 服务器后改选剩下的第一个，不会停在「看着选了却保存不了」', async () => {
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
