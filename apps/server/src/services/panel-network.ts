import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  EASYTIER_VERSION,
  LAN_CUSTOM_PEER_LIMIT,
  PANEL_NETWORK_VIRTUAL_IP,
  type PanelMessage,
  type PanelNetworkDevice,
  type PanelNetworkJoinInfo,
  type PanelNetworkState,
  type PanelNetworkStatus,
  type RemoteAccessFirewall,
  type UpdatePanelNetworkRequest,
} from '@mystry/shared';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { writeFileAtomic } from '../utils/atomic-write.js';
import { getMinecraftChildEnv } from '../utils/child-env.js';
import { ensureSecureDirectory, forceSecureSensitiveFile } from '../utils/data-dir-permissions.js';
import { PanelError } from '../utils/errors.js';
import { markPanelNetworkSocket } from '../utils/request-origin.js';
import { LAN_SHARED_PEERS, lanCoreArgs, lanFailureDetail, normalizeLanPeer, normalizeLanPeers } from './lan-config.js';
import { allocateListenPort, allocateLoopbackPort } from './lan-manager.js';
import { ensureLanInstalled, lanCliPath, lanCorePath, lanInstalled, lanPlatformSupported } from './lan-runtime.js';
import { closePanelFirewall, openPanelNetworkFirewall } from './panel-firewall.js';

/**
 * 面板自带的 EasyTier 网络：只给自己的手机和电脑打开面板用，和实例的联机网络
 * 是两个独立网络，网络名、密钥、地址段都不同。
 * 用无 TUN 模式：不建虚拟网卡、不需要管理员身份；别的设备访问「虚拟地址:端口」时，
 * 连接落到本机 127.0.0.1 的同一端口，来源也是 127.0.0.1（实测 2.6.4）。
 * 为了和本机自己的连接分开，面板在 127.0.0.1 上另开一个只给组网用的端口（专用端口），
 * 白名单只放行它而不放行面板端口；从专用端口接进来的连接先登记（request-origin.ts）再交给同一个 HTTP 服务，
 * 所以启动器接口、进程指纹不对组网开放，限流和登录失败计数也不和本机共用。
 * 专用端口存进设置、每次启动沿用，组网设备里存的网址不会变；只有被别的程序占用时才换。
 * tcp_whitelist 只放行专用端口，这是唯一的防线：没有它，这台电脑上只监听本机的程序都会暴露给组网。
 * 升级 EasyTier 版本时必须重新确认白名单在无 TUN 模式下仍然生效。
 */

const SETTING_KEY = 'remote_access.panel_network';
const NETWORK_NAME_RE = /^mystry-panel-[0-9a-f]{32}$/;
const NETWORK_SECRET_RE = /^[a-z2-7]{26}$/;
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const DEVICE_REFRESH_MS = 5_000;
const DEVICE_LIMIT = 64;

interface PanelNetworkSettings {
  enabled: boolean;
  networkName: string;
  networkSecret: string;
  useSharedPeers: boolean;
  customPeers: string[];
  /** 组网专用端口；还没开过时为 null */
  localPort: number | null;
}

export interface PanelNetworkRenderInput {
  networkName: string;
  networkSecret: string;
  /** 白名单唯一放行的端口：组网专用端口 */
  accessPort: number;
  peers: string[];
  listenPort: number | null;
}

interface Runtime {
  state: Exclude<PanelNetworkState, 'stopped'>;
  detail: PanelMessage | null;
  child: ChildProcess | null;
  generation: number;
  configKey: string;
  rpcPort: number;
  firewall: RemoteAccessFirewall | null;
  firewallOpened: boolean;
  access: AccessListener | null;
}

/** 组网专用端口上的监听器：只绑 127.0.0.1，连接登记后交给面板的 HTTP 服务。 */
interface AccessListener {
  server: net.Server;
  sockets: Set<net.Socket>;
  port: number;
}

interface PanelNetworkLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

interface ProbeTiming {
  fastMs: number;
  slowMs: number;
  fastAttempts: number;
}

