/**
 * 从其他设备访问面板回归：网卡分类、公网地址校验、防火墙参数、额外监听器
 * （HTTP 转交、HTTPS 分流与跳转、来源限制、启动器接口隔离）和面板自带 EasyTier 网络。
 * 监听器测试只用回环网段（127.0.0.x）和随机端口，不碰真实网卡；netsh 和 EasyTier 都用替身。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import WebSocket from 'ws';
import type { ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { PanelNetworkInterface, PanelNetworkStatus, RemoteAccessStatus } from '@mystry/shared';

process.env.JWT_SECRET = 'a'.repeat(64);
process.env.SETUP_TOKEN = 'b'.repeat(64);
process.env.LAUNCHER_TOKEN = 'c'.repeat(64);
process.env.MYSTRY_PROCESS_FINGERPRINT = 'fingerprint-for-test';
// 只放宽全局限额（本文件请求很多）；认证和启动器的严格限额保持默认，下面有测试依赖它。
process.env.RATE_LIMIT_MAX = '100000';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-remote-access-test-'));
process.env.MYSTRY_HOME = dataRoot;
process.env.MYSTRY_DATA_DIR = dataRoot;
test.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));

const LAUNCHER_TOKEN = 'c'.repeat(64);

function ipv4(address: string, prefix = 24): os.NetworkInterfaceInfo {
  return { address, netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: `${address}/${prefix}` };
}

interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** 发一个请求；localAddress 用来指定来源地址，ca 为 false 时不校验证书。 */
function request(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown; localAddress?: string; rawHost?: string } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const secure = target.protocol === 'https:';
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = (secure ? https : http).request({
      host: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: options.method ?? 'GET',
      localAddress: options.localAddress,
      agent: false,
      rejectUnauthorized: false,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}),
        ...(options.rawHost ? { host: options.rawHost } : {}),
        connection: 'close',
        ...options.headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.once('error', reject);
    req.end(payload);
  });
}

/** 打开控制台 WebSocket（不带 ticket），返回服务端发来的第一帧的消息键；连不上时返回错误文本。 */
function consoleSocketFirstFrame(url: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { rejectUnauthorized: false });
    const timer = setTimeout(() => { socket.terminate(); resolve('timeout'); }, 3000);
    const finish = (value: string): void => { clearTimeout(timer); socket.terminate(); resolve(value); };
    socket.once('message', (data) => finish((JSON.parse(String(data)) as { code?: string }).code ?? 'no-code'));
    socket.once('error', (error) => finish(`error: ${error.message}`));
    socket.once('unexpected-response', (_req, res) => finish(`http ${res.statusCode}`));
  });
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('网卡分类先看网卡名再看地址，网址按局域网、公网、组网排序', async () => {
  const { classifyNetworkInterface, listNetworkInterfaces, networkKindRank } = await import('./local-network-service.js');
  assert.equal(classifyNetworkInterface('FlClash', '198.18.0.1'), 'proxy');
  assert.equal(classifyNetworkInterface('Meta', '198.18.0.1'), 'proxy');
  assert.equal(classifyNetworkInterface('Tailscale', '100.107.3.4'), 'overlay');
  assert.equal(classifyNetworkInterface('tailscale0', '100.107.3.4'), 'overlay');
  assert.equal(classifyNetworkInterface('eth9', '100.64.0.9'), 'overlay');
  assert.equal(classifyNetworkInterface('mystry12', '10.126.12.1'), 'instanceNetwork');
  assert.equal(classifyNetworkInterface('WLAN', '192.168.2.163'), 'lan');
  assert.equal(classifyNetworkInterface('以太网', '10.0.0.5'), 'lan');
  assert.equal(classifyNetworkInterface('eth0', '172.20.1.5'), 'lan');
  assert.equal(classifyNetworkInterface('eth0', '203.0.113.10'), 'public');
  assert.equal(classifyNetworkInterface('vEthernet (WSL)', '172.30.208.1'), 'virtual');
  assert.equal(classifyNetworkInterface('docker0', '172.17.0.1'), 'virtual');
  // 名字像组网但地址是公网段：靠名字认出来，不被判成公网。
  assert.equal(classifyNetworkInterface('ZeroTier One [abc]', '203.0.113.77'), 'overlay');
  assert.equal(classifyNetworkInterface('ztabcdef', '25.1.2.3'), 'overlay');

  const listed = listNetworkInterfaces({
    lo: [{ ...ipv4('127.0.0.1', 8), internal: true }],
    WLAN: [ipv4('192.168.2.163'), { address: 'fe80::1', netmask: 'ffff::', family: 'IPv6', mac: '', internal: false, cidr: 'fe80::1/64', scopeid: 1 }],
    unplugged: [ipv4('169.254.10.20', 16)],
    Tailscale: [ipv4('100.107.3.4', 32)],
    empty: undefined,
  });
  assert.deepEqual(listed, [
    { name: 'WLAN', address: '192.168.2.163', cidr: '192.168.2.163/24', kind: 'lan' },
    { name: 'Tailscale', address: '100.107.3.4', cidr: '100.107.3.4/32', kind: 'overlay' },
  ]);

  const order = [
    networkKindRank('lan', '192.168.1.2'),
    networkKindRank('lan', '10.0.0.2'),
    networkKindRank('lan', '172.16.0.2'),
    networkKindRank('publicHost'),
    networkKindRank('public'),
    networkKindRank('overlay'),
    networkKindRank('virtual'),
  ];
  assert.deepEqual(order, [...order].sort((left, right) => left - right));
  assert.equal(new Set(order).size, order.length);
});

test('「只允许同一网段」的网段计算和来源判断', async () => {
  const { allowedRangeFor, isAllowedSource } = await import('./remote-access-service.js');
  const lan = allowedRangeFor({ address: '192.168.2.163', cidr: '192.168.2.163/24' });
  assert.equal(lan?.cidr, '192.168.2.0/24');
  assert.equal(isAllowedSource('192.168.2.10', lan!), true);
  assert.equal(isAllowedSource('::ffff:192.168.2.10', lan!), true);
  assert.equal(isAllowedSource('192.168.3.10', lan!), false);
  assert.equal(isAllowedSource('203.0.113.5', lan!), false);
  assert.equal(isAllowedSource('2408::1', lan!), false);
  assert.equal(isAllowedSource(undefined, lan!), false);
  // 组网网卡掩码常是 /32：放行整个 100.64.0.0/10。
  const overlay = allowedRangeFor({ address: '100.107.3.4', cidr: '100.107.3.4/32' });
  assert.equal(overlay?.cidr, '100.64.0.0/10');
  assert.equal(isAllowedSource('100.127.255.254', overlay!), true);
  assert.equal(isAllowedSource('100.128.0.1', overlay!), false);
  // 其他 /32 网卡算不出网段。
  assert.equal(allowedRangeFor({ address: '10.8.0.2', cidr: '10.8.0.2/32' }), null);
  assert.equal(allowedRangeFor({ address: '10.8.0.2', cidr: null }), null);
});

