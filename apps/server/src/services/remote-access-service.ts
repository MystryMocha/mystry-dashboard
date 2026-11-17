import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import type {
  AccessModeStatus,
  PanelCertificateInfo,
  PanelNetworkInterface,
  RemoteAccessFirewall,
  RemoteAccessProblem,
  RemoteAccessStatus,
  RemoteAccessUrl,
  UpdateDirectAccessRequest,
} from '@mystry/shared';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { PanelError } from '../utils/errors.js';
import { isCgnatAddress, listNetworkInterfaces, networkKindRank } from './local-network-service.js';
import {
  loadOrCreatePanelCertificate,
  readPanelCertificateInfo,
  type PanelCertificate,
} from './panel-certificate.js';
import { closePanelFirewall, openPanelPortFirewall } from './panel-firewall.js';
import { getPanelNetworkStatus, initPanelNetwork, shutdownPanelNetwork } from './panel-network.js';
import { getPublicHost, hostForUrl } from './public-host.js';

/**
 * 从其他设备访问面板（D-033）。HOST 和主监听器保持不变；开启访问时，在要开放的每个地址上
 * 另起一个 net.Server 监听「地址:面板端口」，把连接交给 Fastify 的 HTTP 服务。
 * - 直接访问（direct）：默认所有网卡，也可只选一块；
 * - 已装的组网软件（overlay）：只在选定的组网网卡上监听。
 * 每个地址一个监听器（不用 0.0.0.0）：主监听器已占着 127.0.0.1 的同一端口，
 * 而且单块网卡和「只允许同一网段」本来就要按地址处理。
 * 额外监听器进来的连接 req.ip 是对方真实地址，所以只认回环的启动器接口从这里进不来。
 */

export type AccessMode = 'direct' | 'overlay';

interface AccessSettings {
  enabled: boolean;
  interfaceName: string | null;
  restrictToSubnet: boolean;
  https: boolean;
}

interface Ipv4Range {
  base: number;
  mask: number;
  cidr: string;
}

interface AccessListener {
  mode: AccessMode;
  address: string;
  https: boolean;
  range: Ipv4Range | null;
  server: net.Server;
  /** 还没交给 HTTP 服务、或由本监听器负责断开的连接（含 TLS 包装后的连接）。 */
  sockets: Set<net.Socket>;
}

interface ModeRuntime {
  problem: RemoteAccessProblem | null;
  firewall: RemoteAccessFirewall | null;
  /** 已应用的防火墙参数签名，变化时才重新加规则。 */
  firewallSignature: string | null;
  /** 没挂上的地址及原因。 */
  addressProblems: Map<string, RemoteAccessProblem>;
}

interface RemoteAccessLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface RemoteAccessInitOptions {
  /** 把连接交给它处理的 HTTP 服务（Fastify 的 app.server）。 */
  httpServer: http.Server;
  /** 额外监听器使用的端口；不传时取 httpServer 实际监听的端口。 */
  port?: number;
  log?: RemoteAccessLogger;
  /** 测试用：替换网卡枚举。 */
  listInterfaces?: () => PanelNetworkInterface[];
  /** 测试用：不启动定时重新枚举。 */
  disableTimer?: boolean;
  /** 测试用：覆盖 HOST 判断。 */
  host?: string;
}

const SETTING_KEYS: Record<AccessMode, string> = {
  direct: 'remote_access.direct',
  overlay: 'remote_access.overlay',
};
const DEFAULT_SETTINGS: Record<AccessMode, AccessSettings> = {
  direct: { enabled: false, interfaceName: null, restrictToSubnet: false, https: true },
  // 组网本身已加密，默认不再套一层 HTTPS，省掉浏览器警告。
  overlay: { enabled: false, interfaceName: null, restrictToSubnet: false, https: false },
};
/** 连上后这么久没发数据、或没完成 TLS 握手就断开。手动构造的 TLSSocket 不带 tls.Server 的握手超时。 */
const FIRST_BYTE_TIMEOUT_MS = 10_000;
/** 地址会变（DHCP、换 Wi-Fi、插拔网线），定时重新枚举网卡。 */
const RESCAN_INTERVAL_MS = 30_000;
const TLS_HANDSHAKE_BYTE = 0x16;

