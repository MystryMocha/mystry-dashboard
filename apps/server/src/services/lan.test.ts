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
    LAN_SHARED_PEERS,
    renderFriendInstructions,
    renderLanToml,
    serverIpBlocksLan,
  } = await import('./lan-config.js');
  const { lanFirewallRuleArgs, openLanFirewall, setLanFirewallForTests } = await import('./lan-firewall.js');
  const { getInstanceLanRow, saveInstanceLan } = await import('./lan-service.js');
  const {
    describeInstanceLan,
    removeInstanceLan,
    renderLanFriendConfig,
    resetLanRuntimeForTests,
    setLanCliRunnerForTests,
    setLanGameStatusForTests,
    setLanProbeIntervalsForTests,
    setLanSpawnerForTests,
    shutdownLan,
    sweepLanFirewall,
    syncInstanceLan,
    syncInstanceLanQueued,
  } = await import('./lan-manager.js');
  const { lanCorePath, lanPlatformSupported, lanRuntimeDir, resolveLanAsset } = await import('./lan-runtime.js');
  const { createInstance } = await import('./instance-service.js');
  const { writeServerProperties } = await import('./config-service.js');

  initDb();
  // 不在测试机上真的改防火墙：按 Windows 行为记录 netsh 参数。
  const firewallCalls: string[][] = [];
  setLanFirewallForTests({
    platform: 'win32',
    runner: async (args) => {
      firewallCalls.push([...args]);
      return 0;
    },
  });
  t.after(async () => {
    await shutdownLan();
    resetLanRuntimeForTests();
    setLanFirewallForTests(null);
    closeDb();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  assert.equal(serverIpBlocksLan(''), false);
  assert.equal(serverIpBlocksLan('0.0.0.0'), false);
  assert.equal(serverIpBlocksLan('127.0.0.1'), true);
  assert.equal(serverIpBlocksLan('192.168.1.8'), true);

  const sample = {
    networkName: `mystry-${'ab'.repeat(16)}`,
    networkSecret: 'cd'.repeat(32),
    octet: 12,
    gamePort: 25565,
    peers: [...LAN_SHARED_PEERS],
    listenPort: 41234,
  };
  const rendered = renderLanToml(sample);
  assert.match(rendered, /ipv4 = "10\.126\.12\.1"/);
  assert.match(rendered, /tcp_whitelist = \["25565"\]/);
  assert.match(rendered, /udp_whitelist = \["1"\]/);
  // 监听同一端口的 TCP 与 UDP，EasyTier 会自动补上 [::]，朋友才能经 IPv6 直连。
  assert.match(rendered, /listeners = \["tcp:\/\/0\.0\.0\.0:41234", "udp:\/\/0\.0\.0\.0:41234"\]/);
  assert.match(rendered, /enable_ipv6 = true/);
  assert.match(rendered, /private_mode = true/);
  assert.match(rendered, /network_secret = "cdcd/);
  for (const peer of LAN_SHARED_PEERS) assert.ok(rendered.includes(`uri = "${peer}"`));
  assert.doesNotMatch(rendered, /socks5|port_forward|proxy_network|0\.0\.0\.0:11010|enable_exit_node = true/);
  assert.match(renderLanToml({ ...sample, listenPort: null }), /listeners = \[\]/);
  const friend = renderFriendInstructions(sample);
  assert.match(friend, /SHA-256: [0-9a-f]{64}/);
  assert.match(friend, /easytier-windows-x86_64-v2\.6\.4\.zip/);
  assert.doesNotMatch(friend, /41234/);
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
  firewallCalls.length = 0;
  const running = await syncInstanceLan(first.id);
  assert.equal(running.status, 'running');
  assert.equal(running.warning, null);
  assert.deepEqual(running.sharedPeers, [...LAN_SHARED_PEERS]);
  assert.equal(running.useSharedPeers, true);
  assert.ok(running.listenPort && running.listenPort !== 25565 && running.listenPort !== config.port);
  // 先按名字删旧规则，再加三条：游戏端口只限虚拟 IP；监听端口 TCP 与 UDP 只限实际启动的 easytier-core。
  const ruleName = `name=MystryDashboard-LAN-${first.id}`;
  assert.deepEqual(firewallCalls[0], ['advfirewall', 'firewall', 'delete', 'rule', ruleName]);
  const adds = firewallCalls.slice(1);
  assert.equal(adds.length, 3);
  for (const args of adds) {
    assert.deepEqual(args.slice(0, 9), ['advfirewall', 'firewall', 'add', 'rule', ruleName, 'dir=in', 'action=allow', 'profile=any', 'enable=yes']);
  }
  // 程序路径是面板自己的运行时路径（解析成真实路径），作为单独的数组参数传入，不拼命令行。
  const programArg = `program=${fs.realpathSync.native(lanCorePath())}`;
  assert.deepEqual(adds[0]?.slice(9), ['protocol=TCP', 'localport=25565', `localip=${running.virtualIp}`]);
  assert.deepEqual(adds[1]?.slice(9), ['protocol=TCP', `localport=${running.listenPort}`, programArg]);
  assert.deepEqual(adds[2]?.slice(9), ['protocol=UDP', `localport=${running.listenPort}`, programArg]);
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
  assert.ok(toml.includes(`"tcp://0.0.0.0:${running.listenPort}"`));
  // 同样的设置再同步一次不重启（监听端口不参与比较）。
  firewallCalls.length = 0;
  const resynced = await syncInstanceLan(first.id);
  assert.equal(resynced.listenPort, running.listenPort);
  assert.equal(firewallCalls.length, 0);
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

  await t.test('停止时删掉防火墙规则；规则加不上时给出提示但照常运行', async () => {
    setLanCliRunnerForTests(async () => JSON.stringify({ ipv4_addr: `${describeReadyIp()}/24` }));
    setLanSpawnerForTests(() => fakeChild() as unknown as ChildProcess);
    const ruleName = `name=MystryDashboard-LAN-${first.id}`;
    firewallCalls.length = 0;
    setLanGameStatusForTests(() => 'stopped');
    await syncInstanceLan(first.id);
    assert.deepEqual(firewallCalls, [['advfirewall', 'firewall', 'delete', 'rule', ruleName]]);

    setLanGameStatusForTests(() => 'running');
    setLanFirewallForTests({
      platform: 'win32',
      runner: async (args) => {
        firewallCalls.push([...args]);
        return args[2] === 'add' ? 1 : 0;
      },
    });
    const warned = await syncInstanceLan(first.id);
    assert.equal(warned.status, 'running');
    assert.equal(warned.warning?.key, 'server.lan.firewallFailed');
    setLanGameStatusForTests(() => 'stopped');
    firewallCalls.length = 0;
    await syncInstanceLan(first.id);
    // 失败时已回滚，停止不必再删。
    assert.equal(firewallCalls.length, 0);
    setLanGameStatusForTests(() => 'running');
    setLanFirewallForTests({
      platform: 'win32',
      runner: async (args) => {
        firewallCalls.push([...args]);
        return 0;
      },
    });
  });

  await t.test('自定义中继节点：规范化、去重，可关掉社区共享节点，且朋友命令用同一份', async () => {
    const custom = saveInstanceLan(first.id, {
      enabled: true,
      peers: ['  TCP://Relay.Example.com:11010 ', 'tcp://relay.example.com:11010', 'wss://[2001:DB8::1]:443/', ''],
      useSharedPeers: false,
    });
    assert.deepEqual(custom.peers, ['tcp://relay.example.com:11010', 'wss://[2001:db8::1]:443/']);
    assert.equal(custom.useSharedPeers, false);
    // 省略字段表示不改。
    const kept = saveInstanceLan(first.id, { enabled: true });
    assert.deepEqual(kept.peers, custom.peers);
    assert.equal(kept.useSharedPeers, false);
    const text = renderLanFriendConfig(first.id);
    assert.match(text, /--peers tcp:\/\/relay\.example\.com:11010 --peers wss:\/\/\[2001:db8::1\]:443\//);
    for (const peer of LAN_SHARED_PEERS) assert.equal(text.includes(peer), false);
    const described = describeInstanceLan(first.id);
    assert.deepEqual(described.peers, custom.peers);
    assert.equal(described.useSharedPeers, false);

    const isKey = (key: string) => (error: unknown) => error instanceof PanelError && error.messageKey === key;
    for (const bad of [
      'http://relay.example.com:80',
      'tcp://relay.example.com',
      'tcp://relay.example.com:0',
      'tcp://relay.example.com:11010/path',
      'tcp://relay.example.com:11010" --socks5 1080',
      'tcp://-bad-.example.com:11010',
      'udp://[not-ipv6]:11010',
      'wg://relay.example.com:11011',
    ]) {
      assert.throws(() => saveInstanceLan(first.id, { enabled: true, peers: [bad] }), isKey('server.lan.peerInvalid'), bad);
    }
    assert.throws(
      () => saveInstanceLan(first.id, { enabled: true, peers: [], useSharedPeers: false }),
      isKey('server.lan.peersRequired'),
    );
    // 失败的保存不改动已有设置。
    assert.deepEqual(getInstanceLanRow(first.id)?.peers, custom.peers);

    const restored = saveInstanceLan(first.id, { enabled: true, peers: [], useSharedPeers: true });
    assert.deepEqual(restored.peers, []);
    assert.ok(renderLanFriendConfig(first.id).includes(LAN_SHARED_PEERS[0]));
  });

  const deleteArgs = (id: string) => ['advfirewall', 'firewall', 'delete', 'rule', `name=MystryDashboard-LAN-${id}`];
  /** 记录 netsh 参数的假执行器；code 决定每条命令的退出码（-1 表示没能运行或超时）。 */
  const recordingRunner = (code: (args: readonly string[]) => number = () => 0) => ({
    platform: 'win32' as NodeJS.Platform,
    runner: async (args: readonly string[]) => {
      firewallCalls.push([...args]);
      return code(args);
    },
  });
  /** 模拟面板崩溃后重启：内存里的运行状态全部丢失，系统里的防火墙规则还在。 */
  const simulateRestart = () => {
    resetLanRuntimeForTests();
    setLanSpawnerForTests(() => fakeChild() as unknown as ChildProcess);
    setLanCliRunnerForTests(async () => JSON.stringify({ ipv4_addr: `${describeReadyIp()}/24` }));
    setLanGameStatusForTests(() => 'running');
  };

  await t.test('面板重启后没有运行状态，停服或关闭虚拟局域网仍按名字删规则', async () => {
    simulateRestart();
    setLanFirewallForTests(recordingRunner());
    // 先在「上一次面板进程」里把规则加上，再模拟面板被结束。
    assert.equal((await syncInstanceLan(first.id)).status, 'running');
    simulateRestart();

    // 实例停服：没有运行状态，但有虚拟局域网记录，仍要删。
    firewallCalls.length = 0;
    setLanGameStatusForTests(() => 'stopped');
    await syncInstanceLan(first.id);
    assert.deepEqual(firewallCalls, [deleteArgs(first.id)]);
    // 本进程确认删过后，再停服不重复调用 netsh。
    await syncInstanceLan(first.id);
    assert.equal(firewallCalls.length, 1);

    // netsh 没能运行（超时等）时结果未知，之后关闭虚拟局域网时再删。
    simulateRestart();
    setLanGameStatusForTests(() => 'stopped');
    setLanFirewallForTests(recordingRunner(() => -1));
    firewallCalls.length = 0;
    await syncInstanceLan(first.id);
    assert.deepEqual(firewallCalls, [deleteArgs(first.id)]);
    setLanFirewallForTests(recordingRunner());
    saveInstanceLan(first.id, { enabled: false });
    await syncInstanceLan(first.id);
    assert.deepEqual(firewallCalls, [deleteArgs(first.id), deleteArgs(first.id)]);
    saveInstanceLan(first.id, { enabled: true });

    // 从没开过虚拟局域网的实例没有记录，停服不调用 netsh。
    const plain = createInstance({ name: 'Plain', acceptEula: true });
    firewallCalls.length = 0;
    await syncInstanceLan(plain.id);
    assert.equal(firewallCalls.length, 0);

    // 其他系统上什么都不做。
    simulateRestart();
    setLanGameStatusForTests(() => 'stopped');
    setLanFirewallForTests({ ...recordingRunner(), platform: 'linux' });
    await syncInstanceLan(first.id);
    assert.equal(firewallCalls.length, 0);
    setLanFirewallForTests(recordingRunner());
  });

  await t.test('启动清扫只删归本面板的实例（有记录或工作目录），跳过已重新启动的，不按前缀删', async () => {
    simulateRestart();
    setLanFirewallForTests(recordingRunner());
    // second 已关闭虚拟局域网但记录还在：旧版本留下的规则也要清。
    saveInstanceLan(second.id, { enabled: false });
    const noLan = createInstance({ name: 'NoLan', acceptEula: true });
    assert.equal(getInstanceLanRow(noLan.id), null);
    firewallCalls.length = 0;
    // 与 attachLanLifecycle 一样不等清扫，紧接着排一个启动：清扫先进队列，不会删掉启动刚加的规则。
    const sweeping = sweepLanFirewall();
    const started = syncInstanceLanQueued(first.id);
    await sweeping;
    assert.equal((await started).status, 'running');
    const named = (id: string) => (args: string[]) => args[4] === `name=MystryDashboard-LAN-${id}`;
    const forFirst = firewallCalls.filter(named(first.id));
    assert.deepEqual(forFirst.map((args) => args[2]), ['delete', 'delete', 'add', 'add', 'add']);
    assert.deepEqual(firewallCalls.filter(named(second.id)), [deleteArgs(second.id)]);
    // 只按已知 ID 精确删除：没有记录的实例、别的面板的规则（如按前缀匹配）都不碰。
    assert.equal(firewallCalls.length, forFirst.length + 1);
    assert.equal(firewallCalls.some(named(noLan.id)), false);

    // 已有运行状态的跳过；本进程已确认删过的不重复。
    firewallCalls.length = 0;
    await sweepLanFirewall();
    assert.equal(firewallCalls.length, 0);

    // 其他系统上清扫不调用 netsh。
    simulateRestart();
    setLanFirewallForTests({ ...recordingRunner(), platform: 'linux' });
    await sweepLanFirewall();
    assert.equal(firewallCalls.length, 0);
    setLanFirewallForTests(recordingRunner());
    saveInstanceLan(second.id, { enabled: true });
  });

  await t.test('删除实例时即使没有运行状态、记录已随实例级联删除也删规则；任意 ID 不触发 netsh', async () => {
    const { deleteInstance } = await import('./instance-service.js');
    simulateRestart();
    setLanFirewallForTests(recordingRunner());
    const lanDir = (id: string) => path.join(dataRoot, 'lan', id);
    /** 建实例、开虚拟局域网并真的启动一次（写好工作目录、加上规则），再模拟面板被结束。 */
    const startedThenKilled = async (name: string, port: string) => {
      const info = createInstance({ name, acceptEula: true });
      saveInstanceLan(info.id, { enabled: true });
      writeServerProperties(info.id, { 'server-ip': '', 'server-port': port });
      await syncInstanceLan(info.id);
      assert.ok(fs.existsSync(lanDir(info.id)));
      simulateRestart();
      return info;
    };
    const doomed = await startedThenKilled('Doomed', '25569');
    // 与 DELETE /api/instances/:id 相同的顺序：先删实例（虚拟局域网记录级联删除），再收尾虚拟局域网。
    await deleteInstance(doomed.id);
    assert.equal(getInstanceLanRow(doomed.id), null);
    firewallCalls.length = 0;
    await removeInstanceLan(doomed.id);
    assert.deepEqual(firewallCalls, [deleteArgs(doomed.id)]);
    assert.equal(fs.existsSync(lanDir(doomed.id)), false);

    // 不归本面板的 ID（没有记录也没有工作目录）：即使格式合法也不调用 netsh，免得删到别的面板的同名规则。
    firewallCalls.length = 0;
    await removeInstanceLan('neverCreated01');
    assert.equal(firewallCalls.length, 0);

    // 删除时 netsh 没跑成：保留工作目录，下次启动清扫按它补删，确认后再清掉目录。
    const stubborn = await startedThenKilled('Stubborn', '25570');
    await deleteInstance(stubborn.id);
    setLanFirewallForTests(recordingRunner(() => -1));
    firewallCalls.length = 0;
    await removeInstanceLan(stubborn.id);
    assert.deepEqual(firewallCalls, [deleteArgs(stubborn.id)]);
    assert.ok(fs.existsSync(lanDir(stubborn.id)));
    simulateRestart();
    setLanFirewallForTests(recordingRunner());
    firewallCalls.length = 0;
    await sweepLanFirewall();
    assert.deepEqual(firewallCalls.filter((args) => args[4] === `name=MystryDashboard-LAN-${stubborn.id}`), [deleteArgs(stubborn.id)]);
    assert.equal(fs.existsSync(lanDir(stubborn.id)), false);

    // 加规则失败（已回滚）后删除：停止时不删，删除时仍补删一次。
    const flaky = createInstance({ name: 'Flaky', acceptEula: true });
    saveInstanceLan(flaky.id, { enabled: true });
    writeServerProperties(flaky.id, { 'server-ip': '', 'server-port': '25568' });
    setLanFirewallForTests(recordingRunner((args) => (args[2] === 'add' ? 1 : 0)));
    assert.equal((await syncInstanceLan(flaky.id)).warning?.key, 'server.lan.firewallFailed');
    await deleteInstance(flaky.id);
    firewallCalls.length = 0;
    await removeInstanceLan(flaky.id);
    assert.deepEqual(firewallCalls, [deleteArgs(flaky.id)]);
    assert.equal(fs.existsSync(path.join(dataRoot, 'lan', flaky.id)), false);

    // 其他系统上删除实例不调用 netsh。
    const other = createInstance({ name: 'Other', acceptEula: true });
    saveInstanceLan(other.id, { enabled: true });
    setLanFirewallForTests({ ...recordingRunner(), platform: 'linux' });
    await deleteInstance(other.id);
    firewallCalls.length = 0;
    await removeInstanceLan(other.id);
    assert.equal(firewallCalls.length, 0);
    setLanFirewallForTests(recordingRunner());
  });

  await t.test('监听规则只限 easytier-core；带程序的规则加不上就退回不限程序，路径不合适不收窄', async () => {
    // 宿主机上的绝对路径，带空格：Linux CI 上同样适用。
    const corePath = path.join(dataRoot, 'First Last', 'easytier-core.exe');
    const input = { instanceId: 'probe-1', virtualIp: '10.126.12.1', gamePort: 25565, listenPort: 41234, corePath };
    const rules = lanFirewallRuleArgs(input);
    assert.deepEqual(rules.map((rule) => rule.args.slice(9)), [
      ['protocol=TCP', 'localport=25565', 'localip=10.126.12.1'],
      ['protocol=TCP', 'localport=41234', `program=${corePath}`],
      ['protocol=UDP', 'localport=41234', `program=${corePath}`],
    ]);
    // 游戏端口规则不限程序，也没有退回参数；监听规则退回时只去掉 program=。
    assert.equal(rules[0]?.fallback, null);
    assert.deepEqual(rules[1]?.fallback, rules[1]?.args.slice(0, -1));
    assert.deepEqual(rules[2]?.fallback, rules[2]?.args.slice(0, -1));

    // netsh 不接受 program= 时退回不限程序的规则，结果仍是已加上（不比收窄前差）。
    setLanFirewallForTests(recordingRunner((args) => (args.some((arg) => arg.startsWith('program=')) ? 1 : 0)));
    firewallCalls.length = 0;
    assert.equal(await openLanFirewall(input), 'applied');
    assert.deepEqual(firewallCalls, [
      deleteArgs('probe-1'),
      rules[0]?.args,
      rules[1]?.args,
      rules[1]?.fallback,
      rules[2]?.args,
      rules[2]?.fallback,
    ]);

    // 退回的规则也加不上时整体回滚。
    setLanFirewallForTests(recordingRunner((args) => (args[2] === 'add' && args.includes('protocol=UDP') ? 1 : 0)));
    firewallCalls.length = 0;
    assert.equal(await openLanFirewall(input), 'failed');
    assert.deepEqual(firewallCalls.at(-1), deleteArgs('probe-1'));

    // 路径为空、不是绝对路径、带引号、% 或控制字符时不收窄。
    for (const bad of [
      null,
      'easytier-core.exe',
      path.join(dataRoot, 'a"b', 'easytier-core.exe'),
      path.join(dataRoot, '%TEMP%', 'easytier-core.exe'),
      `${corePath}\n`,
    ]) {
      const plain = lanFirewallRuleArgs({ ...input, corePath: bad });
      assert.ok(
        plain.every((rule) => rule.fallback === null && !rule.args.some((arg) => arg.startsWith('program='))),
        String(bad),
      );
    }

    // 参数不合法时只报加不上，不抛错，也不调用 netsh。
    setLanFirewallForTests(recordingRunner());
    firewallCalls.length = 0;
    assert.equal(await openLanFirewall({ ...input, virtualIp: '192.168.1.1' }), 'failed');
    assert.equal(firewallCalls.length, 0);
  });

  await t.test('手动上传的压缩包只认钉死的摘要，不对就不装', async () => {
    const { installLanFromArchive, lanArchiveInfo, lanInstalled } = await import('./lan-runtime.js');
    const info = lanArchiveInfo();
    assert.ok(info);
    assert.equal(info.name, asset.archive);
    assert.equal(info.sha256, asset.sha256);
    assert.equal(info.url, `https://github.com/EasyTier/EasyTier/releases/download/v2.6.4/${asset.archive}`);
    await shutdownLan();
    // 去掉前面伪造的安装标记，模拟尚未安装。
    fs.rmSync(path.join(lanRuntimeDir(), 'archive.sha256'), { force: true });
    const fake = path.join(dataRoot, 'not-easytier.zip');
    fs.writeFileSync(fake, 'definitely not the official archive');
    await assert.rejects(
      installLanFromArchive(fake),
      (error: unknown) => error instanceof PanelError && error.messageKey === 'server.lan.uploadMismatch',
    );
    assert.equal(lanInstalled(), false);
    assert.equal(fs.existsSync(path.join(lanRuntimeDir(), 'archive.sha256')), false);
    assert.equal(fs.existsSync(fake), true, '源文件由调用方删除');
  });

  function describeReadyIp(): string {
    const row = getInstanceLanRow(first.id);
    return `10.126.${row?.octet}.1`;
  }
});

test('frpc 的 Windows 压缩包不依赖系统 tar，缺少条目时报解压失败', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-frp-zip-'));
  // 单独运行这条测试时配置还没加载，这里补齐；整组运行时模块已缓存，不受影响。
  process.env.MYSTRY_DATA_DIR ??= dir;
  process.env.JWT_SECRET ??= 'a'.repeat(64);
  process.env.SETUP_TOKEN ??= 'b'.repeat(64);
  process.env.LAUNCHER_TOKEN ??= 'c'.repeat(64);
  const { extractMember } = await import('./frp-runtime.js');
  const savedPath = process.env.PATH;
  // PATH 清空后系统 tar 一定找不到，还能走通就说明没有用它。
  process.env.PATH = '';
  t.after(() => {
    process.env.PATH = savedPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const frpc = Buffer.alloc(4096, 0x42);
  // 文件名与真实下载时一致：带 .partial 后缀，同目录还有 frps.exe。
  const zipPath = path.join(dir, 'frp_windows_amd64.zip.partial');
  fs.writeFileSync(zipPath, createZip([
    { name: 'frp_windows_amd64/frps.exe', contents: Buffer.from('frps'), compression: 8 },
    { name: 'frp_windows_amd64/frpc.exe', contents: frpc, compression: 8 },
  ]));
  assert.deepEqual(await extractMember(zipPath, 'frp_windows_amd64/frpc.exe'), frpc);
  await assert.rejects(
    extractMember(zipPath, 'frp_windows_amd64/missing.exe'),
    (error: { messageKey?: string }) => error.messageKey === 'server.frp.extractFailed',
  );
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