test('公网地址校验：接受 IP 和域名，去掉协议头，拒绝端口和路径', async (t) => {
  const { initDb, closeDb } = await import('../db.js');
  const { normalizePublicHost, getPublicHost, setPublicHost, hostForUrl } = await import('./public-host.js');
  const { PanelError } = await import('../utils/errors.js');
  initDb();
  t.after(() => closeDb());
  assert.equal(normalizePublicHost(' 203.0.113.10 '), '203.0.113.10');
  assert.equal(normalizePublicHost('https://MC.Example.com/'), 'mc.example.com');
  assert.equal(normalizePublicHost('http://203.0.113.10'), '203.0.113.10');
  assert.equal(normalizePublicHost('2408:8207:AB::10'), '2408:8207:ab::10');
  assert.equal(normalizePublicHost('[2408:8207:ab::10]'), '2408:8207:ab::10');
  // 私网地址不拒绝，由界面提示。
  assert.equal(normalizePublicHost('192.168.1.5'), '192.168.1.5');
  const keyOf = (value: string): string => {
    try {
      normalizePublicHost(value);
      return 'accepted';
    } catch (error) {
      return error instanceof PanelError ? error.messageKey : 'other';
    }
  };
  assert.equal(keyOf('203.0.113.10:25565'), 'server.publicHost.hasPort');
  assert.equal(keyOf('mc.example.com:25565'), 'server.publicHost.hasPort');
  assert.equal(keyOf('[2408::1]:25565'), 'server.publicHost.hasPort');
  for (const bad of ['', '   ', 'mc.example.com/path', 'localhost', 'mc example.com', '1.2.3', 'a'.repeat(300), 'mc.exa_mple.com', 'fe80::1%eth0', '"x".com']) {
    assert.equal(keyOf(bad), 'server.publicHost.invalid', bad);
  }
  assert.equal(getPublicHost(), null);
  assert.equal(setPublicHost('https://mc.example.com/'), 'mc.example.com');
  assert.equal(getPublicHost(), 'mc.example.com');
  assert.equal(setPublicHost(null), null);
  assert.equal(getPublicHost(), null);
  assert.equal(hostForUrl('2408::1'), '[2408::1]');
  assert.equal(hostForUrl('mc.example.com'), 'mc.example.com');
});

test('面板端口的防火墙规则：localip / remoteip 只在对应设置开启时出现，限定程序失败时退回', async (t) => {
  const { panelPortFirewallArgs, openPanelPortFirewall, openPanelNetworkFirewall, closePanelFirewall, setPanelFirewallForTests } =
    await import('./panel-firewall.js');
  t.after(() => setPanelFirewallForTests(null));
  const program = 'C:\\Program Files\\nodejs\\node.exe';
  const open = panelPortFirewallArgs({ target: 'direct', port: 3000, localAddresses: [], remoteRanges: [], programPath: program });
  assert.deepEqual(open.fallback, [
    'advfirewall', 'firewall', 'add', 'rule', 'name=MystryDashboard-Panel-Direct-3000',
    'dir=in', 'action=allow', 'profile=any', 'enable=yes', 'protocol=TCP', 'localport=3000',
  ]);
  assert.deepEqual(open.args, [...open.fallback!, `program=${program}`]);
  const narrow = panelPortFirewallArgs({
    target: 'overlay', port: 3000, localAddresses: ['100.107.3.4'], remoteRanges: ['100.64.0.0/10'], programPath: 'relative\\node.exe',
  });
  assert.equal(narrow.fallback, null);
  assert.ok(narrow.args.includes('name=MystryDashboard-Panel-Overlay-3000'));
  assert.ok(narrow.args.includes('localip=100.107.3.4'));
  assert.ok(narrow.args.includes('remoteip=100.64.0.0/10'));
  assert.ok(!narrow.args.some((arg) => arg.startsWith('program=')));
  assert.throws(() => panelPortFirewallArgs({ target: 'direct', port: 0, localAddresses: [], remoteRanges: [], programPath: null }));
  assert.throws(() => panelPortFirewallArgs({ target: 'direct', port: 3000, localAddresses: ['1.2.3.4 & calc'], remoteRanges: [], programPath: null }));

  const calls: string[][] = [];
  const input = { target: 'direct' as const, port: 3000, localAddresses: [], remoteRanges: [], programPath: program };
  setPanelFirewallForTests({ platform: 'linux', runner: async (args) => { calls.push([...args]); return 0; } });
  assert.equal(await openPanelPortFirewall(input), 'skipped');
  assert.equal(await openPanelNetworkFirewall('C:\\data\\easytier-core.exe', 11010, 3000), 'skipped');
  await closePanelFirewall('direct', 3000);
  assert.equal(calls.length, 0);

  // 带 program= 的规则加不上时退回不限程序的规则；先删同名旧规则。
  setPanelFirewallForTests({
    platform: 'win32',
    runner: async (args) => {
      calls.push([...args]);
      return args[2] === 'add' && args.some((arg) => arg.startsWith('program=')) ? 1 : 0;
    },
  });
  assert.equal(await openPanelPortFirewall(input), 'applied');
  assert.deepEqual(calls.map((args) => args[2]), ['delete', 'add', 'add']);
  assert.ok(!calls[2]!.some((arg) => arg.startsWith('program=')));

  // 非管理员：全部加不上，结果为 failed，并按名字回滚。
  calls.length = 0;
  setPanelFirewallForTests({ platform: 'win32', runner: async (args) => { calls.push([...args]); return args[2] === 'add' ? 1 : 0; } });
  assert.equal(await openPanelPortFirewall(input), 'failed');
  assert.equal(calls.at(-1)![2], 'delete');

  // 面板自带 EasyTier：TCP 和 UDP 各一条，限定监听端口和程序。
  calls.length = 0;
  setPanelFirewallForTests({ platform: 'win32', runner: async (args) => { calls.push([...args]); return 0; } });
  assert.equal(await openPanelNetworkFirewall('C:\\data\\easytier-core.exe', 11010, 3000), 'applied');
  const added = calls.filter((args) => args[2] === 'add');
  assert.deepEqual(added.map((args) => args.find((arg) => arg.startsWith('protocol='))), ['protocol=TCP', 'protocol=UDP']);
  for (const args of added) {
    // 规则名用面板端口，不用每次启动都会变的 EasyTier 监听端口。
    assert.ok(args.includes('name=MystryDashboard-PanelNet-3000'));
    assert.ok(args.includes('localport=11010'));
    assert.ok(args.includes('program=C:\\data\\easytier-core.exe'));
  }
});

