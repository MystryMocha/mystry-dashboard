import net from 'node:net';
import { EASYTIER_VERSION, LAN_CUSTOM_PEER_LIMIT, type PanelMessage } from '@mystry/shared';
import { PanelError } from '../utils/errors.js';
import { resolveLanAsset } from './lan-runtime.js';

/**
 * Community shared peers, used for mutual discovery; when hole punching fails, traffic is also relayed through them. The content is encrypted with the network secret.
 * Checked on 2026-10-31: these three names resolve, and the community monitoring page at the time marked them as able to relay.
 * Masked addresses, rate-limited peers and changing residential IPs are not included. Community peers may go offline at any time,
 * so users can add their own peers per instance, or turn this group off and use only their own.
 */
export const LAN_SHARED_PEERS = [
  'tcp://225284.xyz:11010',
  'tcp://easytier.weiai.org.cn:11010',
  'udp://et.basd1.de:11010',
] as const;

const PEER_SCHEMES = new Set(['tcp', 'udp', 'ws', 'wss', 'quic']);
const PEER_PATTERN = /^([A-Za-z]+):\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})(\/?)$/;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const NETWORK_NAME = /^mystry-[0-9a-f]{32}$/;
const NETWORK_SECRET = /^[0-9a-f]{64}$/;

export interface LanIdentity {
  networkName: string;
  networkSecret: string;
  /** 10.126.<octet>.1, avoiding EasyTier's default of 126 so instance subnets on the same machine do not overlap. */
  octet: number;
}

export interface LanRenderInput extends LanIdentity {
  gamePort: number;
  /** The normalized, deduplicated peer list; the panel and friends use the same one. */
  peers: string[];
  /**
   * Listen port of the local EasyTier (same for TCP and UDP). With a listener, friends can connect directly over IPv6 or the same LAN,
   * without relying entirely on hole punching or relaying. null means no listener and is only used to build the config key for comparison.
   */
  listenPort: number | null;
}

/** The address on the virtual interface is not 127.0.0.1. When bound only to loopback or to one specific interface, friends cannot join. */
const OPEN_BINDS: Record<string, true> = {
  '': true,
  '0.0.0.0': true,
  '*': true,
  '::': true,
  '::0': true,
};

export function serverIpBlocksLan(serverIp: string | undefined): boolean {
  return !Object.prototype.hasOwnProperty.call(OPEN_BINDS, (serverIp ?? '').trim());
}

export function lanVirtualIp(octet: number): string {
  assertOctet(octet);
  return `10.126.${octet}.1`;
}

/**
 * Normalizes a user-entered peer to scheme://host:port. Only protocols EasyTier supports without an extra key are accepted;
 * the host must be a domain or IP, and no path (ws/wss may have a trailing /), whitespace or quotes are allowed, to prevent injection into the config or the friend's command line.
 */
export function normalizeLanPeer(raw: string): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const invalid = () => new PanelError('server.lan.peerInvalid', { peer: text.slice(0, 80) });
  const match = PEER_PATTERN.exec(text);
  if (!match) throw invalid();
  const scheme = match[1]!.toLowerCase();
  const rawHost = match[2]!;
  const port = Number(match[3]);
  const slash = match[4] ?? '';
  if (!PEER_SCHEMES.has(scheme)) throw invalid();
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw invalid();
  if (slash && scheme !== 'ws' && scheme !== 'wss') throw invalid();
  let host: string;
  if (rawHost.startsWith('[')) {
    const inner = rawHost.slice(1, -1);
    if (net.isIPv6(inner) !== true) throw invalid();
    host = `[${inner.toLowerCase()}]`;
  } else {
    host = rawHost.toLowerCase();
    if (net.isIPv4(host) !== true) {
      const labels = host.split('.');
      if (host.length > 253 || labels.some((label) => !HOST_LABEL.test(label))) throw invalid();
    }
  }
  return `${scheme}://${host}:${port}${slash}`;
}

/** Normalizes and deduplicates the user's peer list. Throws when it exceeds the limit or contains an invalid peer. */
export function normalizeLanPeers(raw: readonly string[]): string[] {
  if (raw.length > LAN_CUSTOM_PEER_LIMIT) throw new PanelError('server.lan.invalidParams');
  const result: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && item.trim().length === 0) continue;
    const peer = normalizeLanPeer(item);
    if (!result.includes(peer)) result.push(peer);
  }
  return result;
}

/** The peers actually used: the user's own first, then the community shared peers when wanted. There must be at least one, or the two sides cannot discover each other. */
export function resolveLanPeers(custom: readonly string[], useShared: boolean): string[] {
  const peers = [...custom];
  if (useShared) {
    for (const shared of LAN_SHARED_PEERS) {
      if (!peers.includes(shared)) peers.push(shared);
    }
  }
  if (peers.length === 0) throw new PanelError('server.lan.peersRequired');
  return peers;
}

export function lanCoreArgs(rpcPort: number): string[] {
  if (!Number.isInteger(rpcPort) || rpcPort < 1 || rpcPort > 65535) {
    throw new PanelError('server.lan.invalidParams');
  }
  return ['-c', 'core.toml', '--rpc-portal', `127.0.0.1:${rpcPort}`];
}