const DEFAULT_PROBE_TIMING: ProbeTiming = { fastMs: 1000, slowMs: 5000, fastAttempts: 15 };

let panelPort = config.port;
let handOff: ((socket: net.Socket) => void) | null = null;
let log: PanelNetworkLogger | null = null;
let runtime: Runtime | null = null;
let nextGeneration = 0;
let shuttingDown = false;
let pendingSyncs = 0;
let queue: Promise<unknown> = Promise.resolve();
let devices: PanelNetworkDevice[] = [];
let devicesReadAt = 0;
let spawner: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess = spawn;
let cliRunner: ((rpcPort: number, command: string) => Promise<string>) | null = null;
let installer: () => Promise<void> = ensureLanInstalled;
let installedCheck: () => boolean = lanInstalled;
let platformCheck: () => boolean = lanPlatformSupported;
let probeTiming = DEFAULT_PROBE_TIMING;

export interface PanelNetworkTestHooks {
  spawner?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  cliRunner?: (rpcPort: number, command: string) => Promise<string>;
  installer?: () => Promise<void>;
  installed?: () => boolean;
  platformSupported?: () => boolean;
  probeTiming?: ProbeTiming;
}

/** 测试用：替换进程启动、命令行读取和安装；传 null 恢复默认并清空运行状态。 */
export function setPanelNetworkForTests(hooks: PanelNetworkTestHooks | null): void {
  spawner = hooks?.spawner ?? spawn;
  cliRunner = hooks?.cliRunner ?? null;
  installer = hooks?.installer ?? ensureLanInstalled;
  installedCheck = hooks?.installed ?? lanInstalled;
  platformCheck = hooks?.platformSupported ?? lanPlatformSupported;
  probeTiming = hooks?.probeTiming ?? DEFAULT_PROBE_TIMING;
  if (hooks === null) {
    runtime = null;
    shuttingDown = false;
    pendingSyncs = 0;
    devices = [];
    devicesReadAt = 0;
    queue = Promise.resolve();
  }
}

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const next = queue.then(job, job);
  queue = next.catch(() => undefined);
  return next;
}

// ---- 身份与设置 ----

/** 26 个 base32 字符，约 130 位：比实例网络的 64 位十六进制好输入，强度足够。 */
function generateSecret(): string {
  const bytes = crypto.randomBytes(26);
  return Array.from(bytes, (byte) => BASE32_ALPHABET[byte & 31]).join('');
}

function generateIdentity(): Pick<PanelNetworkSettings, 'networkName' | 'networkSecret'> {
  return { networkName: `mystry-panel-${crypto.randomBytes(16).toString('hex')}`, networkSecret: generateSecret() };
}

function readSettings(): PanelNetworkSettings | null {
  const row = getDb().prepare('SELECT value FROM panel_settings WHERE key = ?').get(SETTING_KEY) as
    | { value: string }
    | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as Partial<PanelNetworkSettings> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.networkName !== 'string' || !NETWORK_NAME_RE.test(parsed.networkName)) return null;
    if (typeof parsed.networkSecret !== 'string' || !NETWORK_SECRET_RE.test(parsed.networkSecret)) return null;
    const customPeers: string[] = [];
    for (const peer of Array.isArray(parsed.customPeers) ? parsed.customPeers.slice(0, LAN_CUSTOM_PEER_LIMIT) : []) {
      // 数据库被改过时丢掉不合法的节点，不让怪字符进配置文件。
      try {
        if (typeof peer === 'string' && normalizeLanPeer(peer) === peer) customPeers.push(peer);
      } catch {
        // 跳过
      }
    }
    const localPort = typeof parsed.localPort === 'number' && Number.isInteger(parsed.localPort)
      && parsed.localPort >= 1 && parsed.localPort <= 65535 ? parsed.localPort : null;
    return {
      enabled: parsed.enabled === true,
      networkName: parsed.networkName,
      networkSecret: parsed.networkSecret,
      useSharedPeers: parsed.useSharedPeers !== false,
      customPeers,
      localPort,
    };
  } catch {
    return null;
  }
}

