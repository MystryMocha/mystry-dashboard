import os from 'node:os';
import type { InstanceLocalNetwork, NetworkInterfaceKind, PanelNetworkInterface } from '@mystry/shared';
import { config } from '../config.js';
import { gamePortFromProperties, readServerProperties } from './config-service.js';
import { getPublicHost } from './public-host.js';

type InterfaceMap = NodeJS.Dict<os.NetworkInterfaceInfo[]>;

/** With server-ip set to one of these values, the game accepts connections on all of this computer's addresses. */
const OPEN_BINDS = new Set(['', '0.0.0.0', '*', '::', '::0']);
/** Maximum number of addresses returned; a computer with many virtual interfaces does not fill the page. */
const MAX_ADDRESSES = 6;
/** With server-ip set to one of these values, the game also accepts IPv6 connections; 0.0.0.0 accepts IPv4 only. */
const DUAL_STACK_BINDS = new Set(['', '*', '::', '::0']);
/** Maximum number of public IPv6 addresses returned; a system often has one stable address and several temporary ones at once. */
const MAX_IPV6_ADDRESSES = 3;

/** The subnets most common on home routers come first, so users can tell which one to send. */
function addressRank(address: string): number {
  if (address.startsWith('192.168.')) return 0;
  if (address.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2;
  return 3;
}

/** Interfaces created by VMs, containers, WSL and proxy software: a friend's computer cannot reach these addresses. */
const VIRTUAL_INTERFACE_RE = /vEthernet|WSL|Hyper-V|VMware|VirtualBox|vboxnet|docker|^br-|^veth|^virbr|Tailscale|ZeroTier|EasyTier|WireGuard|TAP-|^tun|^tap|^utun|Mihomo|Clash|Loopback/i;

/** Carrier-grade NAT (100.64.0.0/10, commonly used by virtual networking software) and the benchmarking range (198.18.0.0/15, commonly used by proxy software's virtual interfaces). */
function isOverlayAddress(address: string): boolean {
  const [first, second] = address.split('.').map(Number);
  return (first === 100 && second >= 64 && second <= 127) || (first === 198 && (second === 18 || second === 19));
}

/**
 * This computer's IPv4 addresses reachable from the same network: excluding loopback, link-local addresses from when no router address could be obtained,
 * and recognizable virtual interfaces. When everything is classified as virtual, fall back to the unfiltered result; listing too many is better than listing nothing.
 */
export function listLanAddresses(interfaces: InterfaceMap = os.networkInterfaces()): string[] {
  const physical = new Set<string>();
  const all = new Set<string>();
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue;
      all.add(entry.address);
      if (!VIRTUAL_INTERFACE_RE.test(name) && !isOverlayAddress(entry.address)) physical.add(entry.address);
    }
  }
  const found = physical.size > 0 ? physical : all;
  return [...found]
    .sort((left, right) => addressRank(left) - addressRank(right) || left.localeCompare(right, 'en', { numeric: true }))
    .slice(0, MAX_ADDRESSES);
}

// ---- Interface classification: used only for defaults, ordering and UI hints, never to forbid a choice ----

/** The virtual interface the panel creates for instance multiplayer (dev_name in lan-config.ts). */
const INSTANCE_NETWORK_INTERFACE_RE = /^mystry\d+$/i;
/** Virtual interfaces of proxy software in TUN mode. */
const PROXY_INTERFACE_RE = /Clash|Mihomo/i;
/** Interfaces of virtual networking software; on Linux tailscale0, zt* and wg* do not start with tun / tap and need to be matched separately. */
const OVERLAY_INTERFACE_RE = /Tailscale|ZeroTier|EasyTier|WireGuard|^zt|^wg\d/i;
/** VM, container and other tunnel interfaces. */
const VM_INTERFACE_RE = /vEthernet|WSL|Hyper-V|VMware|VirtualBox|vboxnet|docker|^br-|^veth|^virbr|TAP-|^tun|^tap|^utun|Loopback/i;

function ipv4Octets(address: string): number[] {
  return address.split('.').map(Number);
}

/** Carrier-grade NAT range 100.64.0.0/10, commonly used by virtual networking software. */
export function isCgnatAddress(address: string): boolean {
  const [first, second] = ipv4Octets(address);
  return first === 100 && second! >= 64 && second! <= 127;
}

function isPrivateIpv4(address: string): boolean {
  const [first, second] = ipv4Octets(address);
  return first === 10 || (first === 172 && second! >= 16 && second! <= 31) || (first === 192 && second === 168);
}

/**
 * Decides by interface name first, then by address: virtual networking software using public-range addresses has to be recognized by interface name, and must not be classified as public by address first.
 */
export function classifyNetworkInterface(name: string, address: string): NetworkInterfaceKind {
  const [first, second] = ipv4Octets(address);
  if (INSTANCE_NETWORK_INTERFACE_RE.test(name) || (first === 10 && second === 126)) return 'instanceNetwork';
  if (PROXY_INTERFACE_RE.test(name) || (first === 198 && (second === 18 || second === 19))) return 'proxy';
  if (OVERLAY_INTERFACE_RE.test(name) || isCgnatAddress(address)) return 'overlay';
  if (VM_INTERFACE_RE.test(name)) return 'virtual';
  return isPrivateIpv4(address) ? 'lan' : 'public';
}