let httpServer: http.Server | null = null;
let panelPort = config.port;
let hostOverride: string | null = null;
let log: RemoteAccessLogger | null = null;
let interfaceLister: () => PanelNetworkInterface[] = () => listNetworkInterfaces();
let rescanTimer: NodeJS.Timeout | null = null;
let redirectServer: http.Server | null = null;
let certificate: PanelCertificate | null = null;
let secureContext: tls.SecureContext | null = null;
let firstByteTimeoutMs = FIRST_BYTE_TIMEOUT_MS;
const listeners = new Map<string, AccessListener>();
const runtimes: Record<AccessMode, ModeRuntime> = {
  direct: emptyRuntime(),
  overlay: emptyRuntime(),
};
/** 开关、重新枚举和关闭都排队执行，避免同时增删监听器。 */
let queue: Promise<unknown> = Promise.resolve();

function emptyRuntime(): ModeRuntime {
  return { problem: null, firewall: null, firewallSignature: null, addressProblems: new Map() };
}

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const next = queue.then(job, job);
  queue = next.catch(() => undefined);
  return next;
}

/** 测试用：缩短「没发数据就断开」的等待。 */
export function setRemoteAccessTimeoutForTests(ms: number | null): void {
  firstByteTimeoutMs = ms ?? FIRST_BYTE_TIMEOUT_MS;
}

// ---- 地址与网段 ----

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === 'localhost' || normalized === '::1' || normalized === '[::1]' || normalized.startsWith('127.');
}

function ipv4ToInt(address: string): number | null {
  if (!net.isIPv4(address)) return null;
  return address.split('.').reduce((value, part) => value * 256 + Number(part), 0);
}