function writeSettings(settings: PanelNetworkSettings): void {
  getDb().prepare(
    `INSERT INTO panel_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(SETTING_KEY, JSON.stringify(settings), new Date().toISOString());
}

function resolvePeers(settings: Pick<PanelNetworkSettings, 'customPeers' | 'useSharedPeers'>): string[] {
  const peers = [...settings.customPeers];
  if (settings.useSharedPeers) {
    for (const shared of LAN_SHARED_PEERS) {
      if (!peers.includes(shared)) peers.push(shared);
    }
  }
  if (peers.length === 0) throw new PanelError('server.panelNetwork.noPeers', undefined, { statusCode: 400 });
  return peers;
}

// ---- 配置文件 ----

export function panelNetworkWorkDir(): string {
  return path.join(config.dataDir, 'panel-network');
}

/**
 * 面板网络的 core.toml。密钥只在这个文件和数据库里，不进命令行。
 * tcp_whitelist 只有组网专用端口；udp_whitelist 留一个用不到的端口，等于全部不放行。
 */
export function renderPanelNetworkToml(input: PanelNetworkRenderInput): string {
  if (!NETWORK_NAME_RE.test(input.networkName) || !NETWORK_SECRET_RE.test(input.networkSecret)) {
    throw new PanelError('server.panelNetwork.invalidRequest');
  }
  const assertPort = (port: number): number => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new PanelError('server.panelNetwork.invalidRequest');
    return port;
  };
  const port = assertPort(input.accessPort);
  if (input.peers.length === 0) throw new PanelError('server.panelNetwork.noPeers');
  // 渲染前再校验一遍，即使数据库被改过也不会把怪字符写进配置。
  const peers = input.peers.map((peer) => {
    if (normalizeLanPeer(peer) !== peer) throw new PanelError('server.panelNetwork.invalidRequest');
    return peer;
  });
  const listeners = input.listenPort === null
    ? 'listeners = []'
    : `listeners = ["tcp://0.0.0.0:${assertPort(input.listenPort)}", "udp://0.0.0.0:${input.listenPort}"]`;
  return [
    '# Generated by Mystry Dashboard. Do not add proxies or port forwards.',
    'instance_name = "mystry-panel"',
    'hostname = "mystry-panel"',
    `ipv4 = "${PANEL_NETWORK_VIRTUAL_IP}"`,
    'dhcp = false',
    listeners,
    `tcp_whitelist = ["${port}"]`,
    'udp_whitelist = ["1"]',
    '',
    '[network_identity]',
    `network_name = "${input.networkName}"`,
    `network_secret = "${input.networkSecret}"`,
    '',
    '[flags]',
    'private_mode = true',
    'no_tun = true',
    'enable_exit_node = false',
    'enable_ipv6 = true',
    '',
    '[console_logger]',
    'level = "warn"',
    '',
    peers.map((uri) => `[[peer]]\nuri = "${uri}"`).join('\n\n'),
    '',
  ].join('\n');
}

// ---- 设备列表 ----

/**
 * 从 `easytier-cli -o json peer` 的输出取出已加入的设备。字段按 EasyTier 的对端表：
 * hostname、ipv4（或 cidr）、cost（Local / p2p / relay(n)）。认不出的结构返回空列表。
 */
export function parsePanelNetworkDevices(text: string): PanelNetworkDevice[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { result?: unknown } | null)?.result) ? (parsed as { result: unknown[] }).result : [];
  const found: PanelNetworkDevice[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const cost = typeof record.cost === 'string' ? record.cost : '';
    // 本机节点自己也在表里，不算设备。
    if (/local/i.test(cost)) continue;
    const rawIp = typeof record.ipv4 === 'string' && record.ipv4 ? record.ipv4 : typeof record.cidr === 'string' ? record.cidr : '';
    const ip = rawIp.split('/')[0] ?? '';
    const virtualIp = net.isIPv4(ip) ? ip : null;
    if (virtualIp === PANEL_NETWORK_VIRTUAL_IP) continue;
    const hostname = typeof record.hostname === 'string' ? record.hostname.replace(/[\u0000-\u001f]/g, '').slice(0, 64) : '';
    // 社区共享节点只负责发现和中转，没有虚拟地址，不是用户的设备。
    if (!virtualIp) continue;
    found.push({
      hostname,
      virtualIp,
      connection: /p2p|direct/i.test(cost) ? 'direct' : /relay/i.test(cost) ? 'relay' : 'unknown',
    });
    if (found.length >= DEVICE_LIMIT) break;
  }
  return found;
}

function runCli(rpcPort: number, command: string): Promise<string> {
  if (cliRunner) return cliRunner(rpcPort, command);
  return new Promise((resolve, reject) => {
    const child = spawn(lanCliPath(), ['--rpc-portal', `127.0.0.1:${rpcPort}`, '-o', 'json', command], {
      env: getMinecraftChildEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('easytier-cli timed out'));
    }, 3000);
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error('easytier-cli failed'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

function virtualIpFromCli(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { ipv4_addr?: unknown; result?: { ipv4_addr?: unknown } } | null;
    const value = parsed?.ipv4_addr ?? parsed?.result?.ipv4_addr;
    if (typeof value !== 'string') return null;
    const ip = value.split('/')[0] ?? '';
    return net.isIPv4(ip) ? ip : null;
  } catch {
    return null;
  }
}

/** 读状态前调用：运行中时刷新已加入的设备，几秒内不重复读。 */
export async function refreshPanelNetworkDevices(): Promise<void> {
  const current = runtime;
  if (!current || current.state !== 'running') {
    devices = [];
    return;
  }
  if (Date.now() - devicesReadAt < DEVICE_REFRESH_MS) return;
  devicesReadAt = Date.now();
  try {
    const parsed = parsePanelNetworkDevices(await runCli(current.rpcPort, 'peer'));
    if (runtime?.generation === current.generation) devices = parsed;
  } catch {
    // 读不到时保留上一次的结果
  }
}

// ---- 状态 ----

export function getPanelNetworkStatus(): PanelNetworkStatus {
  const settings = readSettings();
  const enabled = settings?.enabled === true;
  const platformSupported = platformCheck();
  let state: PanelNetworkState = 'stopped';
  if (enabled) state = runtime?.state ?? (pendingSyncs > 0 ? 'starting' : 'stopped');
  const running = enabled && state === 'running';
  let detail: PanelMessage | null = enabled ? runtime?.detail ?? null : null;
  if (!detail && enabled && !platformSupported) detail = { key: 'server.panelNetwork.unsupportedPlatform' };
  return {
    enabled,
    platformSupported,
    installed: platformSupported && installedCheck(),
    state,
    detail,
    virtualIp: running ? PANEL_NETWORK_VIRTUAL_IP : null,
    url: running && runtime?.access ? `http://${PANEL_NETWORK_VIRTUAL_IP}:${runtime.access.port}/` : null,
    devices: running ? devices : [],
    useSharedPeers: settings?.useSharedPeers ?? true,
    customPeers: settings?.customPeers ?? [],
    sharedPeers: [...LAN_SHARED_PEERS],
    firewall: enabled ? runtime?.firewall ?? null : null,
  };
}

