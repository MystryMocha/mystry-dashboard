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
 * Access the panel from other devices. HOST and the main listener stay unchanged; when access is enabled, on each address to be opened
 * another net.Server listens on "address:panel port" and hands connections to Fastify's HTTP server.
 * - Direct access (direct): all interfaces by default, or a single chosen one;
 * - Installed virtual networking software (overlay): listens only on the chosen overlay interface.
 * One listener per address (not 0.0.0.0): the main listener already holds the same port on 127.0.0.1,
 * and a single interface and "same subnet only" have to be handled per address anyway.
 * For connections on the extra listeners, req.ip is the peer's real address, so the loopback-only launcher endpoints cannot be reached through here.
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
  /** Connections not yet handed to the HTTP server, or that this listener is responsible for dropping (including TLS-wrapped connections). */
  sockets: Set<net.Socket>;
}

interface ModeRuntime {
  problem: RemoteAccessProblem | null;
  firewall: RemoteAccessFirewall | null;
  /** Signature of the firewall parameters already applied; rules are re-added only when it changes. */
  firewallSignature: string | null;
  /** Addresses that could not be attached, with the reason. */
  addressProblems: Map<string, RemoteAccessProblem>;
}

interface RemoteAccessLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface RemoteAccessInitOptions {
  /** The HTTP server connections are handed to (Fastify's app.server). */
  httpServer: http.Server;
  /** Port used by the extra listeners; when omitted, the port httpServer actually listens on. */
  port?: number;
  log?: RemoteAccessLogger;
  /** For tests: replaces interface enumeration. */
  listInterfaces?: () => PanelNetworkInterface[];
  /** For tests: does not start the periodic re-enumeration. */
  disableTimer?: boolean;
  /** For tests: overrides the HOST check. */
  host?: string;
}

const SETTING_KEYS: Record<AccessMode, string> = {
  direct: 'remote_access.direct',
  overlay: 'remote_access.overlay',
};
const DEFAULT_SETTINGS: Record<AccessMode, AccessSettings> = {
  direct: { enabled: false, interfaceName: null, restrictToSubnet: false, https: true },
  // The virtual network is already encrypted, so by default no extra HTTPS layer is added, which avoids the browser warning.
  overlay: { enabled: false, interfaceName: null, restrictToSubnet: false, https: false },
};
/** Drop a connection that has sent no data, or has not finished the TLS handshake, this long after connecting. A manually constructed TLSSocket does not get tls.Server's handshake timeout. */
const FIRST_BYTE_TIMEOUT_MS = 10_000;
/** Addresses change (DHCP, switching Wi-Fi, plugging or unplugging a cable), so interfaces are re-enumerated periodically. */
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
/** Toggling, re-enumeration and shutdown all run through a queue, so listeners are not added and removed concurrently. */
let queue: Promise<unknown> = Promise.resolve();

function emptyRuntime(): ModeRuntime {
  return { problem: null, firewall: null, firewallSignature: null, addressProblems: new Map() };
}

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const next = queue.then(job, job);
  queue = next.catch(() => undefined);
  return next;
}

/** For tests: shortens the "drop when no data is sent" wait. */
export function setRemoteAccessTimeoutForTests(ms: number | null): void {
  firstByteTimeoutMs = ms ?? FIRST_BYTE_TIMEOUT_MS;
}

// ---- Addresses and subnets ----

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
 * With "same subnet only", the source subnet allowed for one interface:
 * overlay interfaces (100.64.0.0/10) often have a /32 mask, and using the interface subnet would block every peer, so the whole 100.64.0.0/10 is allowed;
 * for other /32 interfaces no subnet can be derived, so null is returned.
 */
export function allowedRangeFor(entry: Pick<PanelNetworkInterface, 'address' | 'cidr'>): Ipv4Range | null {
  if (isCgnatAddress(entry.address)) return rangeFromCidr('100.64.0.0/10');
  if (!entry.cidr) return null;
  const range = rangeFromCidr(entry.cidr);
  return range && range.mask !== 0xffffffff ? range : null;
}

/** Whether a source address is inside the subnet; the IPv4-mapped IPv6 form (::ffff:192.168.2.10) is unmapped first. */
export function isAllowedSource(remoteAddress: string | undefined, range: Ipv4Range): boolean {
  if (!remoteAddress) return false;
  const text = remoteAddress.toLowerCase().startsWith('::ffff:') ? remoteAddress.slice(7) : remoteAddress;
  const value = ipv4ToInt(text);
  return value !== null && ((value & range.mask) >>> 0) === range.base;
}

// ---- Settings ----

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
      // Missing fields take the defaults (direct access defaults to HTTPS on).
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

