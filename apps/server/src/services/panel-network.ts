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
 * The panel's built-in EasyTier network: only for opening the panel from your own phone and computers. It and the instance multiplayer network
 * are two independent networks with different network names, secrets and address ranges.
 * It runs in no-TUN mode: no virtual interface is created and no admin rights are needed; when another device accesses "virtual address:port",
 * the connection lands on the same port of 127.0.0.1 on this machine, and its source is also 127.0.0.1 (verified on 2.6.4).
 * To keep these apart from this machine's own connections, the panel opens another port on 127.0.0.1 used only for the virtual network (the dedicated port);
 * the whitelist allows only it and not the panel port. Connections accepted on the dedicated port are registered first (request-origin.ts) and then handed to the same HTTP server,
 * so the launcher endpoints and process fingerprint are not exposed to the virtual network, and rate limiting and failed sign-in counting are not shared with this machine.
 * The dedicated port is stored in settings and reused on every start, so URLs saved on virtual-network devices do not change; it only changes when another program occupies it.
 * tcp_whitelist allows only the dedicated port, and that is the only line of defense: without it, every program on this computer that listens on localhost only would be exposed to the virtual network.
 * When upgrading the EasyTier version, it must be re-verified that the whitelist still takes effect in no-TUN mode.
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
  /** Dedicated virtual-network port; null when it has never been enabled */
  localPort: number | null;
}

export interface PanelNetworkRenderInput {
  networkName: string;
  networkSecret: string;
  /** The only port the whitelist allows: the dedicated virtual-network port */
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

/** Listener on the dedicated virtual-network port: binds 127.0.0.1 only; connections are registered and then handed to the panel's HTTP server. */
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

/** For tests: replaces process spawning, CLI reads and installation; pass null to restore the defaults and clear the runtime state. */
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

// ---- Identity and settings ----

/** 26 base32 characters, about 130 bits: easier to type than the instance network's 64 hex characters, and strong enough. */
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
      // When the database has been tampered with, drop invalid peers so odd characters do not get into the config file.
      try {
        if (typeof peer === 'string' && normalizeLanPeer(peer) === peer) customPeers.push(peer);
      } catch {
        // Skip
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

// ---- Config file ----

export function panelNetworkWorkDir(): string {
  return path.join(config.dataDir, 'panel-network');
}

/**
 * core.toml of the panel network. The secret lives only in this file and the database, never on the command line.
 * tcp_whitelist contains only the dedicated virtual-network port; udp_whitelist keeps one unused port, which amounts to allowing nothing.
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
  // Validate once more before rendering, so odd characters are not written into the config even if the database has been tampered with.
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

// ---- Device list ----

/**
 * Extracts joined devices from the output of `easytier-cli -o json peer`. Fields follow EasyTier's peer table:
 * hostname, ipv4 (or cidr), cost (Local / p2p / relay(n)). An unrecognized structure returns an empty list.
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
    // The local peer itself is in the table too and does not count as a device.
    if (/local/i.test(cost)) continue;
    const rawIp = typeof record.ipv4 === 'string' && record.ipv4 ? record.ipv4 : typeof record.cidr === 'string' ? record.cidr : '';
    const ip = rawIp.split('/')[0] ?? '';
    const virtualIp = net.isIPv4(ip) ? ip : null;
    if (virtualIp === PANEL_NETWORK_VIRTUAL_IP) continue;
    const hostname = typeof record.hostname === 'string' ? record.hostname.replace(/[\u0000-\u001f]/g, '').slice(0, 64) : '';
    // Community shared peers only handle discovery and relaying; they have no virtual address and are not the user's devices.
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

/** Called before reading the status: refreshes the joined devices while running, without re-reading within a few seconds. */
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
    // Keep the previous result when it cannot be read
  }
}

// ---- Status ----

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

// ---- Process ----