// ---- 进程 ----

/** 在 127.0.0.1 上监听；端口被占用时返回 null。port 为 0 时由系统分配。 */
function listenAccess(port: number): Promise<AccessListener | null> {
  return new Promise((resolve) => {
    // 与 Node HTTP 服务的默认值一致，否则可能出现响应被截断或控制台输出延迟。
    const server = net.createServer({ allowHalfOpen: true, noDelay: true });
    const sockets = new Set<net.Socket>();
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.on('error', () => socket.destroy());
      // 先登记再交出去：之后这个连接上的请求都按组网设备处理。
      markPanelNetworkSocket(socket);
      if (handOff) handOff(socket);
      else socket.destroy();
    });
    const onError = (): void => {
      server.removeAllListeners();
      resolve(null);
    };
    server.once('error', onError);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.off('error', onError);
      server.on('error', () => undefined);
      resolve({ server, sockets, port: (server.address() as net.AddressInfo).port });
    });
  });
}

/** 首次分配时从面板端口往上试这么多个端口。 */
const ACCESS_PORT_SEARCH = 20;

/**
 * 优先沿用保存的专用端口。没有或被占用时，从面板端口 + 1 往上找空闲端口，都不行才让系统分配。
 * 不直接让系统分配：系统给的是动态端口段（Windows 49152 起），出站连接会随机占用，
 * 装了 WSL / Hyper-V 的电脑开机时还会保留其中一批，保存下来的端口下次启动容易绑不上、网址跟着变。
 */
