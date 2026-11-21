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
  /** Uncompressed size written into the central directory, matching the actual size by default; used to simulate an archive that lies about its size */
  declaredSize?: number;
};

/** A hand-written minimal ZIP (local file header + central directory + EOCD), without relying on external tools. */
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

test('the virtual LAN opens only the game port, and the secret does not go on the command line or into the child process environment', async (t) => {
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
  // Do not actually change the firewall on the test machine: record the netsh arguments as Windows would behave.
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
  // Listening on TCP and UDP of the same port makes EasyTier add [::] automatically, which is what lets friends connect directly over IPv6.
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

  writeServerProperties(first.id, { 'server-ip': '', 'server-port': 'abc' });
  assert.equal((await syncInstanceLan(first.id)).detail?.key, 'server.lan.localPortInvalid');

  // With the port left empty the game uses 25565, which does not count as an invalid port.
  writeServerProperties(first.id, { 'server-ip': '', 'server-port': '' });
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
  // Delete the old rules by name first, then add three: the game port restricted to the virtual IP; listen port TCP and UDP restricted to the easytier-core actually started.
  const ruleName = `name=MystryDashboard-LAN-${first.id}`;
  assert.deepEqual(firewallCalls[0], ['advfirewall', 'firewall', 'delete', 'rule', ruleName]);
  const adds = firewallCalls.slice(1);
  assert.equal(adds.length, 3);
  for (const args of adds) {
    assert.deepEqual(args.slice(0, 9), ['advfirewall', 'firewall', 'add', 'rule', ruleName, 'dir=in', 'action=allow', 'profile=any', 'enable=yes']);
  }
  // The program path is the panel's own runtime path (resolved to the real path), passed as a separate array argument and not concatenated into a command line.
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
  // Syncing the same settings again does not restart (the listen port is not part of the comparison).
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

  await t.test('probing continues while no address arrives and it becomes running once one does; a replaced old probe loop exits', async () => {
    // The slow interval is clearly longer than a restart takes, so the new generation is in place when the old loop wakes up, which is what exposes a broken generation guard.
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
    // After the fast probes are used up only a waiting notice is shown; the status is still starting and the loop continues.
    await waitFor(() => describeInstanceLan(second.id).detail?.key === 'server.lan.waitingForAddress');
    const countOld = () => calls.filter((port) => port === oldPort).length;
    const before = countOld();
    await waitFor(() => countOld() > before + 2);
    assert.equal(describeInstanceLan(second.id).status, 'starting');

    // Changing the port changes the config, which triggers stopping the old client and starting a new generation.
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

  await t.test('firewall rules are deleted on stop; when rules cannot be added a notice is shown but it runs as usual', async () => {
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
    // Already rolled back on failure, so stop does not need to delete again.
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

  await t.test('custom relay peers: normalized, deduplicated, community shared peers can be turned off, and the friend command uses the same list', async () => {
    const custom = saveInstanceLan(first.id, {
      enabled: true,
      peers: ['  TCP://Relay.Example.com:11010 ', 'tcp://relay.example.com:11010', 'wss://[2001:DB8::1]:443/', ''],
      useSharedPeers: false,
    });
    assert.deepEqual(custom.peers, ['tcp://relay.example.com:11010', 'wss://[2001:db8::1]:443/']);
    assert.equal(custom.useSharedPeers, false);
    // Omitted fields mean no change.
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
    // A failed save does not modify the existing settings.
    assert.deepEqual(getInstanceLanRow(first.id)?.peers, custom.peers);

    const restored = saveInstanceLan(first.id, { enabled: true, peers: [], useSharedPeers: true });
    assert.deepEqual(restored.peers, []);
    assert.ok(renderLanFriendConfig(first.id).includes(LAN_SHARED_PEERS[0]));
  });

  const deleteArgs = (id: string) => ['advfirewall', 'firewall', 'delete', 'rule', `name=MystryDashboard-LAN-${id}`];
  /** A fake runner that records netsh arguments; code decides each command's exit code (-1 means it could not run or timed out). */
  const recordingRunner = (code: (args: readonly string[]) => number = () => 0) => ({
    platform: 'win32' as NodeJS.Platform,
    runner: async (args: readonly string[]) => {
      firewallCalls.push([...args]);
      return code(args);
    },
  });
  /** Simulates a restart after a panel crash: all in-memory runtime state is lost, while the firewall rules in the system remain. */
  const simulateRestart = () => {
    resetLanRuntimeForTests();
    setLanSpawnerForTests(() => fakeChild() as unknown as ChildProcess);
    setLanCliRunnerForTests(async () => JSON.stringify({ ipv4_addr: `${describeReadyIp()}/24` }));
    setLanGameStatusForTests(() => 'running');
  };

  await t.test('with no runtime state after a panel restart, stopping the server or disabling the virtual LAN still deletes rules by name', async () => {
    simulateRestart();
    setLanFirewallForTests(recordingRunner());
    // Add the rules in the "previous panel process" first, then simulate the panel being killed.
    assert.equal((await syncInstanceLan(first.id)).status, 'running');
    simulateRestart();

    // Instance stop: no runtime state, but there is a virtual LAN record, so deletion still happens.
    firewallCalls.length = 0;
    setLanGameStatusForTests(() => 'stopped');
    await syncInstanceLan(first.id);
    assert.deepEqual(firewallCalls, [deleteArgs(first.id)]);
    // After this process has confirmed deletion, stopping again does not call netsh repeatedly.
    await syncInstanceLan(first.id);
    assert.equal(firewallCalls.length, 1);

    // When netsh could not run (timeout, etc.) the result is unknown, and deletion happens later when the virtual LAN is disabled.
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

    // An instance that never enabled the virtual LAN has no record, so stopping it does not call netsh.
    const plain = createInstance({ name: 'Plain', acceptEula: true });
    firewallCalls.length = 0;
    await syncInstanceLan(plain.id);
    assert.equal(firewallCalls.length, 0);

    // Nothing is done on other systems.
    simulateRestart();
    setLanGameStatusForTests(() => 'stopped');
    setLanFirewallForTests({ ...recordingRunner(), platform: 'linux' });
    await syncInstanceLan(first.id);
    assert.equal(firewallCalls.length, 0);
    setLanFirewallForTests(recordingRunner());
  });

  await t.test('the startup sweep deletes only for instances owned by this panel (with a record or work directory), skips ones already restarted, and does not delete by prefix', async () => {
    simulateRestart();
    setLanFirewallForTests(recordingRunner());
    // second has the virtual LAN disabled but the record is still there: rules left by older versions must be cleaned too.
    saveInstanceLan(second.id, { enabled: false });
    const noLan = createInstance({ name: 'NoLan', acceptEula: true });
    assert.equal(getInstanceLanRow(noLan.id), null);
    firewallCalls.length = 0;
    // Like attachLanLifecycle, do not wait for the sweep and queue a start right after: the sweep enters the queue first, so it does not delete the rules the start just added.
    const sweeping = sweepLanFirewall();
    const started = syncInstanceLanQueued(first.id);
    await sweeping;
    assert.equal((await started).status, 'running');
    const named = (id: string) => (args: string[]) => args[4] === `name=MystryDashboard-LAN-${id}`;
    const forFirst = firewallCalls.filter(named(first.id));
    assert.deepEqual(forFirst.map((args) => args[2]), ['delete', 'delete', 'add', 'add', 'add']);
    assert.deepEqual(firewallCalls.filter(named(second.id)), [deleteArgs(second.id)]);
    // Deletes precisely by known IDs only: instances without a record and other panels' rules (as prefix matching would hit) are left alone.
    assert.equal(firewallCalls.length, forFirst.length + 1);
    assert.equal(firewallCalls.some(named(noLan.id)), false);

    // Those with runtime state are skipped; those this process has confirmed deleted are not repeated.
    firewallCalls.length = 0;
    await sweepLanFirewall();
    assert.equal(firewallCalls.length, 0);

    // On other systems the sweep does not call netsh.
    simulateRestart();
    setLanFirewallForTests({ ...recordingRunner(), platform: 'linux' });
    await sweepLanFirewall();
    assert.equal(firewallCalls.length, 0);
    setLanFirewallForTests(recordingRunner());
    saveInstanceLan(second.id, { enabled: true });
  });

  await t.test('deleting an instance deletes rules even with no runtime state and the record already cascade-deleted; arbitrary IDs do not trigger netsh', async () => {
    const { deleteInstance } = await import('./instance-service.js');
    simulateRestart();
    setLanFirewallForTests(recordingRunner());
    const lanDir = (id: string) => path.join(dataRoot, 'lan', id);
    /** Creates an instance, enables the virtual LAN and really starts it once (writing the work directory and adding rules), then simulates the panel being killed. */
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
    // Same order as DELETE /api/instances/:id: delete the instance first (the virtual LAN record is cascade-deleted), then finish off the virtual LAN.
    await deleteInstance(doomed.id);
    assert.equal(getInstanceLanRow(doomed.id), null);
    firewallCalls.length = 0;
    await removeInstanceLan(doomed.id);
    assert.deepEqual(firewallCalls, [deleteArgs(doomed.id)]);
    assert.equal(fs.existsSync(lanDir(doomed.id)), false);

    // An ID not owned by this panel (no record and no work directory): netsh is not called even when the format is valid, so another panel's rules of the same name are not deleted.
    firewallCalls.length = 0;
    await removeInstanceLan('neverCreated01');
    assert.equal(firewallCalls.length, 0);

    // netsh could not run on delete: the work directory is kept, the next startup sweep deletes by it, and the directory is removed once confirmed.
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

    // Delete after adding rules failed (already rolled back): stop does not delete, but delete still deletes once more.
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

    // On other systems deleting an instance does not call netsh.
    const other = createInstance({ name: 'Other', acceptEula: true });
    saveInstanceLan(other.id, { enabled: true });
    setLanFirewallForTests({ ...recordingRunner(), platform: 'linux' });
    await deleteInstance(other.id);
    firewallCalls.length = 0;
    await removeInstanceLan(other.id);
    assert.equal(firewallCalls.length, 0);
    setLanFirewallForTests(recordingRunner());
  });

  await t.test('listen rules are restricted to easytier-core; when a rule with a program cannot be added it falls back to no program restriction, and an unsuitable path is not narrowed', async () => {
    // An absolute path on the host, with spaces: equally valid on Linux CI.
    const corePath = path.join(dataRoot, 'First Last', 'easytier-core.exe');
    const input = { instanceId: 'probe-1', virtualIp: '10.126.12.1', gamePort: 25565, listenPort: 41234, corePath };
    const rules = lanFirewallRuleArgs(input);
    assert.deepEqual(rules.map((rule) => rule.args.slice(9)), [
      ['protocol=TCP', 'localport=25565', 'localip=10.126.12.1'],
      ['protocol=TCP', 'localport=41234', `program=${corePath}`],
      ['protocol=UDP', 'localport=41234', `program=${corePath}`],
    ]);
    // The game port rule has no program restriction and no fallback arguments; the listen rules drop only program= when falling back.
    assert.equal(rules[0]?.fallback, null);
    assert.deepEqual(rules[1]?.fallback, rules[1]?.args.slice(0, -1));
    assert.deepEqual(rules[2]?.fallback, rules[2]?.args.slice(0, -1));

    // When netsh does not accept program=, fall back to rules without a program restriction; the result is still added (no worse than before narrowing).
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

    // When the fallback rules cannot be added either, everything is rolled back.
    setLanFirewallForTests(recordingRunner((args) => (args[2] === 'add' && args.includes('protocol=UDP') ? 1 : 0)));
    firewallCalls.length = 0;
    assert.equal(await openLanFirewall(input), 'failed');
    assert.deepEqual(firewallCalls.at(-1), deleteArgs('probe-1'));

    // No narrowing when the path is empty, not absolute, or contains quotes, % or control characters.
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

    // With invalid arguments it only reports that rules could not be added, without throwing or calling netsh.
    setLanFirewallForTests(recordingRunner());
    firewallCalls.length = 0;
    assert.equal(await openLanFirewall({ ...input, virtualIp: '192.168.1.1' }), 'failed');
    assert.equal(firewallCalls.length, 0);
  });

  await t.test('a manually uploaded archive is accepted only by the pinned digest, and is not installed otherwise', async () => {
    const { installLanFromArchive, lanArchiveInfo, lanInstalled } = await import('./lan-runtime.js');
    const info = lanArchiveInfo();
    assert.ok(info);
    assert.equal(info.name, asset.archive);
    assert.equal(info.sha256, asset.sha256);
    assert.equal(info.url, `https://github.com/EasyTier/EasyTier/releases/download/v2.6.4/${asset.archive}`);
    await shutdownLan();
    // Remove the fake install marker created earlier, to simulate not being installed yet.
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

test('the Windows frpc archive does not depend on the system tar, and a missing entry reports an extraction failure', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-frp-zip-'));
  // When this test runs alone the config is not loaded yet, so it is filled in here; when the whole group runs, the module is already cached and unaffected.
  process.env.MYSTRY_DATA_DIR ??= dir;
  process.env.JWT_SECRET ??= 'a'.repeat(64);
  process.env.SETUP_TOKEN ??= 'b'.repeat(64);
  process.env.LAUNCHER_TOKEN ??= 'c'.repeat(64);
  const { extractMember } = await import('./frp-runtime.js');
  const savedPath = process.env.PATH;
  // With PATH cleared the system tar cannot be found, so still succeeding shows it was not used.
  process.env.PATH = '';
  t.after(() => {
    process.env.PATH = savedPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const frpc = Buffer.alloc(4096, 0x42);
  // The file name matches a real download: it has a .partial suffix, and frps.exe is in the same directory.
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

test('the EasyTier archive is listed and read with the panel ZIP parser, and exceeding the limit is rejected', async () => {
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
    // An archive that itself exceeds the limit given by the caller is rejected outright.
    assert.throws(() => listZipEntryNames(zipPath, undefined, 16), isPanelError('server.files.zip.tooLarge'));

    // When the central directory lies about the uncompressed size, extraction is cut off by the actual number of bytes extracted.
    const lyingPath = path.join(dir, 'lying.zip');
    fs.writeFileSync(lyingPath, createZip([
      { name: 'easytier-core', contents: core, compression: 8, declaredSize: 10 },
    ]));
    await assert.rejects(readZipEntryBuffer(lyingPath, 'easytier-core', 100), isPanelError('server.files.zip.tooLarge'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the Windows build of EasyTier also installs Packet.dll, which is required to start', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-lan-asset-'));
  // When this test runs alone the config is not loaded yet, so it is filled in here; when the whole group runs, the module is already cached and unaffected.
  process.env.MYSTRY_DATA_DIR ??= dir;
  process.env.JWT_SECRET ??= 'a'.repeat(64);
  process.env.SETUP_TOKEN ??= 'b'.repeat(64);
  process.env.LAUNCHER_TOKEN ??= 'c'.repeat(64);
  try {
    const { resolveLanAsset } = await import('./lan-runtime.js');
    const windows = resolveLanAsset('win32', 'x64');
    // easytier-core.exe 2.6.4 statically imports Packet.dll; without it even --version exits with 0xC0000135 (verified on Windows 11 on 2026-11-17).
    // Both installation and lanInstalled() go by extraNames; without it an old install would not count as complete either.
    assert.ok(windows.extraNames.includes('Packet.dll'));
    assert.ok(windows.extraNames.includes('wintun.dll'));
    assert.deepEqual(resolveLanAsset('linux', 'x64').extraNames, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed virtual adapter is reported as needing an administrator on a non-English Windows too', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-lan-detail-'));
  process.env.MYSTRY_DATA_DIR ??= dir;
  process.env.JWT_SECRET ??= 'a'.repeat(64);
  process.env.SETUP_TOKEN ??= 'b'.repeat(64);
  process.env.LAUNCHER_TOKEN ??= 'c'.repeat(64);
  try {
    const { lanFailureDetail } = await import('./lan-config.js');
    // Output of easytier-core 2.6.4 without elevation on a Chinese Windows 11 (captured 2026-11-21).
    const fatal = 'ERROR CORE::INSTANCE: [6f8473b1] tun device error err=rust tun error Failed to create adapter';
    const firewallWarning = 'WARN CORE: Failed to add Easytier to firewall allowlist, Subnet proxy and KCP proxy may not work properly. error=拒绝访问。 (0x80070005)';
    assert.deepEqual(lanFailureDetail(fatal, 'secret'), { key: 'server.lan.needsAdmin' });
    // The panel's own network runs without a virtual adapter and still prints this warning while working.
    assert.equal(lanFailureDetail(firewallWarning, 'secret'), null);
    assert.equal(lanFailureDetail(`${fatal} secret`, 'secret'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