/** HOST is already a non-loopback address: the panel is exposed anyway, so the toggle is read-only. */
function managedByConfig(): boolean {
  return !isLoopbackHost(configuredHost());
}

// ---- Certificate ----

function certificateHosts(interfaces: readonly PanelNetworkInterface[]): string[] {
  const publicHost = getPublicHost();
  return [...interfaces.map((entry) => entry.address), ...(publicHost ? [publicHost] : [])];
}

/** Gets (generating when needed) the certificate and TLS context; throws certificateFailed on failure. */
function ensureSecureContext(interfaces: readonly PanelNetworkInterface[], forceRenew = false): tls.SecureContext {
  if (secureContext && certificate && !forceRenew) return secureContext;
  try {
    const loaded = loadOrCreatePanelCertificate(certificateHosts(interfaces), { forceRenew });
    const context = tls.createSecureContext({ cert: loaded.certPem, key: loaded.keyPem });
    certificate = loaded;
    secureContext = context;
    return context;
  } catch (error) {
    // The reason is only logged (without private key content); the UI offers "enable without encryption" as a way out.
    log?.warn({ reason: error instanceof Error ? error.message : String(error) }, '面板 HTTPS 证书生成或读取失败');
    throw new PanelError('server.remoteAccess.certificateFailed', undefined, { statusCode: 500, cause: error });
  }
}

// ---- Listeners ----

function sanitizeHostHeader(value: string | undefined, fallback: string): string {
  // Keep only characters valid in a hostname and port; everything else is dropped.
  const cleaned = (value ?? '').replace(/[^A-Za-z0-9.\-:[\]]/g, '');
  return cleaned || fallback;
}

/** A tiny HTTP server that only answers with a redirect: plaintext requests never reach the panel routes. No HSTS is sent. */
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
  // The source is checked only when "same subnet only" is on.
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
  // Dispatch on the first byte: 0x16 is a TLS handshake, anything else is treated as plaintext HTTP and gets the redirect.
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
    // Destroy the underlying connection on a TLS error (such as the browser aborting the handshake after rejecting the certificate).
    secure.on('error', () => {
      secure.destroy();
      socket.destroy();
    });
    secure.once('secure', () => {
      clearTimeout(timer);
      // Handed to the HTTP server only after the handshake completes; Fastify sets req.protocol to https based on socket.encrypted.
      httpServer?.emit('connection', secure);
    });
  };
  socket.once('readable', onReadable);
}

function openListener(mode: AccessMode, address: string, https: boolean, range: Ipv4Range | null): Promise<AccessListener | null> {
  return new Promise((resolve) => {
    // Same as the Node HTTP server's defaults; otherwise responses may be truncated or console output delayed.
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
      // Errors while running (such as the interface disappearing) are only recorded, and cleared at the next re-enumeration.
      server.on('error', () => undefined);
      resolve(listener);
    });
  });
}

/** Stops listening first, then drops its connections: close() only stops accepting new connections, and established long-lived connections have to be dropped explicitly. */
function closeListener(listener: AccessListener): Promise<void> {
  listeners.delete(listener.address);
  return new Promise((resolve) => {
    listener.server.close(() => resolve());
    // The set also includes connections already handed to the HTTP server: they are dropped as well, so sessions on those devices are invalidated immediately.
    for (const socket of listener.sockets) socket.destroy();
  });
}

async function closeMode(mode: AccessMode): Promise<void> {
  await Promise.all([...listeners.values()].filter((item) => item.mode === mode).map(closeListener));
}

// ---- Candidate addresses ----

interface Candidate {
  entry: PanelNetworkInterface;
  range: Ipv4Range | null;
  problem: RemoteAccessProblem | null;
}

/** Name of the interface taken by installed virtual networking software; "all interfaces" in direct access skips its addresses. */
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
    // All interfaces: excludes the instance multiplayer network (it only allows the game port, so a listener there would be unreachable anyway, and its address comes and goes with multiplayer).
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
 * Brings one mode's listeners in line with the settings and the current interfaces: new addresses are attached, vanished addresses are closed, and listeners whose settings changed are rebuilt.
 * Returns the number of addresses being listened on. Does not throw: problems are recorded in the runtime state.
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
  // Close listeners that are no longer needed or whose settings changed.
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
      // The address is being listened on by the other mode: the overlay mode takes over the interface it chose, and direct access yields to it.
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
  // Handle the overlay mode first: "all interfaces" in direct access has to give up the interface it occupies.
  for (const mode of ['overlay', 'direct'] as const) {
    const settings = readSettings(mode);
    await reconcileMode(mode, settings, interfaces);
    await applyFirewall(mode, settings);
  }
}