async function openAccessListener(preferred: number | null): Promise<AccessListener> {
  if (preferred !== null && preferred !== panelPort) {
    const reused = await listenAccess(preferred);
    if (reused) return reused;
  }
  for (let port = panelPort + 1; port <= Math.min(panelPort + ACCESS_PORT_SEARCH, 65535); port += 1) {
    if (port === preferred) continue;
    const opened = await listenAccess(port);
    if (opened) return opened;
  }
  const fresh = await listenAccess(0);
  if (!fresh) throw new PanelError('server.panelNetwork.startFailed');
  return fresh;
}

/** 先停止监听、再断开已交给 HTTP 服务的连接：组网设备上的会话立即失效。 */
function closeAccessListener(listener: AccessListener): Promise<void> {
  return new Promise((resolve) => {
    listener.server.close(() => resolve());
    for (const socket of listener.sockets) socket.destroy();
  });
}

function corePathForFirewall(): string {
  const corePath = lanCorePath();
  try {
    return fs.realpathSync.native(corePath);
  } catch {
    return corePath;
  }
}

async function stop(): Promise<void> {
  const current = runtime;
  runtime = null;
  devices = [];
  devicesReadAt = 0;
  if (!current) return;
  const child = current.child;
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
        resolve();
      }, 2000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    child.kill();
    await exited;
  }
  if (current.access) await closeAccessListener(current.access);
  if (current.firewallOpened) await closePanelFirewall('panelNetwork', panelPort);
}

function fail(current: Runtime, detail: PanelMessage): void {
  current.state = 'error';
  current.detail = detail;
}

async function probe(generation: number, rpcPort: number): Promise<boolean> {
  if (runtime?.generation !== generation) return true;
  try {
    const reported = virtualIpFromCli(await runCli(rpcPort, 'node'));
    const current = runtime;
    if (!current || current.generation !== generation || current.state === 'error') return true;
    if (reported === PANEL_NETWORK_VIRTUAL_IP) {
      current.state = 'running';
      current.detail = null;
      return true;
    }
  } catch {
    // 客户端刚起来时管理端口可能还没打开
  }
  return false;
}

function watch(generation: number, rpcPort: number): void {
  void (async () => {
    for (let attempt = 1; ; attempt += 1) {
      const delay = attempt <= probeTiming.fastAttempts ? probeTiming.fastMs : probeTiming.slowMs;
      await new Promise((resolve) => setTimeout(resolve, delay));
      const current = runtime;
      if (!current || current.generation !== generation || !current.child || current.child.exitCode !== null || current.state === 'error') return;
      if (await probe(generation, rpcPort)) return;
    }
  })();
}

