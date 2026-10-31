import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';
import type { ChildProcess } from 'node:child_process';

type ZipTestEntry = {
  name: string;
  contents: Buffer;
  compression?: 0 | 8;
  /** 写进中央目录的解压大小，默认与实际一致；用来模拟谎报大小的压缩包 */
  declaredSize?: number;
};

/** 手写最小 ZIP（本地文件头 + 中央目录 + EOCD），不依赖外部工具。 */
function createZip(entries: readonly ZipTestEntry[]): Buffer {
  const localEntries: Buffer[] = [];
  const centralEntries: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compression = entry.compression ?? 0;
    const compressed = compression === 8 ? deflateRawSync(entry.contents) : entry.contents;
    const declared = entry.declaredSize ?? entry.contents.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(compression, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(compression, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(declared, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    localEntries.push(local, name, compressed);
    centralEntries.push(central, name);
    localOffset += local.length + name.length + compressed.length;
  }
  const centralSize = centralEntries.reduce((total, entry) => total + entry.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localEntries, ...centralEntries, eocd]);
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等待条件超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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

test('虚拟局域网只放开游戏端口，密钥不进命令行或子进程环境', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-lan-'));
  process.env.MYSTRY_HOME = dataRoot;
  process.env.MYSTRY_DATA_DIR = dataRoot;
  process.env.JWT_SECRET = 'a'.repeat(64);
  process.env.SETUP_TOKEN = 'b'.repeat(64);
  process.env.LAUNCHER_TOKEN = 'c'.repeat(64);

  const { initDb, closeDb } = await import('../db.js');
  const { PanelError } = await import('../utils/errors.js');
  const { config } = await import('../config.js');
  const {
    renderFriendInstructions,
    renderLanToml,
    serverIpBlocksLan,
  } = await import('./lan-config.js');
  const { getInstanceLanRow, saveInstanceLan } = await import('./lan-service.js');
  const {
    describeInstanceLan,
    renderLanFriendConfig,
    resetLanRuntimeForTests,
    setLanCliRunnerForTests,
    setLanGameStatusForTests,
    setLanProbeIntervalsForTests,
    setLanSpawnerForTests,
    shutdownLan,
    syncInstanceLan,
  } = await import('./lan-manager.js');
  const { lanCorePath, lanPlatformSupported, lanRuntimeDir, resolveLanAsset } = await import('./lan-runtime.js');
  const { createInstance } = await import('./instance-service.js');
  const { writeServerProperties } = await import('./config-service.js');

  initDb();
  t.after(async () => {
    await shutdownLan();
    resetLanRuntimeForTests();
    closeDb();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  assert.equal(serverIpBlocksLan(''), false);
  assert.equal(serverIpBlocksLan('0.0.0.0'), false);
  assert.equal(serverIpBlocksLan('127.0.0.1'), true);
  assert.equal(serverIpBlocksLan('192.168.1.8'), true);

  const rendered = renderLanToml({
    networkName: `mystry-${'ab'.repeat(16)}`,
    networkSecret: 'cd'.repeat(32),
    octet: 12,
    gamePort: 25565,
  });
  assert.match(rendered, /ipv4 = "10\.126\.12\.1"/);
  assert.match(rendered, /tcp_whitelist = \["25565"\]/);
  assert.match(rendered, /udp_whitelist = \["1"\]/);
  assert.match(rendered, /listeners = \[\]/);
  assert.match(rendered, /private_mode = true/);
  assert.match(rendered, /network_secret = "cdcd/);
  assert.doesNotMatch(rendered, /socks5|port_forward|proxy_network|0\.0\.0\.0:11010|enable_exit_node = true/);
  const friend = renderFriendInstructions({
    networkName: `mystry-${'ab'.repeat(16)}`,
    networkSecret: 'cd'.repeat(32),
    octet: 12,
    gamePort: 25565,
  });
  assert.match(friend, /10\.126\.12\.1:25565/);
  assert.match(friend, /--tcp-whitelist 1/);
  assert.match(friend, /--udp-whitelist 1/);
  assert.match(friend, /--no-listener=true/);
  assert.match(friend, /--dhcp/);
  assert.doesNotMatch(friend, /--socks5|0\.0\.0\.0:11010/);

  const first = createInstance({ name: 'Alpha', acceptEula: true });
  const second = createInstance({ name: 'Beta', acceptEula: true });
  const idle = saveInstanceLan(first.id, { enabled: true });
  const other = saveInstanceLan(second.id, { enabled: true });
  assert.notEqual(idle.octet, other.octet);
  assert.notEqual(idle.networkSecret, other.networkSecret);
  const again = saveInstanceLan(first.id, { enabled: true });
  assert.equal(again.networkSecret, idle.networkSecret);

  setLanGameStatusForTests(() => 'stopped');
  const stopped = await syncInstanceLan(first.id);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.detail?.key, 'server.lan.notRunning');
  assert.equal(stopped.virtualIp, null);

  writeServerProperties(first.id, { 'server-ip': '127.0.0.1', 'server-port': '25565' });
  setLanGameStatusForTests(() => 'running');
  const loopback = await syncInstanceLan(first.id);
  assert.equal(loopback.serverIpBlocked, true);
  assert.equal(loopback.detail?.key, 'server.lan.serverIpBlocked');
  assert.throws(
    () => renderLanFriendConfig(first.id),
    (error: unknown) => error instanceof PanelError && error.messageKey === 'server.lan.serverIpBlocked',
  );

  writeServerProperties(first.id, { 'server-ip': '', 'server-port': String(config.port) });
  const panelPort = await syncInstanceLan(first.id);
  assert.equal(panelPort.detail?.key, 'server.lan.localPortIsPanel');

  writeServerProperties(first.id, { 'server-ip': '', 'server-port': '25565' });
  const missing = await syncInstanceLan(first.id);
  assert.equal(
    missing.detail?.key,
    lanPlatformSupported() ? 'server.lan.clientMissing' : 'server.lan.platformUnsupported',
  );
  if (!lanPlatformSupported()) return;

  const asset = resolveLanAsset(process.platform, process.arch);
  fs.mkdirSync(lanRuntimeDir(), { recursive: true });
  fs.writeFileSync(lanCorePath(), '');
  fs.writeFileSync(path.join(lanRuntimeDir(), asset.cliName), '');
  for (const name of asset.extraNames) fs.writeFileSync(path.join(lanRuntimeDir(), name), '');
  fs.writeFileSync(path.join(lanRuntimeDir(), 'archive.sha256'), asset.sha256);

  const child = fakeChild();
  let capturedEnv: NodeJS.ProcessEnv | undefined;
  let capturedArgs: readonly string[] = [];
  setLanSpawnerForTests((_command, args, options) => {
    capturedArgs = args;
    capturedEnv = options.env;
    return child as unknown as ChildProcess;
  });
  setLanCliRunnerForTests(async () => JSON.stringify({ ipv4_addr: `${describeReadyIp()}/24` }));
  const running = await syncInstanceLan(first.id);
  assert.equal(running.status, 'running');
  assert.equal(running.joinAddress, `${running.virtualIp}:25565`);
  assert.match(running.virtualIp ?? '', /^10\.126\.(?:[1-9]|[1-9]\d|1[0-9]\d|2[0-4]\d|25[0-4])\.1$/);
  assert.notEqual(running.virtualIp, '10.126.126.1');
  assert.deepEqual(capturedArgs[0], '-c');
  assert.deepEqual(capturedArgs[1], 'core.toml');
  assert.match(capturedArgs[2] ?? '', /^--rpc-portal$/);
  assert.match(capturedArgs[3] ?? '', /^127\.0\.0\.1:\d+$/);
  assert.equal(capturedArgs.length, 4);
  assert.equal(capturedEnv?.JWT_SECRET, undefined);
  assert.equal(capturedEnv?.DATA_DIR, undefined);
  assert.equal(capturedEnv?.MYSTRY_DATA_DIR, undefined);
  assert.equal(capturedEnv?.ET_NETWORK_SECRET, undefined);
  const toml = fs.readFileSync(path.join(dataRoot, 'lan', first.id, 'core.toml'), 'utf8');
  assert.match(toml, new RegExp(`network_secret = "${idle.networkSecret}"`));
  assert.match(toml, /tcp_whitelist = \["25565"\]/);
  assert.doesNotMatch(capturedArgs.join(' '), new RegExp(idle.networkSecret));
  const instructions = renderLanFriendConfig(first.id);
  assert.match(instructions, new RegExp(idle.networkSecret));
  assert.match(instructions, new RegExp(`${running.virtualIp}:25565`));
  assert.equal(JSON.stringify(running).includes(idle.networkSecret), false);
  assert.equal(getInstanceLanRow(first.id)?.networkSecret, idle.networkSecret);

  await t.test('地址迟迟拿不到时持续探测，拿到后变为运行中；被替换的旧探测循环退出', async () => {
    // 慢速间隔明显长于重启耗时，旧循环醒来时新一代已就位，才能暴露代次守卫失效。
    setLanProbeIntervalsForTests({ fastMs: 5, slowMs: 40, fastAttempts: 3 });
    writeServerProperties(second.id, { 'server-ip': '', 'server-port': '25566' });
    const expectedIp = `10.126.${getInstanceLanRow(second.id)?.octet}.1`;
    const calls: number[] = [];
    let ready = false;
    setLanCliRunnerForTests(async (rpcPort) => {
      calls.push(rpcPort);
      if (!ready) throw new Error('管理端口还没打开');
      return JSON.stringify({ ipv4_addr: `${expectedIp}/24` });
    });
    setLanSpawnerForTests(() => fakeChild() as unknown as ChildProcess);

    const starting = await syncInstanceLan(second.id);
    assert.equal(starting.status, 'starting');
    const oldPort = calls[0];
    assert.ok(oldPort);
    // 快速探测用完后只提示等待，状态仍是 starting，循环继续。
    await waitFor(() => describeInstanceLan(second.id).detail?.key === 'server.lan.waitingForAddress');
    const countOld = () => calls.filter((port) => port === oldPort).length;
    const before = countOld();
    await waitFor(() => countOld() > before + 2);
    assert.equal(describeInstanceLan(second.id).status, 'starting');

    // 改端口让配置变化，触发停止旧客户端、启动新一代。
    writeServerProperties(second.id, { 'server-ip': '', 'server-port': '25567' });
    const restarted = await syncInstanceLan(second.id);
    assert.equal(restarted.status, 'starting');
    const newPort = calls[calls.length - 1];
    assert.notEqual(newPort, oldPort);
    const oldAfterRestart = countOld();
    await waitFor(() => calls.filter((port) => port === newPort).length > 6);
    assert.equal(countOld(), oldAfterRestart, '旧代次的探测循环不应继续使用旧管理端口');

    ready = true;
    await waitFor(() => describeInstanceLan(second.id).status === 'running');
    const running = describeInstanceLan(second.id);
    assert.equal(running.virtualIp, expectedIp);
    assert.equal(running.joinAddress, `${expectedIp}:25567`);
    assert.equal(running.detail, null);
    const settled = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(calls.length, settled, '拿到地址后探测循环应退出');
  });

  function describeReadyIp(): string {
    const row = getInstanceLanRow(first.id);
    return `10.126.${row?.octet}.1`;
  }
});

test('EasyTier 压缩包用面板自带的 ZIP 解析列出并读出条目，超限拒绝', async () => {
  const { listZipEntryNames, readZipEntryBuffer } = await import('./zip-service.js');
  const { PanelError } = await import('../utils/errors.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-lan-zip-'));
  try {
    const core = Buffer.alloc(4096, 0x41);
    const cli = Buffer.from('easytier-cli body');
    const zipPath = path.join(dir, 'easytier.zip');
    fs.writeFileSync(zipPath, createZip([
      { name: 'easytier-linux-x86_64/', contents: Buffer.alloc(0) },
      { name: 'easytier-linux-x86_64/easytier-core', contents: core, compression: 8 },
      { name: 'easytier-linux-x86_64/easytier-cli', contents: cli },
    ]));

    assert.deepEqual(listZipEntryNames(zipPath), [
      'easytier-linux-x86_64/easytier-core',
      'easytier-linux-x86_64/easytier-cli',
    ]);
    assert.deepEqual(await readZipEntryBuffer(zipPath, 'easytier-linux-x86_64/easytier-core', 8192), core);
    assert.deepEqual(await readZipEntryBuffer(zipPath, 'easytier-linux-x86_64/easytier-cli', 8192), cli);

    const isPanelError = (key: string) => (error: unknown) => error instanceof PanelError && error.messageKey === key;
    await assert.rejects(
      readZipEntryBuffer(zipPath, 'easytier-linux-x86_64/easytier-core', 100),
      isPanelError('server.files.zip.tooLarge'),
    );
    await assert.rejects(
      readZipEntryBuffer(zipPath, 'easytier-linux-x86_64/missing', 8192),
      isPanelError('server.files.zip.corrupted'),
    );
    // 压缩包本身超过调用方给的上限时直接拒绝。
    assert.throws(() => listZipEntryNames(zipPath, undefined, 16), isPanelError('server.files.zip.tooLarge'));

    // 中央目录谎报解压大小时，按实际解压字节数截断。
    const lyingPath = path.join(dir, 'lying.zip');
    fs.writeFileSync(lyingPath, createZip([
      { name: 'easytier-core', contents: core, compression: 8, declaredSize: 10 },
    ]));
    await assert.rejects(readZipEntryBuffer(lyingPath, 'easytier-core', 100), isPanelError('server.files.zip.tooLarge'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