test('额外监听器：开关、HTTPS、明文跳转、来源限制、启动器接口隔离和关闭', async (t) => {
  const { buildApp } = await import('../index.js');
  const { closeDb } = await import('../db.js');
  const remote = await import('./remote-access-service.js');
  const { setPanelFirewallForTests } = await import('./panel-firewall.js');
  const { setPanelNetworkForTests } = await import('./panel-network.js');
  const { setPublicHost } = await import('./public-host.js');
  const { panelCertificatePaths } = await import('./panel-certificate.js');

  const firewallCalls: string[][] = [];
  setPanelFirewallForTests({ platform: 'win32', runner: async (args) => { firewallCalls.push([...args]); return 0; } });
  setPanelNetworkForTests({ platformSupported: () => false });

  // 用回环网段的地址冒充网卡：.2 是局域网，.3 是组网，.4 是实例联机网络，.5 是算不出网段的 /32 网卡。
  let interfaces: PanelNetworkInterface[] = [
    { name: 'WLAN', address: '127.0.0.2', cidr: '127.0.0.2/30', kind: 'lan' },
    { name: 'Tailscale', address: '127.0.0.3', cidr: '127.0.0.3/30', kind: 'overlay' },
    { name: 'mystry12', address: '127.0.0.4', cidr: '127.0.0.4/24', kind: 'instanceNetwork' },
  ];
  const logs: Array<{ obj: object; msg: string }> = [];
  const log = {
    info: (obj: object, msg: string) => { logs.push({ obj, msg }); },
    warn: (obj: object, msg: string) => { logs.push({ obj, msg }); },
  };

  const app = await buildApp({ skipDataLock: true });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  await remote.initRemoteAccess({ httpServer: app.server, log, listInterfaces: () => interfaces, disableTimer: true });
  t.after(async () => {
    await remote.shutdownRemoteAccess();
    await app.close();
    closeDb();
    setPanelFirewallForTests(null);
    setPanelNetworkForTests(null);
    remote.setRemoteAccessTimeoutForTests(null);
  });
  // 没开启任何方式时启动不调用 netsh：规则名全机固定，不能无条件清扫。
  assert.equal(firewallCalls.length, 0);

  const setup = await request(`http://127.0.0.1:${port}/api/auth/setup`, {
    method: 'POST',
    headers: { 'x-setup-token': 'b'.repeat(64) },
    body: { username: 'admin', password: 'password-for-tests' },
  });
  assert.equal(setup.status, 200, setup.body);
  const auth = { authorization: `Bearer ${(JSON.parse(setup.body) as { token: string }).token}` };
  const local = `http://127.0.0.1:${port}`;
  const status = async (): Promise<RemoteAccessStatus> => {
    const res = await request(`${local}/api/system/remote-access`, { headers: auth });
    assert.equal(res.status, 200, res.body);
    return JSON.parse(res.body) as RemoteAccessStatus;
  };
  const put = (mode: 'direct' | 'overlay', body: object, base = local, extra: { localAddress?: string } = {}) =>
    request(`${base}/api/system/remote-access/${mode}`, { method: 'PUT', headers: auth, body, ...extra });

  // 未登录一律 401。
  for (const [method, url] of [
    ['GET', '/api/system/remote-access'],
    ['PUT', '/api/system/remote-access/direct'],
    ['PUT', '/api/system/remote-access/overlay'],
    ['POST', '/api/system/remote-access/certificate'],
    ['PUT', '/api/system/remote-access/panel-network'],
    ['GET', '/api/system/remote-access/panel-network/join'],
    ['POST', '/api/system/remote-access/panel-network/reset-secret'],
    ['PUT', '/api/system/public-host'],
  ] as const) {
    assert.equal((await request(`${local}${url}`, { method, body: method === 'GET' ? undefined : {} })).status, 401, url);
  }

  // 默认：没开启，HTTPS 默认值为 true，其他设备连不上。
  const initial = await status();
  assert.equal(initial.managedByConfig, false);
  assert.equal(initial.port, port);
  assert.equal(initial.direct.enabled, false);
  assert.equal(initial.direct.https, true);
  assert.equal(initial.overlay.https, false);
  assert.deepEqual(initial.direct.urls, []);
  assert.equal(initial.certificate, null);
  assert.equal(initial.panelNetwork.enabled, false);
  await assert.rejects(request(`http://127.0.0.2:${port}/api/health`), /ECONNREFUSED/);

  // 参数不合法、网卡不存在。
  assert.equal((await put('direct', { enabled: true })).status, 400);
  const gone = await put('direct', { enabled: true, interfaceName: 'Nope', restrictToSubnet: false, https: false });
  assert.equal(gone.status, 409);
  assert.equal((JSON.parse(gone.body) as { code: string }).code, 'server.remoteAccess.interfaceGone');
  const noName = await put('overlay', { enabled: true, interfaceName: null, restrictToSubnet: false, https: false });
  assert.equal((JSON.parse(noName.body) as { code: string }).code, 'server.remoteAccess.interfaceRequired');

  // ---- 不加密开启「所有网卡」：不含实例联机网络 ----
  firewallCalls.length = 0;
  const opened = await put('direct', { enabled: true, interfaceName: null, restrictToSubnet: false, https: false });
  assert.equal(opened.status, 200, opened.body);
  const openedStatus = JSON.parse(opened.body) as RemoteAccessStatus;
  assert.deepEqual(openedStatus.direct.urls.map((item) => [item.url, item.kind, item.listening]), [
    [`http://127.0.0.2:${port}/`, 'lan', true],
    [`http://127.0.0.3:${port}/`, 'overlay', true],
  ]);
  assert.equal(openedStatus.direct.firewall, 'applied');
  assert.equal(openedStatus.direct.problem, null);
  const directRule = firewallCalls.find((args) => args[2] === 'add')!;
  assert.ok(directRule.includes(`name=MystryDashboard-Panel-Direct-${port}`));
  assert.ok(directRule.includes(`localport=${port}`));
  assert.ok(!directRule.some((arg) => arg.startsWith('localip=') || arg.startsWith('remoteip=')));
  await assert.rejects(request(`http://127.0.0.4:${port}/api/health`), /ECONNREFUSED/);

  // 其他设备（来源 127.0.0.9）经额外监听器访问：普通请求能通，进程指纹不返回。
  const far = { localAddress: '127.0.0.9' };
  const health = await request(`http://127.0.0.2:${port}/api/health`, far);
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), { ok: true, service: 'mystry-dashboard' });
  assert.equal((JSON.parse((await request(`${local}/api/health`)).body) as { processFingerprint?: string }).processFingerprint, 'fingerprint-for-test');
  // WebSocket 升级经额外监听器也能走通：和连本机得到同样的首帧（没带 ticket 的提示），而不是被挂断。
  const localFrame = await consoleSocketFirstFrame(`ws://127.0.0.1:${port}/ws/console/none`);
  assert.equal(localFrame, 'server.instance.consoleTicketMissing');
  assert.equal(await consoleSocketFirstFrame(`ws://127.0.0.2:${port}/ws/console/none`), localFrame);
  // 已登录的非回环请求可以读状态、改设置。
  assert.equal((await request(`http://127.0.0.2:${port}/api/system/remote-access`, { headers: auth, ...far })).status, 200);
  // 启动器反复读状态（remote 命令每次都读）不会撞上严格限额，也不影响安全关闭接口。
  for (let index = 0; index < 15; index += 1) {
    const res = await request(`${local}/api/launcher/remote-access`, { headers: { 'x-launcher-token': LAUNCHER_TOKEN } });
    assert.equal(res.status, 200, `第 ${index + 1} 次读状态`);
  }
  // 测试里的 buildApp 没有接关闭回调，所以是 503；关键是它不是 429。
  assert.equal((await request(`${local}/api/launcher/shutdown`, { method: 'POST', headers: { 'x-launcher-token': LAUNCHER_TOKEN }, body: {} })).status, 503);
  // 启动器接口：其他设备即使带着正确的 LAUNCHER_TOKEN 也被拒绝。
  const launcherHeaders = { 'x-launcher-token': LAUNCHER_TOKEN };
  for (const [method, url] of [
    ['POST', '/api/launcher/shutdown'],
    ['POST', '/api/launcher/reset-password'],
    ['GET', '/api/launcher/remote-access'],
    ['PUT', '/api/launcher/remote-access/direct'],
    ['POST', '/api/launcher/remote-access/certificate'],
  ] as const) {
    const res = await request(`http://127.0.0.2:${port}${url}`, { method, headers: launcherHeaders, body: method === 'GET' ? undefined : {}, ...far });
    assert.equal(res.status, 403, url);
  }
  // 本机启动器：缺令牌 401，带令牌能读状态。
  assert.equal((await request(`${local}/api/launcher/remote-access`)).status, 401);
  const launcherStatus = await request(`${local}/api/launcher/remote-access`, { headers: launcherHeaders });
  assert.equal(launcherStatus.status, 200);
  assert.equal((JSON.parse(launcherStatus.body) as RemoteAccessStatus).direct.enabled, true);

  // 开关都写日志，日志里没有令牌。
  const changeLog = logs.find((entry) => entry.msg.includes('设置已更改'));
  assert.ok(changeLog);
  assert.equal((changeLog.obj as { sourceIp: string }).sourceIp, '127.0.0.1');
  assert.ok(!JSON.stringify(logs).includes(LAUNCHER_TOKEN));

  // ---- 网卡变化：新地址补挂，消失的地址关掉 ----
  interfaces = [...interfaces, { name: 'Ethernet', address: '127.0.0.6', cidr: '127.0.0.6/24', kind: 'lan' }];
  assert.ok((await status()).direct.urls.some((item) => item.url === `http://127.0.0.6:${port}/` && item.listening));
  assert.equal((await request(`http://127.0.0.6:${port}/api/health`)).status, 200);
  interfaces = interfaces.filter((entry) => entry.address !== '127.0.0.6');
  assert.ok(!(await status()).direct.urls.some((item) => item.url.includes('127.0.0.6')));
  await assert.rejects(request(`http://127.0.0.6:${port}/api/health`), /ECONNREFUSED/);

  // 一个地址被别的程序占用：只标出它，其他照常。
  const blocker = net.createServer();
  await new Promise<void>((resolve) => blocker.listen({ host: '127.0.0.7', port, exclusive: true }, resolve));
  interfaces = [...interfaces, { name: 'Busy', address: '127.0.0.7', cidr: '127.0.0.7/24', kind: 'lan' }];
  const partial = await status();
  const busy = partial.direct.urls.find((item) => item.url.includes('127.0.0.7'))!;
  assert.equal(busy.listening, false);
  assert.equal(busy.problem, 'listenFailed');
  assert.equal(partial.direct.problem, null);
  assert.equal((await request(`http://127.0.0.2:${port}/api/health`)).status, 200);

  // 全部失败：返回 listenFailed，设置回到操作前（仍是「所有网卡」）。
  const allFailed = await put('direct', { enabled: true, interfaceName: 'Busy', restrictToSubnet: false, https: false });
  assert.equal(allFailed.status, 409);
  assert.equal((JSON.parse(allFailed.body) as { code: string }).code, 'server.remoteAccess.listenFailed');
  const afterFailure = await status();
  assert.equal(afterFailure.direct.interfaceName, null);
  assert.equal(afterFailure.direct.enabled, true);
  assert.equal((await request(`http://127.0.0.2:${port}/api/health`)).status, 200);
  await new Promise<void>((resolve) => blocker.close(() => resolve()));
  interfaces = interfaces.filter((entry) => entry.address !== '127.0.0.7');

  // ---- 已装的组网软件：占用 Tailscale 网卡，直接访问让出这个地址但照样列出 ----
  firewallCalls.length = 0;
  const overlay = await put('overlay', { enabled: true, interfaceName: 'Tailscale', restrictToSubnet: true, https: false });
  assert.equal(overlay.status, 200, overlay.body);
  const overlayStatus = JSON.parse(overlay.body) as RemoteAccessStatus;
  assert.deepEqual(overlayStatus.overlay.urls.map((item) => [item.url, item.listening]), [[`http://127.0.0.3:${port}/`, true]]);
  assert.ok(overlayStatus.direct.urls.some((item) => item.url === `http://127.0.0.3:${port}/` && item.listening));
  const overlayRule = firewallCalls.find((args) => args[2] === 'add' && args.includes(`name=MystryDashboard-Panel-Overlay-${port}`))!;
  assert.ok(overlayRule.includes('localip=127.0.0.3'));
  assert.ok(overlayRule.includes('remoteip=127.0.0.0/30'));
  // 只允许同一网段：127.0.0.0/30 内的来源放行，之外的直接断开；没开这个开关的监听器不受影响。
  assert.equal((await request(`http://127.0.0.3:${port}/api/health`, { localAddress: '127.0.0.1' })).status, 200);
  await assert.rejects(request(`http://127.0.0.3:${port}/api/health`, far), /ECONNRESET|socket hang up/);
  assert.equal((await request(`http://127.0.0.2:${port}/api/health`, far)).status, 200);
  // /32 的非组网网卡算不出网段：开着这个开关时不监听，标 subnetUnknown。
  interfaces = [...interfaces, { name: 'ppp0', address: '127.0.0.5', cidr: '127.0.0.5/32', kind: 'lan' }];
  const unknown = await put('overlay', { enabled: true, interfaceName: 'ppp0', restrictToSubnet: true, https: false });
  assert.equal(unknown.status, 409);
  assert.equal((JSON.parse(unknown.body) as { code: string }).code, 'server.remoteAccess.noAddress');
  assert.equal((await status()).overlay.interfaceName, 'Tailscale');
  interfaces = interfaces.filter((entry) => entry.address !== '127.0.0.5');
  assert.equal((await put('overlay', { enabled: false, interfaceName: 'Tailscale', restrictToSubnet: false, https: false })).status, 200);

  // ---- HTTPS（默认）：TLS 握手交给面板，明文跳转到 https ----
  setPublicHost('panel.example.com');
  const secured = await put('direct', { enabled: true, interfaceName: 'WLAN', restrictToSubnet: false, https: true });
  assert.equal(secured.status, 200, secured.body);
  const securedStatus = JSON.parse(secured.body) as RemoteAccessStatus;
  assert.deepEqual(securedStatus.direct.urls.map((item) => [item.url, item.kind, item.listening]), [
    [`https://127.0.0.2:${port}/`, 'lan', true],
    [`https://panel.example.com:${port}/`, 'publicHost', true],
  ]);
  assert.match(securedStatus.certificate!.fingerprint256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  assert.ok(securedStatus.certificate!.addresses.includes('127.0.0.2'));
  assert.ok(securedStatus.certificate!.addresses.includes('panel.example.com'));
  const certPem = fs.readFileSync(panelCertificatePaths().cert, 'utf8');
  // 私钥不进日志，状态接口里也没有。
  const keyBody = fs.readFileSync(panelCertificatePaths().key, 'utf8').split('\n')[1]!;
  assert.ok(!JSON.stringify(logs).includes(keyBody));
  assert.ok(!secured.body.includes(keyBody));

  const tlsHealth = await request(`https://127.0.0.2:${port}/api/health`, far);
  assert.equal(tlsHealth.status, 200);
  assert.deepEqual(JSON.parse(tlsHealth.body), { ok: true, service: 'mystry-dashboard' });
  // wss:// 同样可用：手机上看控制台走的就是这条路。
  assert.equal(await consoleSocketFirstFrame(`wss://127.0.0.2:${port}/ws/console/none`), 'server.instance.consoleTicketMissing');
  // 明文 ws:// 连到 HTTPS 监听器只会拿到跳转，不会到达面板。
  assert.equal(await consoleSocketFirstFrame(`ws://127.0.0.2:${port}/ws/console/none`), 'http 308');
  // 信任这张证书的客户端按默认规则校验通过；不信任的被拒绝。
  await new Promise<void>((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.2', port, ca: certPem }, () => { socket.end(); resolve(); });
    socket.once('error', reject);
  });
  await assert.rejects(
    new Promise((resolve, reject) => {
      const socket = tls.connect({ host: '127.0.0.2', port }, () => resolve(null));
      socket.once('error', reject);
    }),
    (error: NodeJS.ErrnoException) => error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT',
  );
  // 经 HTTPS 监听器访问启动器接口同样被拒绝。
  assert.equal((await request(`https://127.0.0.2:${port}/api/launcher/remote-access`, { headers: launcherHeaders, ...far })).status, 403);
  // 明文：308 跳到同主机的 https，保留路径和查询参数；请求不到达面板路由。
  const redirect = await request(`http://127.0.0.2:${port}/api/health?x=1`);
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.location, `https://127.0.0.2:${port}/api/health?x=1`);
  assert.equal(redirect.body, '');
  assert.equal(redirect.headers['strict-transport-security'], undefined);
  const dirty = await request(`http://127.0.0.2:${port}/x`, { rawHost: 'evil.example.com"<>;:8443' });
  assert.equal(dirty.headers.location, 'https://evil.example.com:8443/x');
  // 本机监听器始终是 HTTP。
  assert.equal((await request(`${local}/api/health`)).status, 200);

  // 空连接和握手不完成的连接超时后断开。
  remote.setRemoteAccessTimeoutForTests(80);
  const idleClosed = await new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: '127.0.0.2', port });
    socket.on('error', () => resolve(true));
    socket.on('close', () => resolve(true));
    setTimeout(() => resolve(false), 2000).unref();
  });
  assert.equal(idleClosed, true);
  const stalledClosed = await new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: '127.0.0.2', port }, () => socket.write(Buffer.from([0x16, 0x03, 0x01])));
    socket.on('error', () => resolve(true));
    socket.on('close', () => resolve(true));
    setTimeout(() => resolve(false), 2000).unref();
  });
  assert.equal(stalledClosed, true);
  remote.setRemoteAccessTimeoutForTests(null);

  // 重新生成证书：指纹变化，监听器继续工作。
  const renewed = await request(`${local}/api/system/remote-access/certificate`, { method: 'POST', headers: auth });
  assert.equal(renewed.status, 200, renewed.body);
  assert.notEqual((JSON.parse(renewed.body) as RemoteAccessStatus).certificate!.fingerprint256, securedStatus.certificate!.fingerprint256);
  assert.equal((await request(`https://127.0.0.2:${port}/api/health`)).status, 200);

  // 选的网卡不在了：读状态时给出 interfaceGone，面板照常工作；网卡回来后自动恢复。
  const saved = interfaces;
  interfaces = interfaces.filter((entry) => entry.name !== 'WLAN');
  const lost = await status();
  assert.equal(lost.direct.problem, 'interfaceGone');
  assert.equal(lost.direct.enabled, true);
  interfaces = saved;
  assert.equal((await status()).direct.problem, null);

  // ---- 关闭：已建立的长连接立即断开，防火墙规则删除 ----
  const keepAlive = net.connect({ host: '127.0.0.2', port });
  await new Promise<void>((resolve) => keepAlive.once('connect', () => resolve()));
  let dropped = false;
  keepAlive.on('close', () => { dropped = true; });
  keepAlive.on('error', () => { dropped = true; });
  firewallCalls.length = 0;
  // 在远程设备上关掉自己正在用的方式：请求本身的连接也会被断开，所以从本机发。
  const closed = await put('direct', { enabled: false, interfaceName: 'WLAN', restrictToSubnet: false, https: true });
  assert.equal(closed.status, 200);
  assert.deepEqual((JSON.parse(closed.body) as RemoteAccessStatus).direct.urls, []);
  await waitFor(() => dropped);
  await assert.rejects(request(`https://127.0.0.2:${port}/api/health`), /ECONNREFUSED/);
  assert.ok(firewallCalls.some((args) => args[2] === 'delete' && args.includes(`name=MystryDashboard-Panel-Direct-${port}`)));

  // 公网地址接口。
  const badHost = await request(`${local}/api/system/public-host`, { method: 'PUT', headers: auth, body: { host: 'mc.example.com:25565' } });
  assert.equal(badHost.status, 400);
  assert.equal((JSON.parse(badHost.body) as { code: string }).code, 'server.publicHost.hasPort');
  const cleared = await request(`${local}/api/system/public-host`, { method: 'PUT', headers: auth, body: { host: null } });
  assert.deepEqual(JSON.parse(cleared.body), { publicHost: null });
});