function rangeFromCidr(cidr: string): Ipv4Range | null {
  const [address, prefixText] = cidr.split('/');
  const prefix = Number(prefixText);
  const value = ipv4ToInt(address ?? '');
  if (value === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const base = (value & mask) >>> 0;
  const dotted = [24, 16, 8, 0].map((shift) => (base >>> shift) & 0xff).join('.');
  return { base, mask, cidr: `${dotted}/${prefix}` };
}

/**
 * 「只允许同一网段」时，一块网卡允许的来源网段：
 * 组网网卡（100.64.0.0/10）掩码常是 /32，按网卡网段会把所有对端挡掉，所以放行整个 100.64.0.0/10；
 * 其他 /32 网卡算不出网段，返回 null。
 */
export function allowedRangeFor(entry: Pick<PanelNetworkInterface, 'address' | 'cidr'>): Ipv4Range | null {
  if (isCgnatAddress(entry.address)) return rangeFromCidr('100.64.0.0/10');
  if (!entry.cidr) return null;
  const range = rangeFromCidr(entry.cidr);
  return range && range.mask !== 0xffffffff ? range : null;
}

/** 来源地址是否在网段内；IPv4 映射的 IPv6 形式（::ffff:192.168.2.10）先还原。 */
export function isAllowedSource(remoteAddress: string | undefined, range: Ipv4Range): boolean {
  if (!remoteAddress) return false;
  const text = remoteAddress.toLowerCase().startsWith('::ffff:') ? remoteAddress.slice(7) : remoteAddress;
  const value = ipv4ToInt(text);
  return value !== null && ((value & range.mask) >>> 0) === range.base;
}

// ---- 设置 ----

function readSettings(mode: AccessMode): AccessSettings {
  const defaults = DEFAULT_SETTINGS[mode];
  const row = getDb().prepare('SELECT value FROM panel_settings WHERE key = ?').get(SETTING_KEYS[mode]) as
    | { value: string }
    | undefined;
  if (!row) return { ...defaults };
  try {
    const parsed = JSON.parse(row.value) as Partial<AccessSettings> | null;
    if (!parsed || typeof parsed !== 'object') return { ...defaults };
    return {
      enabled: parsed.enabled === true,
      interfaceName: typeof parsed.interfaceName === 'string' && parsed.interfaceName ? parsed.interfaceName : null,
      restrictToSubnet: parsed.restrictToSubnet === true,
      // 缺字段时按默认值（直接访问默认开 HTTPS）。
      https: typeof parsed.https === 'boolean' ? parsed.https : defaults.https,
    };
  } catch {
    return { ...defaults };
  }
}

function writeSettings(mode: AccessMode, settings: AccessSettings): void {
  getDb().prepare(
    `INSERT INTO panel_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(SETTING_KEYS[mode], JSON.stringify(settings), new Date().toISOString());
}

function configuredHost(): string {
  return hostOverride ?? config.host;
}

/** HOST 已是非回环地址：面板本来就对外开放，开关只读。 */
function managedByConfig(): boolean {
  return !isLoopbackHost(configuredHost());
}

// ---- 证书 ----

function certificateHosts(interfaces: readonly PanelNetworkInterface[]): string[] {
  const publicHost = getPublicHost();
  return [...interfaces.map((entry) => entry.address), ...(publicHost ? [publicHost] : [])];
}

/** 取得（必要时生成）证书和 TLS 上下文；失败时抛出 certificateFailed。 */
function ensureSecureContext(interfaces: readonly PanelNetworkInterface[], forceRenew = false): tls.SecureContext {
  if (secureContext && certificate && !forceRenew) return secureContext;
  try {
    const loaded = loadOrCreatePanelCertificate(certificateHosts(interfaces), { forceRenew });
    const context = tls.createSecureContext({ cert: loaded.certPem, key: loaded.keyPem });
    certificate = loaded;
    secureContext = context;
    return context;
  } catch (error) {
    // 原因只记日志（不含私钥内容），界面给出「不加密开启」的出路。
    log?.warn({ reason: error instanceof Error ? error.message : String(error) }, '面板 HTTPS 证书生成或读取失败');
    throw new PanelError('server.remoteAccess.certificateFailed', undefined, { statusCode: 500, cause: error });
  }
}

// ---- 监听器 ----

function sanitizeHostHeader(value: string | undefined, fallback: string): string {
  // 只保留主机名和端口的合法字符，其余一律丢弃。
  const cleaned = (value ?? '').replace(/[^A-Za-z0-9.\-:[\]]/g, '');
  return cleaned || fallback;
}

/** 只回跳转的小 HTTP 服务：明文请求不会到达面板路由。不发 HSTS。 */
function getRedirectServer(): http.Server {
  if (redirectServer) return redirectServer;
  const server = http.createServer((req, res) => {
    const local = req.socket.localAddress ?? '127.0.0.1';
    const host = sanitizeHostHeader(req.headers.host, `${local}:${panelPort}`);
    const target = req.url && req.url.startsWith('/') ? req.url : '/';
    res.writeHead(308, { Location: `https://${host}${target}`, Connection: 'close', 'Content-Length': '0' });
    res.end();
  });
  server.headersTimeout = FIRST_BYTE_TIMEOUT_MS;
  server.requestTimeout = FIRST_BYTE_TIMEOUT_MS;
  server.keepAliveTimeout = 1_000;
  redirectServer = server;
  return server;
}

function track(listener: AccessListener, socket: net.Socket): void {
  listener.sockets.add(socket);
  socket.once('close', () => listener.sockets.delete(socket));
}

