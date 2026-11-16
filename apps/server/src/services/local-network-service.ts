import os from 'node:os';
import type { InstanceLocalNetwork } from '@mystry/shared';
import { readServerProperties } from './config-service.js';

type InterfaceMap = NodeJS.Dict<os.NetworkInterfaceInfo[]>;

/** server-ip 取这些值时，游戏在这台电脑的所有地址上都接受连接。 */
const OPEN_BINDS = new Set(['', '0.0.0.0', '*', '::', '::0']);
/** 最多返回的地址数；装了很多虚拟网卡的电脑不会把页面撑满。 */
const MAX_ADDRESSES = 6;
/** server-ip 取这些值时，游戏同时接受 IPv6 连接；0.0.0.0 只接受 IPv4。 */
const DUAL_STACK_BINDS = new Set(['', '*', '::', '::0']);
/** 最多返回的公网 IPv6 地址数；系统常同时有一个固定地址和几个临时地址。 */
const MAX_IPV6_ADDRESSES = 3;

/** 家用路由器最常见的网段排前面，方便用户认出该发哪一个。 */
function addressRank(address: string): number {
  if (address.startsWith('192.168.')) return 0;
  if (address.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2;
  return 3;
}

/** 虚拟机、容器、WSL 和代理软件建的网卡：朋友的电脑到不了这些地址。 */
const VIRTUAL_INTERFACE_RE = /vEthernet|WSL|Hyper-V|VMware|VirtualBox|vboxnet|docker|^br-|^veth|^virbr|Tailscale|ZeroTier|EasyTier|WireGuard|TAP-|^tun|^tap|^utun|Mihomo|Clash|Loopback/i;

/** 运营商级 NAT（100.64.0.0/10，组网软件常用）和测试网段（198.18.0.0/15，代理软件的虚拟网卡常用）。 */
function isOverlayAddress(address: string): boolean {
  const [first, second] = address.split('.').map(Number);
  return (first === 100 && second >= 64 && second <= 127) || (first === 198 && (second === 18 || second === 19));
}

/**
 * 这台电脑可供同一网络访问的 IPv4 地址：去掉回环、拿不到路由器地址时的链路本地地址，
 * 以及能认出的虚拟网卡。全被当成虚拟网卡时退回不过滤的结果，宁可多列也不留空。
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

/** 公网单播地址 2000::/3，去掉 6to4（2002::/16）、Teredo（2001::/32）和文档示例段（2001:db8::/32）。 */
function isPublicIpv6(address: string): boolean {
  const groups = address.toLowerCase().split(':');
  const first = Number.parseInt(groups[0] || '0', 16);
  if (!Number.isInteger(first) || (first & 0xe000) !== 0x2000) return false;
  if (first === 0x2002) return false;
  const second = Number.parseInt(groups[1] || '0', 16);
  return !(first === 0x2001 && (second === 0 || second === 0xdb8));
}

/**
 * 这台电脑的公网 IPv6 地址。虚拟网卡上的不算，也不做「宁可多列」的回退：
 * 列错了朋友只会白试一次，不如不列。
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

/** 只读地给出直连要用的地址和端口，不改任何配置，也不启动进程。 */
export function describeLocalNetwork(
  instanceId: string,
  interfaces: InterfaceMap = os.networkInterfaces(),
): InstanceLocalNetwork {
  let properties: Record<string, string>;
  try {
    properties = readServerProperties(instanceId);
  } catch {
    return { port: null, addresses: [], publicIpv6: [], serverIpBlocked: false };
  }
  const parsedPort = Number((properties['server-port'] ?? '25565').trim());
  const port = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535 ? parsedPort : null;
  const addresses = listLanAddresses(interfaces);
  const serverIp = (properties['server-ip'] ?? '').trim();
  if (OPEN_BINDS.has(serverIp)) {
    const publicIpv6 = DUAL_STACK_BINDS.has(serverIp) ? listPublicIpv6Addresses(interfaces) : [];
    return { port, addresses, publicIpv6, serverIpBlocked: false };
  }
  // server-ip 写的是本机某个局域网地址时，朋友只能连这一个。
  if (addresses.includes(serverIp)) return { port, addresses: [serverIp], publicIpv6: [], serverIpBlocked: false };
  return { port, addresses: [], publicIpv6: [], serverIpBlocked: true };
}