/** Listens on 127.0.0.1; returns null when the port is in use. With port 0 the system assigns one. */
function listenAccess(port: number): Promise<AccessListener | null> {
  return new Promise((resolve) => {
    // Same as the Node HTTP server's defaults; otherwise responses may be truncated or console output delayed.
    const server = net.createServer({ allowHalfOpen: true, noDelay: true });
    const sockets = new Set<net.Socket>();
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.on('error', () => socket.destroy());
      // Register before handing over: from then on, requests on this connection are treated as coming from a virtual-network device.
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

/** On first allocation, try this many ports upward from the panel port. */
const ACCESS_PORT_SEARCH = 20;

/**
 * Prefers the saved dedicated port. When there is none or it is in use, looks for a free port upward from panel port + 1, and lets the system assign one only when all of those fail.
 * System assignment is not used directly: the system hands out ports from the dynamic range (from 49152 on Windows), which outbound connections occupy at random,
 * and computers with WSL / Hyper-V also reserve a batch of them at boot, so a saved port could easily fail to bind on the next start and the URL would change with it.
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

/** Stops listening first, then drops connections already handed to the HTTP server: sessions on virtual-network devices are invalidated immediately. */
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
    // The management port may not be open yet right after the client starts
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

/** Brings the process in line with the settings: installs and starts it when it should be on, stops it when it should be off. Problems are recorded in the status, not thrown. */
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
  // It must start when no dedicated port has been allocated yet; once allocated, the port is used to tell whether the settings changed.
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
    // Not installed yet on first enable: download the pinned version and verify it first.
    if (!installedCheck()) await installer();
    if (runtime !== current || shuttingDown) return;
    current.state = 'starting';
    // Open the dedicated port before starting EasyTier, so virtual-network devices can use it as soon as they connect.
    const access = await openAccessListener(settings.localPort);
    if (runtime !== current || shuttingDown) {
      await closeAccessListener(access);
      return;
    }
    current.access = access;
    const accessPort = access.port;
    if (accessPort !== settings.localPort) {
      // Read again before writing and change only the port, so other settings the user changed meanwhile are not overwritten.
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
    // EasyTier opens ports on 0.0.0.0, which makes Windows show a prompt; the rule is restricted to its own program path and listen port.
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
      // The output may contain the secret: lanFailureDetail ignores lines containing it, and the raw text is not written to logs here either.
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

/** Queued to run in the background: download and startup may take a while, so the endpoint returns first and the UI polls the status. */
function scheduleSync(): Promise<void> {
  pendingSyncs += 1;
  return enqueue(sync).catch(() => undefined).finally(() => {
    pendingSyncs -= 1;
  });
}

/** For tests: waits for the background start or stop to finish. */
export function waitForPanelNetworkIdle(): Promise<void> {
  return enqueue(async () => undefined);
}

// ---- Public operations ----

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
  // The network name and secret are not logged.
  log?.info({ enabled: next.enabled, sourceIp }, '面板自带网络的设置已更改');
  void scheduleSync();
  return getPanelNetworkStatus();
}

/** What to enter on a phone to join, including the secret; requested only when the user reaches the "join from a phone" step. */
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

/** Resets the network name and secret: every device has to join again. */
export function resetPanelNetworkSecret(sourceIp: string): PanelNetworkStatus {
  const settings = readSettings();
  if (!settings) throw new PanelError('server.panelNetwork.notEnabled', undefined, { statusCode: 409 });
  writeSettings({ ...settings, ...generateIdentity() });
  log?.info({ sourceIp }, '面板自带网络的网络名和密钥已重置');
  void scheduleSync();
  return getPanelNetworkStatus();
}

// ---- Lifecycle ----

export async function initPanelNetwork(options: {
  port: number;
  /** Hands connections accepted on the dedicated port to the panel's HTTP server; when there is none (tests that only cover process management) they are dropped */
  handOff?: (socket: net.Socket) => void;
  log?: PanelNetworkLogger;
}): Promise<void> {
  panelPort = options.port;
  handOff = options.handOff ?? null;
  log = options.log ?? null;
  shuttingDown = false;
  // A previous panel crash may have left rules behind; when the setting is on, the start that follows deletes before adding.
  if (readSettings()?.enabled) void scheduleSync();
}

export async function shutdownPanelNetwork(): Promise<void> {
  shuttingDown = true;
  await enqueue(stop);
}