function handleConnection(listener: AccessListener, socket: net.Socket): void {
  // 开了「只允许同一网段」时才检查来源。
  if (listener.range && !isAllowedSource(socket.remoteAddress, listener.range)) {
    socket.destroy();
    return;
  }
  track(listener, socket);
  socket.on('error', () => socket.destroy());
  if (!listener.https) {
    httpServer?.emit('connection', socket);
    return;
  }
  // 按第一个字节分流：0x16 是 TLS 握手，其他当作明文 HTTP 回跳转。
  const timer = setTimeout(() => socket.destroy(), firstByteTimeoutMs);
  socket.once('close', () => clearTimeout(timer));
  const onReadable = (): void => {
    const first = socket.read(1) as Buffer | null;
    if (first === null) {
      if (!socket.destroyed && !socket.readableEnded) socket.once('readable', onReadable);
      return;
    }
    socket.unshift(first);
    if (first[0] !== TLS_HANDSHAKE_BYTE) {
      clearTimeout(timer);
      getRedirectServer().emit('connection', socket);
      return;
    }
    const context = secureContext;
    if (!context) {
      socket.destroy();
      return;
    }
    const secure = new tls.TLSSocket(socket, { isServer: true, secureContext: context });
    track(listener, secure);
    // TLS 出错（如浏览器拒绝证书后中断握手）时销毁底层连接。
    secure.on('error', () => {
      secure.destroy();
      socket.destroy();
    });
    secure.once('secure', () => {
      clearTimeout(timer);
      // 握手完成后才交给 HTTP 服务；Fastify 据 socket.encrypted 把 req.protocol 判为 https。
      httpServer?.emit('connection', secure);
    });
  };
  socket.once('readable', onReadable);
}

function openListener(mode: AccessMode, address: string, https: boolean, range: Ipv4Range | null): Promise<AccessListener | null> {
  return new Promise((resolve) => {
    // 与 Node HTTP 服务的默认值一致，否则可能出现响应被截断或控制台输出延迟。
    const server = net.createServer({ allowHalfOpen: true, noDelay: true });
    const listener: AccessListener = { mode, address, https, range, server, sockets: new Set() };
    server.on('connection', (socket) => handleConnection(listener, socket));
    const onError = (): void => {
      server.removeAllListeners();
      resolve(null);
    };
    server.once('error', onError);
    server.listen({ host: address, port: panelPort, exclusive: true }, () => {
      server.off('error', onError);
      // 运行中出错（如网卡消失）只记下来，下次重新枚举时清掉。
      server.on('error', () => undefined);
      resolve(listener);
    });
  });
}

/** 先停止监听、再断开它的连接：close() 只是不再接受新连接，已建立的长连接要自己断开。 */
function closeListener(listener: AccessListener): Promise<void> {
  listeners.delete(listener.address);
  return new Promise((resolve) => {
    listener.server.close(() => resolve());
    // 集合里也包括已交给 HTTP 服务的连接：一并断开，那些设备上的会话立即失效。
    for (const socket of listener.sockets) socket.destroy();
  });
}

async function closeMode(mode: AccessMode): Promise<void> {
  await Promise.all([...listeners.values()].filter((item) => item.mode === mode).map(closeListener));
}

// ---- 候选地址 ----

interface Candidate {
  entry: PanelNetworkInterface;
  range: Ipv4Range | null;
  problem: RemoteAccessProblem | null;
}

/** 已装的组网软件占用的网卡名；直接访问的「所有网卡」跳过它的地址。 */
function overlayInterfaceName(): string | null {
  const overlay = readSettings('overlay');
  return overlay.enabled ? overlay.interfaceName : null;
}

function candidatesFor(
  mode: AccessMode,
  settings: AccessSettings,
  interfaces: readonly PanelNetworkInterface[],
): { candidates: Candidate[]; problem: RemoteAccessProblem | null } {
  let entries: PanelNetworkInterface[];
  if (settings.interfaceName !== null) {
    entries = interfaces.filter((entry) => entry.name === settings.interfaceName);
    if (entries.length === 0) return { candidates: [], problem: 'interfaceGone' };
  } else if (mode === 'overlay') {
    return { candidates: [], problem: 'interfaceGone' };
  } else {
    // 所有网卡：不含实例联机网络（它只放行游戏端口，挂了也连不上，地址还随联机启停）。
    entries = interfaces.filter((entry) => entry.kind !== 'instanceNetwork');
    if (entries.length === 0) return { candidates: [], problem: 'noAddress' };
  }
  if (mode === 'direct') {
    const taken = overlayInterfaceName();
    if (taken !== null) entries = entries.filter((entry) => entry.name !== taken);
  }
  const candidates = entries.map((entry): Candidate => {
    if (!settings.restrictToSubnet) return { entry, range: null, problem: null };
    const range = allowedRangeFor(entry);
    return range ? { entry, range, problem: null } : { entry, range: null, problem: 'subnetUnknown' };
  });
  return { candidates, problem: null };
}

