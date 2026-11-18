import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ChildProcess } from 'node:child_process';

function fakeChild(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  exitCode: number | null;
  kill: (signal?: NodeJS.Signals) => boolean;
} {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    exitCode: number | null;
    kill: (signal?: NodeJS.Signals) => boolean;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.exitCode = null;
  child.kill = () => {
    if (child.exitCode !== null) return true;
    child.exitCode = 0;
    child.emit('exit', 0, null);
    return true;
  };
  return child;
}

test('frp 只转发游戏端口，且令牌不进入配置正文或子进程环境', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-frp-'));
  process.env.MYSTRY_HOME = dataRoot;
  process.env.MYSTRY_DATA_DIR = dataRoot;
  process.env.JWT_SECRET = 'a'.repeat(64);
  process.env.SETUP_TOKEN = 'b'.repeat(64);
  process.env.LAUNCHER_TOKEN = 'c'.repeat(64);
  const token = 'bridge-alpha-key';

  // config.ts 在加载时读取环境变量，静态 import 会先用到仓库 .env。
  const { initDb, closeDb } = await import('../db.js');
  const { PanelError } = await import('../utils/errors.js');
  const {
    assertFrpHost,
    renderServerConfig,
    renderVisitorConfig,
    serverIpBlocksTunnel,
  } = await import('./frp-config.js');
  const {
    createFrpEndpoint,
    deleteFrpEndpoint,
    getInstanceTunnelRow,
    listFrpEndpoints,
    saveInstanceTunnel,
  } = await import('./frp-service.js');
  const {
    attachFrpLifecycle,
    describeInstanceTunnel,
    resetFrpRuntimeForTests,
    setFrpGameStatusForTests,
    setFrpcSpawnerForTests,
    shutdownFrp,
    syncInstanceTunnel,
  } = await import('./frp-manager.js');
  const { processManager } = await import('./process-manager.js');
  const { frpcBinaryPath, frpcPlatformSupported, frpcRuntimeDir, resolveFrpcAsset } = await import('./frp-runtime.js');
  const { createInstance } = await import('./instance-service.js');
  const { writeServerProperties } = await import('./config-service.js');

  initDb();
  t.after(async () => {
    await shutdownFrp();
    resetFrpRuntimeForTests();
    closeDb();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  const rendered = renderServerConfig({
    instanceId: 'alpha',
    mode: 'public',
    localPort: 25565,
    remotePort: 25565,
    visitorBindPort: 25565,
    serverAddr: 'frp.example.com',
    serverPort: 7000,
    visitHost: 'play.example.com',
    transport: 'tcp',
    tls: true,
    token,
    secretKey: null,
    tokenPath: path.join(dataRoot, 'frp', 'alpha', 'token'),
  });
  assert.match(rendered, /localIP = "127\.0\.0\.1"/);
  assert.match(rendered, /localPort = 25565/);
  assert.match(rendered, /auth\.tokenSource\.type = "file"/);
  assert.equal(rendered.includes(token), false);
  // frpc 公共配置没有顶层 clientID，严格模式下未知字段会让整份配置被拒。
  assert.equal(/^clientID/m.test(rendered), false);
  assert.match(rendered, /^user = "mystry"$/m);
  assert.equal(assertFrpHost('203.0.113.7'), '203.0.113.7');
  assert.throws(
    () => assertFrpHost('::1'),
    (error: unknown) => error instanceof PanelError && error.messageKey === 'server.frp.hostInvalid',
  );
  assert.equal(serverIpBlocksTunnel(''), false);
  assert.equal(serverIpBlocksTunnel('0.0.0.0'), false);
  assert.equal(serverIpBlocksTunnel('192.168.1.8'), true);
  assert.throws(
    () => assertFrpHost('http://bad.example'),
    (error: unknown) => error instanceof PanelError && error.messageKey === 'server.frp.hostInvalid',
  );

  const first = createInstance({ name: 'Alpha', acceptEula: true });
  const second = createInstance({ name: 'Beta', acceptEula: true });
  const endpoint = createFrpEndpoint({
    name: 'Home',
    serverAddr: 'frp.example.com',
    serverPort: 7000,
    visitHost: 'play.example.com',
    transport: 'tcp',
    tls: true,
    token,
  });
  assert.equal(endpoint.tokenSet, true);
  assert.equal(Object.hasOwn(endpoint, 'token'), false);
  assert.equal(JSON.stringify(listFrpEndpoints()).includes(token), false);
  assert.throws(
    () => saveInstanceTunnel(first.id, { enabled: true, endpointId: endpoint.id, mode: 'public' }),
    (error: unknown) => error instanceof PanelError && error.messageKey === 'server.frp.remotePortRequired',
  );
  saveInstanceTunnel(first.id, { enabled: true, endpointId: endpoint.id, mode: 'public', remotePort: 25565 });
  assert.throws(
    () => saveInstanceTunnel(second.id, { enabled: true, endpointId: endpoint.id, mode: 'public', remotePort: 25565 }),
    (error: unknown) => error instanceof PanelError && error.messageKey === 'server.frp.remotePortInUse',
  );
  assert.throws(
    () => deleteFrpEndpoint(endpoint.id),
    (error: unknown) => error instanceof PanelError && error.messageKey === 'server.frp.endpointInUse',
  );

  // 启用中的隧道仍然挡住删除；关闭后删除端点会顺带清掉已关闭的隧道行和它的文件目录。
  const spare = createFrpEndpoint({
    name: 'Spare',
    serverAddr: 'spare.example.com',
    serverPort: 7000,
    transport: 'tcp',
    tls: true,
    token,
  });
  saveInstanceTunnel(second.id, { enabled: true, endpointId: spare.id, mode: 'public', remotePort: 25570 });
  assert.throws(
    () => deleteFrpEndpoint(spare.id),
    (error: unknown) => error instanceof PanelError && error.messageKey === 'server.frp.endpointInUse',
  );
  saveInstanceTunnel(second.id, { enabled: false, endpointId: spare.id, mode: 'public', remotePort: 25570 });
  const staleDir = path.join(dataRoot, 'frp', second.id);
  fs.mkdirSync(staleDir, { recursive: true });
  fs.writeFileSync(path.join(staleDir, 'token'), token);
  deleteFrpEndpoint(spare.id);
  assert.equal(getInstanceTunnelRow(second.id), null);
  assert.equal(fs.existsSync(staleDir), false);
  assert.equal(listFrpEndpoints().some((item) => item.id === spare.id), false);
  assert.equal(getInstanceTunnelRow(first.id)?.endpoint_id, endpoint.id);

  let spawns = 0;
  setFrpcSpawnerForTests(() => {
    spawns += 1;
    return fakeChild() as unknown as ChildProcess;
  });
  const idle = await syncInstanceTunnel(first.id);
  assert.equal(idle.status, 'stopped');
  assert.equal(idle.detail?.key, 'server.frp.notRunning');
  assert.equal(spawns, 0);
  setFrpGameStatusForTests(() => 'running');
  attachFrpLifecycle();
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => {
    rejections.push(reason);
  };
  process.on('unhandledRejection', onRejection);
  try {
    processManager.emit('status', first.id, 'running');
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  assert.equal(rejections.length, 0);
  const missing = describeInstanceTunnel(first.id);
  assert.equal(missing.status, 'error');
  assert.equal(
    missing.detail?.key,
    frpcPlatformSupported() ? 'server.frp.clientMissing' : 'server.frp.platformUnsupported',
  );
  assert.equal(spawns, 0);


  if (!frpcPlatformSupported()) return;
  const asset = resolveFrpcAsset(process.platform, process.arch);
  fs.mkdirSync(frpcRuntimeDir(), { recursive: true });
  fs.writeFileSync(frpcBinaryPath(), '');
  fs.writeFileSync(path.join(frpcRuntimeDir(), 'archive.sha256'), asset.sha256);
  const child = fakeChild();
  let capturedEnv: NodeJS.ProcessEnv | undefined;
  let capturedCwd = '';
  setFrpcSpawnerForTests((_command, args, options) => {
    spawns += 1;
    capturedEnv = options.env;
    capturedCwd = String(options.cwd);
    assert.deepEqual(args, ['-c', 'frpc.toml']);
    queueMicrotask(() => child.stdout.emit('data', Buffer.from('start proxy success\n')));
    return child as unknown as ChildProcess;
  });
  setFrpGameStatusForTests(() => 'running');
  await syncInstanceTunnel(first.id);
  const running = describeInstanceTunnel(first.id);
  assert.equal(running.status, 'running');
  assert.equal(running.joinAddress, 'play.example.com:25565');
  assert.equal(capturedEnv?.JWT_SECRET, undefined);
  assert.equal(capturedEnv?.SETUP_TOKEN, undefined);
  assert.equal(capturedEnv?.LAUNCHER_TOKEN, undefined);
  assert.equal(capturedEnv?.DATA_DIR, undefined);
  const toml = fs.readFileSync(path.join(capturedCwd, 'frpc.toml'), 'utf8');
  const storedToken = fs.readFileSync(path.join(capturedCwd, 'token'), 'utf8');
  assert.equal(storedToken, token);
  assert.equal(toml.includes(token), false);
  assert.match(toml, /localIP = "127\.0\.0\.1"/);
  child.stdout.emit('data', Buffer.from(`login failed ${token}\n`));
  assert.equal(describeInstanceTunnel(first.id).status, 'running');
  child.stdout.emit('data', Buffer.from('login to the server failed\n'));
  assert.equal(describeInstanceTunnel(first.id).detail?.key, 'server.frp.loginFailed');

  const before = spawns;
  writeServerProperties(first.id, { 'server-ip': '192.168.1.20' });
  const blocked = await syncInstanceTunnel(first.id);
  assert.equal(blocked.serverIpBlocked, true);
  assert.equal(blocked.status, 'error');
  assert.equal(spawns, before);

  saveInstanceTunnel(first.id, {
    enabled: true,
    endpointId: endpoint.id,
    mode: 'stcp',
    visitorBindPort: 25566,
  });
  // 端口留空时游戏用 25565，穿透照常工作，不报「本地端口无效」。
  writeServerProperties(first.id, { 'server-ip': '', 'server-port': '' });
  assert.equal(describeInstanceTunnel(first.id).detail?.key === 'server.frp.localPortInvalid', false);
  const visitorChild = fakeChild();
  setFrpcSpawnerForTests(() => {
    queueMicrotask(() => visitorChild.stdout.emit('data', Buffer.from('start proxy success\n')));
    return visitorChild as unknown as ChildProcess;
  });
  await syncInstanceTunnel(first.id);
  const { renderFriendConfig } = await import('./frp-manager.js');
  const friend = renderFriendConfig(first.id);
  assert.match(friend, /\[\[visitors\]\]/);
  assert.match(friend, /bindAddr = "127\.0\.0\.1"/);
  assert.match(friend, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(renderVisitorConfig({
    instanceId: first.id,
    mode: 'stcp',
    localPort: 25565,
    remotePort: null,
    visitorBindPort: 25566,
    serverAddr: 'frp.example.com',
    serverPort: 7000,
    visitHost: 'play.example.com',
    transport: 'tcp',
    tls: true,
    token,
    secretKey: 'ab'.repeat(32),
    tokenPath: path.join(capturedCwd, 'token'),
  }).includes('secretKey'), true);
});