test('HOST 已是非回环地址时由配置文件决定，开关只读', async (t) => {
  const { buildApp } = await import('../index.js');
  const { closeDb } = await import('../db.js');
  const remote = await import('./remote-access-service.js');
  const { setPanelFirewallForTests } = await import('./panel-firewall.js');
  const { setPanelNetworkForTests } = await import('./panel-network.js');
  const { PanelError } = await import('../utils/errors.js');
  // 平台按 Windows 算：从没开启过的面板，启动和关闭全程不应调用 netsh。
  const netshCalls: string[][] = [];
  setPanelFirewallForTests({ platform: 'win32', runner: async (args) => { netshCalls.push([...args]); return 0; } });
  setPanelNetworkForTests({ platformSupported: () => false });
  const app = await buildApp({ skipDataLock: true });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  await remote.initRemoteAccess({
    httpServer: app.server,
    host: '0.0.0.0',
    disableTimer: true,
    listInterfaces: () => [{ name: 'eth0', address: '127.0.0.2', cidr: '127.0.0.2/24', kind: 'lan' }],
  });
  t.after(async () => {
    await remote.shutdownRemoteAccess();
    await app.close();
    closeDb();
    setPanelFirewallForTests(null);
    setPanelNetworkForTests(null);
  });
  const status = await remote.getRemoteAccessStatus();
  assert.equal(status.managedByConfig, true);
  assert.equal(status.configuredHost, '0.0.0.0');
  assert.deepEqual(status.direct.urls.map((item) => item.url), [`http://127.0.0.2:${port}/`]);
  assert.equal(status.direct.firewall, null);
  await assert.rejects(
    remote.setAccessMode('direct', { enabled: false, interfaceName: null, restrictToSubnet: false, https: true }, '127.0.0.1'),
    (error: unknown) => error instanceof PanelError && error.messageKey === 'server.remoteAccess.managedByConfig',
  );
  await remote.shutdownRemoteAccess();
  assert.equal(netshCalls.length, 0);
});