function sameRange(left: Ipv4Range | null, right: Ipv4Range | null): boolean {
  return left?.cidr === right?.cidr;
}

/**
 * 按设置和当前网卡，把一种方式的监听器调整到位：新地址补挂，消失的地址关掉，设置变了的重建。
 * 返回正在监听的地址数。不抛错：问题记在运行时状态里。
 */
async function reconcileMode(mode: AccessMode, settings: AccessSettings, interfaces: readonly PanelNetworkInterface[]): Promise<number> {
  const runtime = runtimes[mode];
  runtime.addressProblems.clear();
  runtime.problem = null;
  if (!settings.enabled || managedByConfig() || !httpServer) {
    await closeMode(mode);
    return 0;
  }
  const { candidates, problem } = candidatesFor(mode, settings, interfaces);
  if (problem) {
    runtime.problem = problem;
    await closeMode(mode);
    return 0;
  }
  if (settings.https) {
    try {
      ensureSecureContext(interfaces);
    } catch {
      runtime.problem = 'certificateFailed';
      await closeMode(mode);
      return 0;
    }
  }
  const wanted = new Map(candidates.filter((item) => !item.problem).map((item) => [item.entry.address, item]));
  for (const item of candidates) {
    if (item.problem) runtime.addressProblems.set(item.entry.address, item.problem);
  }
  // 关掉不再需要或设置已变的监听器。
  for (const listener of [...listeners.values()]) {
    if (listener.mode !== mode) continue;
    const target = wanted.get(listener.address);
    if (!target || listener.https !== settings.https || !sameRange(listener.range, target.range)) {
      await closeListener(listener);
    }
  }
  let listening = 0;
  for (const [address, item] of wanted) {
    const existing = listeners.get(address);
    if (existing?.mode === mode) {
      listening += 1;
      continue;
    }
    if (existing) {
      // 地址正被另一种方式监听：组网方式接管自己选的网卡，直接访问则让给它。
      if (mode !== 'overlay') continue;
      await closeListener(existing);
    }
    const opened = await openListener(mode, address, settings.https, item.range);
    if (opened) {
      listeners.set(address, opened);
      listening += 1;
    } else {
      runtime.addressProblems.set(address, 'listenFailed');
    }
  }
  if (listening === 0) {
    runtime.problem = candidates.some((item) => !item.problem) ? 'listenFailed' : candidates.length > 0 ? 'subnetUnknown' : 'noAddress';
  }
  return listening;
}

async function applyFirewall(mode: AccessMode, settings: AccessSettings): Promise<void> {
  const runtime = runtimes[mode];
  const active = [...listeners.values()].filter((item) => item.mode === mode);
  if (!settings.enabled || active.length === 0) {
    if (runtime.firewallSignature !== null) await closePanelFirewall(mode, panelPort);
    runtime.firewall = null;
    runtime.firewallSignature = null;
    return;
  }
  const localAddresses = settings.interfaceName === null ? [] : active.map((item) => item.address).sort();
  const remoteRanges = settings.restrictToSubnet
    ? [...new Set(active.map((item) => item.range?.cidr).filter((value): value is string => Boolean(value)))].sort()
    : [];
  const signature = JSON.stringify({ port: panelPort, localAddresses, remoteRanges });
  if (signature === runtime.firewallSignature) return;
  runtime.firewall = await openPanelPortFirewall({
    target: mode,
    port: panelPort,
    localAddresses,
    remoteRanges,
    programPath: process.execPath,
  });
  runtime.firewallSignature = signature;
}