/**
 * The panel's own core.toml. The secret lives only in this file, never on the command line.
 * When the listener is 0.0.0.0, EasyTier automatically also listens on [::] on the same port under enable_ipv6 (on by default).
 */
export function renderLanToml(input: LanRenderInput): string {
  const identity = assertIdentity(input);
  const port = assertGamePort(input.gamePort);
  const peers = assertPeers(input.peers);
  const label = `mystry-${identity.octet}`;
  const listeners = input.listenPort === null
    ? 'listeners = []'
    : `listeners = ["tcp://0.0.0.0:${assertListenPort(input.listenPort)}", "udp://0.0.0.0:${input.listenPort}"]`;
  return [
    '# Generated by Mystry Dashboard. Do not add proxies or port forwards.',
    `instance_name = "${label}"`,
    `hostname = "${label}"`,
    `ipv4 = "${lanVirtualIp(identity.octet)}"`,
    'dhcp = false',
    listeners,
    `tcp_whitelist = ["${port}"]`,
    'udp_whitelist = ["1"]',
    '',
    '[network_identity]',
    `network_name = "${identity.networkName}"`,
    `network_secret = "${identity.networkSecret}"`,
    '',
    '[flags]',
    'private_mode = true',
    'no_tun = false',
    'enable_exit_node = false',
    'enable_ipv6 = true',
    `dev_name = "mystry${identity.octet}"`,
    '',
    '[console_logger]',
    'level = "warn"',
    '',
    peers.map((uri) => `[[peer]]\nuri = "${uri}"`).join('\n\n'),
    '',
  ].join('\n');
}

/** The command sent to friends. The whitelist keeps only one unused port, so their computers cannot be accessed by others on the same virtual network. */
export function renderFriendInstructions(input: LanRenderInput): string {
  const identity = assertIdentity(input);
  const port = assertGamePort(input.gamePort);
  const address = `${lanVirtualIp(identity.octet)}:${port}`;
  const peers = assertPeers(input.peers).map((uri) => `--peers ${uri}`).join(' ');
  const windows = resolveLanAsset('win32', 'x64');
  // EasyTier 2.6.4 takes no value for --no-listener and exits with code 2 on "--no-listener=true",
  // while --private-mode requires one, so the two forms differ on purpose.
  const command = [
    'easytier-core',
    '--dhcp',
    `--network-name "${identity.networkName}"`,
    `--network-secret "${identity.networkSecret}"`,
    '--no-listener',
    '--private-mode=true',
    '--tcp-whitelist 1',
    '--udp-whitelist 1',
    '--rpc-portal 0',
    peers,
  ].join(' ');
  return [
    '# Mystry Dashboard virtual LAN',
    `# Install EasyTier ${EASYTIER_VERSION} from https://github.com/EasyTier/EasyTier/releases/tag/v${EASYTIER_VERSION}`,
    '# If GitHub is slow or blocked, any mirror is fine as long as the file matches.',
    `# Windows x64: ${windows.archive}`,
    `# SHA-256: ${windows.sha256}`,
    '# Windows: run easytier-core.exe from an administrator terminal. Linux: run easytier-core as root.',
    '# Do not remove flags. Then add this Minecraft server:',
    `# ${address}`,
    '# This file contains the network secret. Anyone with it can join the virtual network.',
    '# Send it only to people you trust. It does not open the panel.',
    '# If a direct path fails, the relay nodes named below carry the encrypted traffic.',
    '',
    command,
    '',
  ].join('\n');
}

export function lanFailureDetail(line: string, secret: string): PanelMessage | null {
  if (secret.length > 0 && line.includes(secret)) return null;
  // "Failed to create adapter" is EasyTier's own wording, so it matches whatever language Windows uses; the OS text
  // next to it is localized (a Chinese system prints 拒绝访问 instead of "Access is denied"). The localized text and
  // 0x80070005 are not matched on purpose: EasyTier also prints them in a non-fatal firewall warning.
  if (/administrator|access is denied|requires elevation|operation not permitted|wintun|failed to create adapter/i.test(line)) {
    return { key: 'server.lan.needsAdmin' };
  }
  if (/address already in use|addrinuse|os error 10048|os error 98\b/i.test(line)) {
    return { key: 'server.lan.listenPortUnavailable' };
  }
  return null;
}

function assertIdentity(input: LanIdentity): LanIdentity {
  if (!NETWORK_NAME.test(input.networkName) || !NETWORK_SECRET.test(input.networkSecret)) {
    throw new PanelError('server.lan.invalidParams');
  }
  assertOctet(input.octet);
  return input;
}

/** Validates once more before rendering, so odd characters are not written into the config or the command even if the database has been tampered with. */
function assertPeers(peers: readonly string[]): string[] {
  if (peers.length === 0) throw new PanelError('server.lan.peersRequired');
  return peers.map((peer) => {
    if (normalizeLanPeer(peer) !== peer) throw new PanelError('server.lan.invalidParams');
    return peer;
  });
}

function assertOctet(octet: number): void {
  if (!Number.isInteger(octet) || octet < 1 || octet > 254 || octet === 126) {
    throw new PanelError('server.lan.invalidParams');
  }
}

function assertGamePort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new PanelError('server.lan.localPortInvalid');
  }
  return port;
}

function assertListenPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new PanelError('server.lan.invalidParams');
  }
  return port;
}