/** 按设置把进程调整到位：该开就装好并启动，该关就停掉。问题记在状态里，不抛错。 */
async function sync(): Promise<void> {
  const settings = readSettings();
  if (shuttingDown || !settings?.enabled || !platformCheck()) {
    await stop();
    return;
  }
  let peers: string[];
  try {
    peers = resolvePeers(settings);
  } catch (error) {
    await stop();
    runtime = errorRuntime(error);
    return;
  }
  // 还没分配过专用端口时一定要启动；分配过就用它判断设置有没有变。
  const configKey = settings.localPort === null
    ? null
    : renderPanelNetworkToml({ ...settings, accessPort: settings.localPort, peers, listenPort: null });
  const existing = runtime;
  if (configKey !== null && existing && existing.configKey === configKey && existing.child && existing.child.exitCode === null
    && (existing.state === 'running' || existing.state === 'starting')) {
    return;
  }
  await stop();
  const generation = ++nextGeneration;
  const current: Runtime = {
    state: 'installing',
    detail: null,
    child: null,
    generation,
    configKey: '',
    rpcPort: 0,
    firewall: null,
    firewallOpened: false,
    access: null,
  };
  runtime = current;
  try {
    // 第一次开启时还没安装：先下载钉死版本并校验。
    if (!installedCheck()) await installer();
    if (runtime !== current || shuttingDown) return;
    current.state = 'starting';
    // 专用端口先开好再启动 EasyTier，组网设备一连上就能用。
    const access = await openAccessListener(settings.localPort);
    if (runtime !== current || shuttingDown) {
      await closeAccessListener(access);
      return;
    }
    current.access = access;
    const accessPort = access.port;
    if (accessPort !== settings.localPort) {
      // 重新读一遍再写，只改端口，不覆盖期间用户改过的其他设置。
      const latest = readSettings();
      if (latest) writeSettings({ ...latest, localPort: accessPort });
      if (settings.localPort !== null) {
        log?.warn({ previous: settings.localPort, port: accessPort }, '面板自带网络的专用端口被占用，已换成新端口，组网设备要用新网址');
      }
    }
    current.configKey = renderPanelNetworkToml({ ...settings, accessPort, peers, listenPort: null });
    current.rpcPort = await allocateLoopbackPort();
    const listenPort = await allocateListenPort([current.rpcPort, panelPort, accessPort]);
    const workDir = panelNetworkWorkDir();
    ensureSecureDirectory(workDir);
    const tomlPath = path.join(workDir, 'core.toml');
    writeFileAtomic(tomlPath, renderPanelNetworkToml({ ...settings, accessPort, peers, listenPort }));
    forceSecureSensitiveFile(tomlPath);
    // EasyTier 会在 0.0.0.0 上开端口，Windows 会因此弹窗；规则限定它自己的程序路径和监听端口。
    current.firewall = await openPanelNetworkFirewall(corePathForFirewall(), listenPort, panelPort);
    current.firewallOpened = current.firewall === 'applied';
    if (runtime !== current || shuttingDown) {
      if (current.firewallOpened) await closePanelFirewall('panelNetwork', panelPort);
      return;
    }
    const child = spawner(lanCorePath(), lanCoreArgs(current.rpcPort), {
      cwd: workDir,
      env: getMinecraftChildEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    current.child = child;
    const consume = (chunk: Buffer): void => {
      if (runtime !== current) return;
      // 输出里可能带密钥：lanFailureDetail 遇到含密钥的行直接忽略，这里也不把原文写进日志。
      const detail = lanFailureDetail(chunk.toString('utf8'), settings.networkSecret);
      if (detail) fail(current, detail);
    };
    child.stdout?.on('data', consume);
    child.stderr?.on('data', consume);
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});
    child.on('error', () => {
      if (runtime !== current) return;
      fail(current, { key: 'server.panelNetwork.startFailed' });
      current.child = null;
    });
    child.on('exit', () => {
      if (runtime !== current) return;
      if (current.state !== 'error') current.detail = { key: 'server.panelNetwork.exited' };
      current.state = 'error';
      current.child = null;
      log?.warn({}, '面板自带的 EasyTier 已退出');
    });
    if (!await probe(generation, current.rpcPort)) watch(generation, current.rpcPort);
  } catch (error) {
    if (runtime !== current) return;
    const detail = errorRuntime(error).detail!;
    fail(current, detail);
  }
}