async function reconcileAll(): Promise<void> {
  const interfaces = interfaceLister();
  // 先处理组网方式：直接访问的「所有网卡」要让出它占用的网卡。
  for (const mode of ['overlay', 'direct'] as const) {
    const settings = readSettings(mode);
    await reconcileMode(mode, settings, interfaces);
    await applyFirewall(mode, settings);
  }
}

// ---- 状态 ----

function buildUrl(https: boolean, host: string): string {
  return `${https ? 'https' : 'http'}://${hostForUrl(host)}:${panelPort}/`;
}

function sortUrls(urls: RemoteAccessUrl[], addressOf: Map<RemoteAccessUrl, string>): RemoteAccessUrl[] {
  return urls
    .map((url, index) => ({ url, index }))
    .sort((left, right) =>
      networkKindRank(left.url.kind, addressOf.get(left.url)) - networkKindRank(right.url.kind, addressOf.get(right.url))
      || left.index - right.index)
    .map((item) => item.url);
}

function modeStatus(mode: AccessMode, interfaces: readonly PanelNetworkInterface[], publicHost: string | null): AccessModeStatus {
  const settings = readSettings(mode);
  const runtime = runtimes[mode];
  const urls: RemoteAccessUrl[] = [];
  const addressOf = new Map<RemoteAccessUrl, string>();
  const push = (url: RemoteAccessUrl, address: string): void => {
    urls.push(url);
    addressOf.set(url, address);
  };
  if (settings.enabled) {
    let entries: readonly PanelNetworkInterface[];
    if (settings.interfaceName !== null) entries = interfaces.filter((entry) => entry.name === settings.interfaceName);
    else entries = mode === 'direct' ? interfaces.filter((entry) => entry.kind !== 'instanceNetwork') : [];
    for (const entry of entries) {
      // 被另一种方式占用的地址照样列出，协议以实际监听它的那一方为准。
      const listener = listeners.get(entry.address);
      push({
        url: buildUrl(listener ? listener.https : settings.https, entry.address),
        interfaceName: entry.name,
        kind: entry.kind,
        listening: Boolean(listener),
        problem: listener ? null : runtime.addressProblems.get(entry.address) ?? null,
      }, entry.address);
    }
    if (mode === 'direct' && publicHost) {
      push({
        url: buildUrl(settings.https, publicHost),
        interfaceName: null,
        kind: 'publicHost',
        listening: [...listeners.values()].some((item) => item.mode === 'direct'),
        problem: null,
      }, publicHost);
    }
  }
  return {
    enabled: settings.enabled,
    interfaceName: settings.interfaceName,
    restrictToSubnet: settings.restrictToSubnet,
    https: settings.https,
    urls: sortUrls(urls, addressOf),
    problem: settings.enabled ? runtime.problem : null,
    firewall: settings.enabled ? runtime.firewall : null,
  };
}

/** HOST 由配置文件决定时：列出各网卡网址，开关只读。 */
function configManagedStatus(interfaces: readonly PanelNetworkInterface[], publicHost: string | null): AccessModeStatus {
  const host = configuredHost().trim();
  const wildcard = host === '0.0.0.0' || host === '::' || host === '[::]';
  const urls: RemoteAccessUrl[] = [];
  const addressOf = new Map<RemoteAccessUrl, string>();
  for (const entry of interfaces) {
    if (!wildcard && entry.address !== host) continue;
    const url: RemoteAccessUrl = { url: buildUrl(false, entry.address), interfaceName: entry.name, kind: entry.kind, listening: true, problem: null };
    urls.push(url);
    addressOf.set(url, entry.address);
  }
  if (urls.length === 0 && !wildcard) {
    // HOST 写的是主机名，或是一个没出现在网卡上的地址：照原样给出。
    const url: RemoteAccessUrl = { url: buildUrl(false, host), interfaceName: null, kind: 'publicHost', listening: true, problem: null };
    urls.push(url);
    addressOf.set(url, host);
  }
  if (publicHost && publicHost !== host) {
    const url: RemoteAccessUrl = { url: buildUrl(false, publicHost), interfaceName: null, kind: 'publicHost', listening: true, problem: null };
    urls.push(url);
    addressOf.set(url, publicHost);
  }
  return {
    enabled: true,
    interfaceName: null,
    restrictToSubnet: false,
    https: false,
    urls: sortUrls(urls, addressOf),
    problem: null,
    firewall: null,
  };
}