test('面板自带网络：配置只放行组网专用端口，密钥不进命令行、日志和状态', async (t) => {
  const { initDb, closeDb } = await import('../db.js');
  const network = await import('./panel-network.js');
  const { setPanelFirewallForTests } = await import('./panel-firewall.js');
  const { setLanListenPortAllocatorForTests } = await import('./lan-manager.js');
  const { LAN_SHARED_PEERS } = await import('./lan-config.js');
  const { PanelError } = await import('../utils/errors.js');
  initDb();
  const firewallCalls: string[][] = [];
  setPanelFirewallForTests({ platform: 'win32', runner: async (args) => { firewallCalls.push([...args]); return 0; } });

  // 配置文件内容。
  const toml = network.renderPanelNetworkToml({
    networkName: `mystry-panel-${'a'.repeat(32)}`,
    networkSecret: 'abcdefghijklmnopqrstuvwxyz'.slice(0, 26),
    accessPort: 3000,
    peers: ['tcp://relay.example.com:11010'],
    listenPort: 23456,
  });
  assert.match(toml, /^ipv4 = "10\.127\.0\.1"$/m);
  assert.match(toml, /^dhcp = false$/m);
  assert.match(toml, /^tcp_whitelist = \["3000"\]$/m);
  assert.match(toml, /^udp_whitelist = \["1"\]$/m);
  assert.match(toml, /^no_tun = true$/m);
  assert.match(toml, /^private_mode = true$/m);
  assert.match(toml, /^enable_exit_node = false$/m);
  assert.match(toml, /^listeners = \["tcp:\/\/0\.0\.0\.0:23456", "udp:\/\/0\.0\.0\.0:23456"\]$/m);
  assert.equal((toml.match(/tcp_whitelist/g) ?? []).length, 1);
  const bad = { networkName: `mystry-panel-${'a'.repeat(32)}`, networkSecret: 'abcdefghijklmnopqrstuvwxyz', accessPort: 3000, listenPort: null };
  assert.throws(() => network.renderPanelNetworkToml({ ...bad, peers: ['tcp://relay.example.com:11010"\nno_tun = false'] }));
  assert.throws(() => network.renderPanelNetworkToml({ ...bad, peers: [] }));
  assert.throws(() => network.renderPanelNetworkToml({ ...bad, networkSecret: 'x"y', peers: ['tcp://a.example.com:1'] }));

  // 设备列表解析：去掉本机节点和没有虚拟地址的共享节点。
  assert.deepEqual(
    network.parsePanelNetworkDevices(JSON.stringify([
      { cidr: '10.127.0.1/24', ipv4: '10.127.0.1', hostname: 'mystry-panel', cost: 'Local' },
      { cidr: '10.127.0.2/24', ipv4: '10.127.0.2', hostname: 'Pixel-8', cost: 'p2p' },
      { ipv4: '10.127.0.3', hostname: 'laptop', cost: 'relay(2)' },
      { ipv4: '', hostname: 'PublicServer_a', cost: 'p2p' },
      { ipv4: '10.127.0.4', hostname: 'tablet', cost: '?' },
      'junk',
    ])),
    [
      { hostname: 'Pixel-8', virtualIp: '10.127.0.2', connection: 'direct' },
      { hostname: 'laptop', virtualIp: '10.127.0.3', connection: 'relay' },
      { hostname: 'tablet', virtualIp: '10.127.0.4', connection: 'unknown' },
    ],
  );
  assert.deepEqual(network.parsePanelNetworkDevices('not json'), []);
  assert.deepEqual(network.parsePanelNetworkDevices('{"x":1}'), []);

  // 运行流程：替身进程和命令行。
  type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; exitCode: number | null; kill: () => boolean };
  const children: FakeChild[] = [];
  const spawns: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv | undefined; cwd: string }> = [];
  let installs = 0;
  let installed = false;
  let ready = false;
  const logs: string[] = [];
  const log = { info: (obj: object, msg: string) => { logs.push(JSON.stringify(obj) + msg); }, warn: (obj: object, msg: string) => { logs.push(JSON.stringify(obj) + msg); } };
  network.setPanelNetworkForTests({
    platformSupported: () => true,
    installed: () => installed,
    installer: async () => { installs += 1; installed = true; },
    probeTiming: { fastMs: 5, slowMs: 5, fastAttempts: 3 },
    spawner: (command, args, options) => {
      const child = new EventEmitter() as FakeChild;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.exitCode = null;
      child.kill = () => {
        if (child.exitCode === null) {
          child.exitCode = 0;
          setImmediate(() => child.emit('exit', 0));
        }
        return true;
      };
      children.push(child);
      spawns.push({ command, args, env: options.env, cwd: String(options.cwd) });
      return child as unknown as ChildProcess;
    },
    cliRunner: async (_rpcPort, command) => {
      if (command === 'node') {
        if (!ready) throw new Error('not ready');
        return JSON.stringify({ ipv4_addr: '10.127.0.1/24' });
      }
      return JSON.stringify([{ ipv4: '10.127.0.2', hostname: 'Pixel-8', cost: 'p2p' }]);
    },
  });
  setLanListenPortAllocatorForTests(null);
  t.after(async () => {
    await network.shutdownPanelNetwork();
    network.setPanelNetworkForTests(null);
    setPanelFirewallForTests(null);
    closeDb();
  });
  await network.initPanelNetwork({ port: 3210, log });

  const initial = network.getPanelNetworkStatus();
  assert.equal(initial.enabled, false);
  assert.equal(initial.state, 'stopped');
  assert.deepEqual(initial.sharedPeers, [...LAN_SHARED_PEERS]);
  assert.throws(() => network.getPanelNetworkJoinInfo(), (error: unknown) => error instanceof PanelError && error.messageKey === 'server.panelNetwork.notEnabled');
  assert.throws(
    () => network.updatePanelNetwork({ enabled: true, useSharedPeers: false, customPeers: [] }, '127.0.0.1'),
    (error: unknown) => error instanceof PanelError && error.messageKey === 'server.panelNetwork.noPeers',
  );
  assert.throws(() => network.updatePanelNetwork({ enabled: true, customPeers: ['http://x'] }, '127.0.0.1'));

  // 开启：先安装，再启动；探测到固定虚拟地址后为 running。
  const starting = network.updatePanelNetwork({ enabled: true }, '192.168.2.10');
  assert.equal(starting.enabled, true);
  assert.ok(starting.state === 'starting' || starting.state === 'installing');
  await network.waitForPanelNetworkIdle();
  assert.equal(installs, 1);
  assert.equal(spawns.length, 1);
  assert.equal(network.getPanelNetworkStatus().state, 'starting');
  ready = true;
  await waitFor(() => network.getPanelNetworkStatus().state === 'running');
  await network.refreshPanelNetworkDevices();
  const running: PanelNetworkStatus = network.getPanelNetworkStatus();
  assert.equal(running.virtualIp, '10.127.0.1');
  // 网址用组网专用端口，不是面板端口。
  const accessPort = Number(/^http:\/\/10\.127\.0\.1:(\d+)\/$/.exec(running.url ?? '')?.[1]);
  // 从面板端口往上找，不用系统的动态端口段（那里的端口下次启动容易被占）。
  assert.ok(accessPort > 3210 && accessPort <= 3230, running.url ?? 'null');
  assert.deepEqual(running.devices, [{ hostname: 'Pixel-8', virtualIp: '10.127.0.2', connection: 'direct' }]);
  assert.equal(running.firewall, 'applied');

  const join = network.getPanelNetworkJoinInfo();
  assert.match(join.networkName, /^mystry-panel-[0-9a-f]{32}$/);
  assert.match(join.networkSecret, /^[a-z2-7]{26}$/);
  assert.deepEqual(join.peers, [...LAN_SHARED_PEERS]);
  assert.match(join.androidDownloadUrl, /^https:\/\/github\.com\/EasyTier\/EasyTier\/releases\/tag\/v/);
  // 密钥只在配置文件和数据库里：不在命令行、子进程环境、状态和日志里。
  const written = fs.readFileSync(path.join(network.panelNetworkWorkDir(), 'core.toml'), 'utf8');
  assert.ok(written.includes(`network_secret = "${join.networkSecret}"`));
  // 白名单只放行专用端口：组网设备连不到面板端口，也就绕不开来源登记。
  assert.match(written, new RegExp(`^tcp_whitelist = \\["${accessPort}"\\]$`, 'm'));
  assert.match(written, /^no_tun = true$/m);
  assert.ok(!spawns[0]!.args.join(' ').includes(join.networkSecret));
  assert.deepEqual(spawns[0]!.args.slice(0, 3), ['-c', 'core.toml', '--rpc-portal']);
  assert.match(String(spawns[0]!.args[3]), /^127\.0\.0\.1:\d+$/);
  assert.ok(!JSON.stringify(spawns[0]!.env).includes(join.networkSecret));
  assert.equal(spawns[0]!.env?.JWT_SECRET, undefined);
  assert.ok(!JSON.stringify(running).includes(join.networkSecret));
  assert.ok(!JSON.stringify(running).includes(join.networkName));
  assert.ok(!logs.join('\n').includes(join.networkSecret));
  assert.ok(!logs.join('\n').includes(join.networkName));
  assert.ok(logs.some((line) => line.includes('192.168.2.10')));
  // 防火墙规则限定监听端口。
  const listenPort = /listeners = \["tcp:\/\/0\.0\.0\.0:(\d+)"/.exec(written)![1]!;
  assert.ok(firewallCalls.some((args) => args[2] === 'add' && args.includes(`localport=${listenPort}`) && args.includes('name=MystryDashboard-PanelNet-3210')));
  assert.notEqual(Number(listenPort), accessPort);

  // 设置没变时不重启。
  network.updatePanelNetwork({ enabled: true }, '127.0.0.1');
  await network.waitForPanelNetworkIdle();
  assert.equal(spawns.length, 1);

  // 进程退出：状态为 error。
  children[0]!.exitCode = 1;
  children[0]!.emit('exit', 1);
  const exited = network.getPanelNetworkStatus();
  assert.equal(exited.state, 'error');
  assert.equal(exited.detail?.key, 'server.panelNetwork.exited');
  assert.equal(exited.url, null);

  // 重置网络名和密钥：两者都变，进程用新配置重启。
  network.resetPanelNetworkSecret('127.0.0.1');
  await network.waitForPanelNetworkIdle();
  await waitFor(() => network.getPanelNetworkStatus().state === 'running');
  const rejoin = network.getPanelNetworkJoinInfo();
  assert.notEqual(rejoin.networkName, join.networkName);
  assert.notEqual(rejoin.networkSecret, join.networkSecret);
  assert.equal(spawns.length, 2);
  // 重启后沿用同一个专用端口：组网设备里存的网址不变。
  assert.equal(network.getPanelNetworkStatus().url, running.url);

  // 自定义节点、关掉共享节点。
  network.updatePanelNetwork({ enabled: true, useSharedPeers: false, customPeers: ['TCP://Relay.Example.com:11010'] }, '127.0.0.1');
  await network.waitForPanelNetworkIdle();
  assert.deepEqual(network.getPanelNetworkJoinInfo().peers, ['tcp://relay.example.com:11010']);
  assert.equal(spawns.length, 3);

  // 关闭：进程停止，规则删除。
  firewallCalls.length = 0;
  const stopped = network.updatePanelNetwork({ enabled: false }, '127.0.0.1');
  assert.equal(stopped.enabled, false);
  await network.waitForPanelNetworkIdle();
  assert.equal(children[2]!.exitCode, 0);
  assert.equal(network.getPanelNetworkStatus().state, 'stopped');
  assert.ok(firewallCalls.some((args) => args[2] === 'delete' && args.includes('name=MystryDashboard-PanelNet-3210')));
  // 关闭后专用端口不再监听。
  await assert.rejects(request(`http://127.0.0.1:${accessPort}/`), /ECONNREFUSED/);

  // 面板启动时按设置自动启动。
  network.updatePanelNetwork({ enabled: true }, '127.0.0.1');
  await network.waitForPanelNetworkIdle();
  await network.shutdownPanelNetwork();
  const before = spawns.length;
  await network.initPanelNetwork({ port: 3210, log });
  await network.waitForPanelNetworkIdle();
  assert.equal(spawns.length, before + 1);
  await waitFor(() => network.getPanelNetworkStatus().state === 'running');
  assert.equal(network.getPanelNetworkStatus().url, running.url);

  // 保存的专用端口被别的程序占用：换一个新端口照常启动，并写进设置。
  await network.shutdownPanelNetwork();
  const squatter = net.createServer();
  await new Promise<void>((resolve) => squatter.listen({ host: '127.0.0.1', port: accessPort, exclusive: true }, resolve));
  try {
    await network.initPanelNetwork({ port: 3210, log });
    await network.waitForPanelNetworkIdle();
    await waitFor(() => network.getPanelNetworkStatus().state === 'running');
    const moved = network.getPanelNetworkStatus().url;
    assert.ok(moved && moved !== running.url, String(moved));
    assert.ok(logs.some((line) => line.includes('专用端口被占用')));
  } finally {
    await new Promise<void>((resolve) => squatter.close(() => resolve()));
  }
});