/** All non-loopback IPv4 addresses on this computer with their classification, in the order the system gives them. */
export function listNetworkInterfaces(interfaces: InterfaceMap = os.networkInterfaces()): PanelNetworkInterface[] {
  const found: PanelNetworkInterface[] = [];
  const seen = new Set<string>();
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (entry.address.startsWith('169.254.') || entry.address.startsWith('127.')) continue;
      if (seen.has(entry.address)) continue;
      seen.add(entry.address);
      found.push({ name, address: entry.address, cidr: entry.cidr ?? null, kind: classifyNetworkInterface(name, entry.address) });
    }
  }
  return found;
}

/** Display order of URLs: LAN (192.168 → 10 → 172.16–31) → public address entered by the user → public addresses on interfaces → overlay → the rest. */
export function networkKindRank(kind: NetworkInterfaceKind | 'publicHost', address = ''): number {
  switch (kind) {
    case 'lan': return addressRank(address);
    case 'publicHost': return 4;
    case 'public': return 5;
    case 'overlay': return 6;
    case 'virtual': return 7;
    case 'proxy': return 8;
    default: return 9;
  }
}

/** Public unicast addresses 2000::/3, excluding 6to4 (2002::/16), Teredo (2001::/32) and the documentation range (2001:db8::/32). */
function isPublicIpv6(address: string): boolean {
  const groups = address.toLowerCase().split(':');
  const first = Number.parseInt(groups[0] || '0', 16);
  if (!Number.isInteger(first) || (first & 0xe000) !== 0x2000) return false;
  if (first === 0x2002) return false;
  const second = Number.parseInt(groups[1] || '0', 16);
  return !(first === 0x2001 && (second === 0 || second === 0xdb8));
}

/**
 * This computer's public IPv6 addresses. Those on virtual interfaces do not count, and there is no "better too many" fallback:
 * a wrong entry only makes a friend try once for nothing, so it is better not to list it.
 */
export function listPublicIpv6Addresses(interfaces: InterfaceMap = os.networkInterfaces()): string[] {
  const found = new Set<string>();
  for (const [name, entries] of Object.entries(interfaces)) {
    if (VIRTUAL_INTERFACE_RE.test(name)) continue;
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv6' || entry.internal) continue;
      if (isPublicIpv6(entry.address)) found.add(entry.address.toLowerCase());
    }
  }
  return [...found].slice(0, MAX_IPV6_ADDRESSES);
}

/** Gives the addresses and port needed for a direct connection, read-only: no config is changed and no process is started. */
export function describeLocalNetwork(
  instanceId: string,
  interfaces: InterfaceMap = os.networkInterfaces(),
): InstanceLocalNetwork {
  const publicHost = getPublicHost();
  const base = {
    publicHost,
    serverIpIsUnboundPublicHost: false,
    panelPort: config.port,
    platform: process.platform,
  };
  let properties: Record<string, string>;
  try {
    properties = readServerProperties(instanceId);
  } catch {
    return { ...base, port: null, addresses: [], publicIpv4: [], publicIpv6: [], serverIpBlocked: false };
  }
  const port = gamePortFromProperties(properties);
  // Split by interface classification: public addresses are listed separately, and the instance's own multiplayer interface does not count as a "same network" address.
  const kinds = new Map(listNetworkInterfaces(interfaces).map((entry) => [entry.address, entry.kind]));
  const listed = listLanAddresses(interfaces);
  const addresses = listed.filter((address) => kinds.get(address) !== 'public' && kinds.get(address) !== 'instanceNetwork');
  const publicIpv4 = listed.filter((address) => kinds.get(address) === 'public');
  const serverIp = (properties['server-ip'] ?? '').trim();
  if (OPEN_BINDS.has(serverIp)) {
    const publicIpv6 = DUAL_STACK_BINDS.has(serverIp) ? listPublicIpv6Addresses(interfaces) : [];
    return { ...base, port, addresses, publicIpv4, publicIpv6, serverIpBlocked: false };
  }
  // When server-ip is one of this machine's addresses, friends can connect only to that one; a public address on an interface (VPS) counts as normal too.
  if (addresses.includes(serverIp)) {
    return { ...base, port, addresses: [serverIp], publicIpv4: [], publicIpv6: [], serverIpBlocked: false };
  }
  if (publicIpv4.includes(serverIp)) {
    return { ...base, port, addresses: [], publicIpv4: [serverIp], publicIpv6: [], serverIpBlocked: false };
  }
  return {
    ...base,
    port,
    addresses: [],
    publicIpv4: [],
    publicIpv6: [],
    serverIpBlocked: true,
    // A cloud server's interface has no public IP, so the game server cannot bind to this address.
    serverIpIsUnboundPublicHost: publicHost !== null && serverIp.toLowerCase() === publicHost,
  };
}