function currentCertificateInfo(): PanelCertificateInfo | null {
  return certificate?.info ?? readPanelCertificateInfo();
}

function frontendServed(): boolean {
  return fs.existsSync(path.join(config.webDist, 'index.html'));
}

function snapshot(interfaces: readonly PanelNetworkInterface[]): RemoteAccessStatus {
  const publicHost = getPublicHost();
  const managed = managedByConfig();
  return {
    managedByConfig: managed,
    configuredHost: managed ? configuredHost() : null,
    port: panelPort,
    frontendServed: frontendServed(),
    platform: process.platform,
    interfaces: [...interfaces],
    publicHost,
    certificate: currentCertificateInfo(),
    direct: managed ? configManagedStatus(interfaces, publicHost) : modeStatus('direct', interfaces, publicHost),
    overlay: managed
      ? { ...DEFAULT_SETTINGS.overlay, urls: [], problem: null, firewall: null }
      : modeStatus('overlay', interfaces, publicHost),
    panelNetwork: getPanelNetworkStatus(),
  };
}

/** 每次读状态都重新枚举网卡，顺带完成补挂和关闭。 */
export function getRemoteAccessStatus(): Promise<RemoteAccessStatus> {
  return enqueue(async () => {
    await reconcileAll();
    return snapshot(interfaceLister());
  });
}

// ---- 开关 ----

function assertChangeable(): void {
  if (managedByConfig()) throw new PanelError('server.remoteAccess.managedByConfig', undefined, { statusCode: 409 });
  if (!httpServer) throw new PanelError('server.remoteAccess.launcherUnavailable', undefined, { statusCode: 503 });
}

/**
 * 开启、关闭或修改一种访问方式。任何已登录的请求都可以调用（拿到登录令牌的人本来就能控制整个面板）。
 * 顺序：先按新设置调整监听器，至少挂上一个地址才写入设置；一个都挂不上时恢复原设置并抛错。
 */
export function setAccessMode(mode: AccessMode, body: UpdateDirectAccessRequest, sourceIp: string): Promise<RemoteAccessStatus> {
  return enqueue(async () => {
    assertChangeable();
    const previous = readSettings(mode);
    const next: AccessSettings = {
      enabled: body.enabled,
      interfaceName: body.interfaceName,
      restrictToSubnet: body.restrictToSubnet,
      https: body.https,
    };
    const interfaces = interfaceLister();
    if (next.enabled) {
      if (mode === 'overlay' && next.interfaceName === null) {
        throw new PanelError('server.remoteAccess.interfaceRequired', undefined, { statusCode: 400 });
      }
      if (next.interfaceName !== null && !interfaces.some((entry) => entry.name === next.interfaceName)) {
        throw new PanelError('server.remoteAccess.interfaceGone', { name: next.interfaceName }, { statusCode: 409 });
      }
      // 证书失败在动监听器之前就报出来，界面可以改用「不加密开启」。
      if (next.https) ensureSecureContext(interfaces);
    }
    writeSettings(mode, next);
    await reconcileAll();
    if (next.enabled && ![...listeners.values()].some((item) => item.mode === mode)) {
      const problem = runtimes[mode].problem;
      // 一个地址都没挂上：不留下「已开启」的设置，恢复到操作前。
      writeSettings(mode, previous);
      await reconcileAll();
      if (problem === 'noAddress' || problem === 'subnetUnknown') {
        throw new PanelError('server.remoteAccess.noAddress', undefined, { statusCode: 409 });
      }
      if (problem === 'interfaceGone') {
        throw new PanelError('server.remoteAccess.interfaceGone', { name: next.interfaceName ?? '' }, { statusCode: 409 });
      }
      throw new PanelError('server.remoteAccess.listenFailed', { port: panelPort }, { statusCode: 409 });
    }
    // 记录谁开关了哪种方式；不记密钥、令牌和私钥。
    log?.info(
      { mode, enabled: next.enabled, interfaceName: next.interfaceName, https: next.https, restrictToSubnet: next.restrictToSubnet, sourceIp },
      '从其他设备访问的设置已更改',
    );
    return snapshot(interfaceLister());
  });
}