function errorRuntime(error: unknown): Runtime {
  return {
    state: 'error',
    detail: error instanceof PanelError ? error.toPanelMessage() : { key: 'server.panelNetwork.startFailed' },
    child: null,
    generation: ++nextGeneration,
    configKey: '',
    rpcPort: 0,
    firewall: null,
    firewallOpened: false,
    access: null,
  };
}

/** 排进队列在后台执行：下载和启动可能要一会儿，接口先返回，界面按状态轮询。 */
function scheduleSync(): Promise<void> {
  pendingSyncs += 1;
  return enqueue(sync).catch(() => undefined).finally(() => {
    pendingSyncs -= 1;
  });
}

/** 测试用：等后台的启动或停止做完。 */
export function waitForPanelNetworkIdle(): Promise<void> {
  return enqueue(async () => undefined);
}

// ---- 对外操作 ----

export function updatePanelNetwork(body: UpdatePanelNetworkRequest, sourceIp: string): PanelNetworkStatus {
  if (!platformCheck()) throw new PanelError('server.panelNetwork.unsupportedPlatform', undefined, { statusCode: 409 });
  const existing = readSettings();
  if ((body.customPeers?.length ?? 0) > LAN_CUSTOM_PEER_LIMIT) {
    throw new PanelError('server.panelNetwork.tooManyPeers', { max: LAN_CUSTOM_PEER_LIMIT }, { statusCode: 400 });
  }
  const next: PanelNetworkSettings = {
    ...(existing ?? { ...generateIdentity(), useSharedPeers: true, customPeers: [], localPort: null }),
    enabled: body.enabled,
  };
  if (body.customPeers !== undefined) next.customPeers = normalizeLanPeers(body.customPeers);
  if (body.useSharedPeers !== undefined) next.useSharedPeers = body.useSharedPeers;
  if (next.enabled) resolvePeers(next);
  writeSettings(next);
  // 不记网络名和密钥。
  log?.info({ enabled: next.enabled, sourceIp }, '面板自带网络的设置已更改');
  void scheduleSync();
  return getPanelNetworkStatus();
}

/** 手机加入要填的内容，含密钥；只在用户进到「让手机加入」那一步时请求。 */
export function getPanelNetworkJoinInfo(): PanelNetworkJoinInfo {
  const settings = readSettings();
  if (!settings?.enabled) throw new PanelError('server.panelNetwork.notEnabled', undefined, { statusCode: 409 });
  return {
    networkName: settings.networkName,
    networkSecret: settings.networkSecret,
    peers: resolvePeers(settings),
    easytierVersion: EASYTIER_VERSION,
    androidDownloadUrl: `https://github.com/EasyTier/EasyTier/releases/tag/v${EASYTIER_VERSION}`,
  };
}

/** 重置网络名和密钥：所有设备都要重新加入。 */
export function resetPanelNetworkSecret(sourceIp: string): PanelNetworkStatus {
  const settings = readSettings();
  if (!settings) throw new PanelError('server.panelNetwork.notEnabled', undefined, { statusCode: 409 });
  writeSettings({ ...settings, ...generateIdentity() });
  log?.info({ sourceIp }, '面板自带网络的网络名和密钥已重置');
  void scheduleSync();
  return getPanelNetworkStatus();
}

// ---- 生命周期 ----

export async function initPanelNetwork(options: {
  port: number;
  /** 把专用端口接到的连接交给面板的 HTTP 服务；没有时（只测进程管理的测试）直接断开 */
  handOff?: (socket: net.Socket) => void;
  log?: PanelNetworkLogger;
}): Promise<void> {
  panelPort = options.port;
  handOff = options.handOff ?? null;
  log = options.log ?? null;
  shuttingDown = false;
  // 上次面板异常退出可能留下规则；设置为开启时随后的启动会先删后加。
  if (readSettings()?.enabled) void scheduleSync();
}

export async function shutdownPanelNetwork(): Promise<void> {
  shuttingDown = true;
  await enqueue(stop);
}