// ---- Status ----

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
      // Addresses taken by the other mode are still listed, with the protocol of whichever side actually listens on them.
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

/** When HOST is decided by the config file: lists the URL of each interface, and the toggle is read-only. */
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
    // HOST is a hostname, or an address not present on any interface: give it as is.
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

/** Interfaces are re-enumerated on every status read, attaching and closing along the way. */
export function getRemoteAccessStatus(): Promise<RemoteAccessStatus> {
  return enqueue(async () => {
    await reconcileAll();
    return snapshot(interfaceLister());
  });
}

// ---- Toggling ----

function assertChangeable(): void {
  if (managedByConfig()) throw new PanelError('server.remoteAccess.managedByConfig', undefined, { statusCode: 409 });
  if (!httpServer) throw new PanelError('server.remoteAccess.launcherUnavailable', undefined, { statusCode: 503 });
}

/**
 * Enables, disables or modifies one access mode. Any signed-in request may call it (whoever holds a sign-in token can already control the whole panel).
 * Order: adjust the listeners to the new settings first, and write the settings only once at least one address is attached; when none can be attached, restore the previous settings and throw.
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
      // A certificate failure is reported before any listener is touched, so the UI can switch to "enable without encryption".
      if (next.https) ensureSecureContext(interfaces);
    }
    writeSettings(mode, next);
    await reconcileAll();
    if (next.enabled && ![...listeners.values()].some((item) => item.mode === mode)) {
      const problem = runtimes[mode].problem;
      // Not a single address was attached: do not leave an "enabled" setting behind, restore the state from before the operation.
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
    // Log who toggled which mode; secrets, tokens and private keys are not logged.
    log?.info(
      { mode, enabled: next.enabled, interfaceName: next.interfaceName, https: next.https, restrictToSubnet: next.restrictToSubnet, sourceIp },
      '从其他设备访问的设置已更改',
    );
    return snapshot(interfaceLister());
  });
}

/** Regenerates the certificate; with HTTPS on, established connections are dropped and new connections use the new certificate right away. */
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

// ---- Lifecycle ----

/** Called after app.listen succeeds: attaches listeners according to the settings. A failure only records the reason and does not affect panel startup. */
export async function initRemoteAccess(options: RemoteAccessInitOptions): Promise<void> {
  httpServer = options.httpServer;
  const address = options.httpServer.address();
  panelPort = options.port ?? (address && typeof address === 'object' ? address.port : config.port);
  hostOverride = options.host ?? null;
  log = options.log ?? null;
  interfaceLister = options.listInterfaces ?? (() => listNetworkInterfaces());
  await enqueue(async () => {
    // Firewall rules are not swept by name: rule names are fixed machine-wide, and unconditional deletion would remove the rules of another panel on the same computer
    // (or of a test or temporary panel running next to the real one). A mode that is set to on deletes the old rule of the same name before adding anyway.
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
  // Connections accepted on the dedicated virtual-network port are handed to the same HTTP server, just like the extra listeners.
  await initPanelNetwork({ port: panelPort, handOff: (socket) => httpServer?.emit('connection', socket), log: options.log });
  if (!options.disableTimer) {
    rescanTimer = setInterval(() => {
      if (!readSettingsSafe('direct').enabled && !readSettingsSafe('overlay').enabled) return;
      void enqueue(reconcileAll).catch(() => undefined);
    }, RESCAN_INTERVAL_MS);
    rescanTimer.unref();
  }
}

/** The timer may fire after the database is closed; when settings cannot be read, treat it as not enabled. */
function readSettingsSafe(mode: AccessMode): AccessSettings {
  try {
    return readSettings(mode);
  } catch {
    return { ...DEFAULT_SETTINGS[mode] };
  }
}

/** Called when the panel shuts down (before waiting for HTTP connections to close): stops all listeners, drops connections and deletes firewall rules. */
export async function shutdownRemoteAccess(): Promise<void> {
  if (rescanTimer) clearInterval(rescanTimer);
  rescanTimer = null;
  await enqueue(async () => {
    await Promise.all([...listeners.values()].map(closeListener));
    redirectServer?.closeAllConnections();
    redirectServer = null;
    await shutdownPanelNetwork();
    for (const mode of ['direct', 'overlay'] as const) {
      // Only rules this process tried to add are deleted; a panel that never enabled this does not call netsh.
      if (runtimes[mode].firewallSignature !== null) await closePanelFirewall(mode, panelPort);
      runtimes[mode] = emptyRuntime();
    }
    httpServer = null;
    certificate = null;
    secureContext = null;
  });
}