test('面板自带网络：经专用端口进来的请求按组网设备处理，不冒充本机', async (t) => {
  const { buildApp } = await import('../index.js');
  const { closeDb } = await import('../db.js');
  const remote = await import('./remote-access-service.js');
  const network = await import('./panel-network.js');
  const { setPanelFirewallForTests } = await import('./panel-firewall.js');
  const { setLanListenPortAllocatorForTests } = await import('./lan-manager.js');

  setPanelFirewallForTests({ platform: 'linux', runner: async () => 0 });
  setLanListenPortAllocatorForTests(null);
  const children: Array<EventEmitter & { exitCode: number | null }> = [];
  network.setPanelNetworkForTests({
    platformSupported: () => true,
    installed: () => true,
    probeTiming: { fastMs: 5, slowMs: 5, fastAttempts: 3 },
    spawner: () => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; exitCode: number | null; kill: () => boolean };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.exitCode = null;
      child.kill = () => {
        if (child.exitCode === null) {
          child.exitCode = 0;
          setImmediate(() => child.emit('exit', 0));
        }
        return true;
      };
      children.push(child);
      return child as unknown as ChildProcess;
    },
    cliRunner: async (_rpcPort, command) => (command === 'node' ? JSON.stringify({ ipv4_addr: '10.127.0.1/24' }) : '[]'),
  });

  const app = await buildApp({ skipDataLock: true });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  await remote.initRemoteAccess({ httpServer: app.server, listInterfaces: () => [], disableTimer: true });
  t.after(async () => {
    await remote.shutdownRemoteAccess();
    await app.close();
    closeDb();
    network.setPanelNetworkForTests(null);
    setPanelFirewallForTests(null);
  });
  const local = `http://127.0.0.1:${port}`;

  // 前一个测试可能已建过管理员：建不了就用同样的账号登录。
  const setup = await request(`${local}/api/auth/setup`, {
    method: 'POST',
    headers: { 'x-setup-token': 'b'.repeat(64) },
    body: { username: 'admin', password: 'password-for-tests' },
  });
  const login = setup.status === 200
    ? setup
    : await request(`${local}/api/auth/login`, { method: 'POST', body: { username: 'admin', password: 'password-for-tests' } });
  assert.equal(login.status, 200, login.body);
  const auth = { authorization: `Bearer ${(JSON.parse(login.body) as { token: string }).token}` };

  const enabled = await request(`${local}/api/system/remote-access/panel-network`, { method: 'PUT', headers: auth, body: { enabled: true } });
  assert.equal(enabled.status, 200, enabled.body);
  await network.waitForPanelNetworkIdle();
  await waitFor(() => network.getPanelNetworkStatus().state === 'running');
  const url = network.getPanelNetworkStatus().url!;
  const accessPort = Number(new URL(url).port);
  assert.notEqual(accessPort, port);
  // 组网设备经 EasyTier 连到「虚拟地址:专用端口」，在本机落到 127.0.0.1:专用端口（实测 2.6.4）。
  const via = `http://127.0.0.1:${accessPort}`;

  // 普通请求和登录后的接口照常可用；WebSocket 也能升级。
  const health = await request(`${via}/api/health`);
  assert.equal(health.status, 200);
  // 进程指纹只给本机启动器：组网设备拿不到，本机照常拿到。
  assert.deepEqual(JSON.parse(health.body), { ok: true, service: 'mystry-dashboard' });
  assert.equal((JSON.parse((await request(`${local}/api/health`)).body) as { processFingerprint?: string }).processFingerprint, 'fingerprint-for-test');
  assert.equal((await request(`${via}/api/system/remote-access`, { headers: auth })).status, 200);
  assert.equal(await consoleSocketFirstFrame(`ws://127.0.0.1:${accessPort}/ws/console/none`), 'server.instance.consoleTicketMissing');

  // 启动器接口：带着正确的 LAUNCHER_TOKEN 也被拒绝；本机照常可用。
  const launcherHeaders = { 'x-launcher-token': LAUNCHER_TOKEN };
  for (const [method, path] of [
    ['POST', '/api/launcher/shutdown'],
    ['POST', '/api/launcher/reset-password'],
    ['GET', '/api/launcher/remote-access'],
    ['PUT', '/api/launcher/remote-access/direct'],
    ['POST', '/api/launcher/remote-access/certificate'],
  ] as const) {
    const res = await request(`${via}${path}`, { method, headers: launcherHeaders, body: method === 'GET' ? undefined : {} });
    assert.equal(res.status, 403, path);
  }
  assert.equal((await request(`${local}/api/launcher/remote-access`, { headers: launcherHeaders })).status, 200);

  // 组网里有人反复猜密码：组网这边被锁，本机登录不受影响。
  let lockedOut = false;
  for (let attempt = 0; attempt < 20 && !lockedOut; attempt += 1) {
    const res = await request(`${via}/api/auth/login`, { method: 'POST', body: { username: 'admin', password: 'wrong-password' } });
    if (res.status === 429) lockedOut = true;
    else assert.equal(res.status, 401, res.body);
  }
  assert.ok(lockedOut);
  const localLogin = await request(`${local}/api/auth/login`, { method: 'POST', body: { username: 'admin', password: 'password-for-tests' } });
  assert.equal(localLogin.status, 200, localLogin.body);

  // 关闭自带网络：专用端口立即不再接受连接。
  const disabled = await request(`${local}/api/system/remote-access/panel-network`, { method: 'PUT', headers: auth, body: { enabled: false } });
  assert.equal(disabled.status, 200, disabled.body);
  await network.waitForPanelNetworkIdle();
  await assert.rejects(request(`${via}/api/health`), /ECONNREFUSED/);
});