/** 重新生成证书；HTTPS 开着时已建立的连接断开，新连接立即用新证书。 */
export function renewPanelCertificate(sourceIp: string): Promise<RemoteAccessStatus> {
  return enqueue(async () => {
    const interfaces = interfaceLister();
    ensureSecureContext(interfaces, true);
    for (const listener of [...listeners.values()]) {
      if (listener.https) await closeListener(listener);
    }
    await reconcileAll();
    log?.info({ sourceIp }, '面板 HTTPS 证书已重新生成');
    return snapshot(interfaceLister());
  });
}

// ---- 生命周期 ----

/** app.listen 成功后调用：按设置挂监听器。失败只记录原因，不影响面板启动。 */
export async function initRemoteAccess(options: RemoteAccessInitOptions): Promise<void> {
  httpServer = options.httpServer;
  const address = options.httpServer.address();
  panelPort = options.port ?? (address && typeof address === 'object' ? address.port : config.port);
  hostOverride = options.host ?? null;
  log = options.log ?? null;
  interfaceLister = options.listInterfaces ?? (() => listNetworkInterfaces());
  await enqueue(async () => {
    // 不按名字清扫防火墙规则：规则名是全机固定的，无条件删除会删掉同一台电脑上另一个面板
    // （或正式面板旁边跑的测试、临时面板）的规则。设置为开启的方式在加规则前本来就先删同名旧规则。
    try {
      await reconcileAll();
    } catch (error) {
      log?.warn({ reason: error instanceof Error ? error.message : String(error) }, '按设置开启从其他设备访问失败，面板只监听本机');
    }
    for (const mode of ['direct', 'overlay'] as const) {
      if (readSettings(mode).enabled && runtimes[mode].problem) {
        log?.warn({ mode, problem: runtimes[mode].problem }, '从其他设备访问没能开启，面板只监听本机');
      }
    }
  });
  // 组网专用端口接到的连接和额外监听器一样，交给同一个 HTTP 服务。
  await initPanelNetwork({ port: panelPort, handOff: (socket) => httpServer?.emit('connection', socket), log: options.log });
  if (!options.disableTimer) {
    rescanTimer = setInterval(() => {
      if (!readSettingsSafe('direct').enabled && !readSettingsSafe('overlay').enabled) return;
      void enqueue(reconcileAll).catch(() => undefined);
    }, RESCAN_INTERVAL_MS);
    rescanTimer.unref();
  }
}

/** 定时器可能在数据库关闭后触发，读不到设置时当作未开启。 */
function readSettingsSafe(mode: AccessMode): AccessSettings {
  try {
    return readSettings(mode);
  } catch {
    return { ...DEFAULT_SETTINGS[mode] };
  }
}

/** 关闭面板时调用（在等待 HTTP 连接断开之前）：停止所有监听器、断开连接、删除防火墙规则。 */
export async function shutdownRemoteAccess(): Promise<void> {
  if (rescanTimer) clearInterval(rescanTimer);
  rescanTimer = null;
  await enqueue(async () => {
    await Promise.all([...listeners.values()].map(closeListener));
    redirectServer?.closeAllConnections();
    redirectServer = null;
    await shutdownPanelNetwork();
    for (const mode of ['direct', 'overlay'] as const) {
      // 只删本进程尝试加过的规则；从没开启过的面板不调用 netsh。
      if (runtimes[mode].firewallSignature !== null) await closePanelFirewall(mode, panelPort);
      runtimes[mode] = emptyRuntime();
    }
    httpServer = null;
    certificate = null;
    secureContext = null;
  });
}