test('联机页本机网络：公网地址单独列出，server-ip 填成公网地址时给出专门标志', async (t) => {
  const { describeLocalNetwork } = await import('./local-network-service.js');
  const { initDb, closeDb } = await import('../db.js');
  const { createInstance } = await import('./instance-service.js');
  const { writeServerProperties } = await import('./config-service.js');
  const { setPublicHost } = await import('./public-host.js');
  const { config } = await import('../config.js');
  initDb();
  t.after(() => closeDb());
  const instanceId = createInstance({ name: 'Cloud', acceptEula: true }).id;
  const write = (serverIp: string) => writeServerProperties(instanceId, { 'server-port': '25570', 'server-ip': serverIp });
  const vps = { eth0: [ipv4('203.0.113.10')], eth1: [ipv4('10.0.0.5')], mystry12: [ipv4('10.126.12.1')] };

  write('');
  const open = describeLocalNetwork(instanceId, vps);
  assert.deepEqual(open.addresses, ['10.0.0.5']);
  assert.deepEqual(open.publicIpv4, ['203.0.113.10']);
  assert.equal(open.publicHost, null);
  assert.equal(open.panelPort, config.port);
  assert.equal(open.platform, process.platform);
  assert.equal(open.serverIpIsUnboundPublicHost, false);

  // server-ip 填网卡上的公网地址（VPS）：算正常，只返回这一个地址。
  write('203.0.113.10');
  const bound = describeLocalNetwork(instanceId, vps);
  assert.equal(bound.serverIpBlocked, false);
  assert.deepEqual(bound.addresses, []);
  assert.deepEqual(bound.publicIpv4, ['203.0.113.10']);

  // 云服务器（VPC）：网卡上只有私网地址，server-ip 填成了用户填写的公网地址。
  const vpc = { eth0: [ipv4('172.16.0.8')] };
  setPublicHost('198.51.100.7');
  write('198.51.100.7');
  const unbound = describeLocalNetwork(instanceId, vpc);
  assert.equal(unbound.publicHost, '198.51.100.7');
  assert.equal(unbound.serverIpBlocked, true);
  assert.equal(unbound.serverIpIsUnboundPublicHost, true);
  write('192.0.2.1');
  assert.equal(describeLocalNetwork(instanceId, vpc).serverIpIsUnboundPublicHost, false);
  write('');
  assert.deepEqual(describeLocalNetwork(instanceId, vpc).addresses, ['172.16.0.8']);
  setPublicHost(null);
});
