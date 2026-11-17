import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { PanelCertificateInfo } from '@mystry/shared';
import { config } from '../config.js';
import { writeFileAtomic } from '../utils/atomic-write.js';
import { ensureSecureDirectory, forceSecureSensitiveFile } from '../utils/data-dir-permissions.js';

/**
 * 面板的自签名 HTTPS 证书。Node 没有生成 X.509 证书的接口，这里按固定结构拼出最小的 DER 编码：
 * ECDSA P-256 + SHA-256，CN 为 Mystry Dashboard，SAN 写入网卡地址和用户填的公网地址，
 * 扩展密钥用途含 serverAuth，basicConstraints 为 CA:false，有效期 800 天。
 * 不调用系统的 openssl，不联网，不加依赖。私钥只写在 <数据根>/tls/panel.key，不进数据库和日志。
 */

export const CERTIFICATE_VALID_DAYS = 800;
/** 剩余有效期少于这个天数时重新生成。 */
export const CERTIFICATE_RENEW_BEFORE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** SAN 条目上限：网卡很多的电脑不会让证书无限变大。 */
const MAX_SAN_ENTRIES = 64;

export interface PanelCertificate {
  certPem: string;
  keyPem: string;
  info: PanelCertificateInfo;
}

// ---- DER 编码 ----

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const sequence = (...parts: Buffer[]) => der(0x30, ...parts);
const set = (...parts: Buffer[]) => der(0x31, ...parts);
const octetString = (value: Buffer) => der(0x04, value);
const bitString = (value: Buffer, unusedBits = 0) => der(0x03, Buffer.from([unusedBits]), value);
const utf8String = (value: string) => der(0x0c, Buffer.from(value, 'utf8'));
const boolTrue = () => der(0x01, Buffer.from([0xff]));

/** 非负整数：最高位为 1 时前面补 0，去掉多余的前导 0。 */
function integer(value: Buffer): Buffer {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start += 1;
  const trimmed = value.subarray(start);
  return der(0x02, (trimmed[0]! & 0x80) !== 0 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
}

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const bytes: number[] = [parts[0]! * 40 + parts[1]!];
  for (const part of parts.slice(2)) {
    const chunk = [part & 0x7f];
    for (let rest = part >>> 7; rest > 0; rest >>>= 7) chunk.unshift((rest & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}

/** UTCTime 只能表示到 2049 年，之后用 GeneralizedTime（RFC 5280 4.1.2.5）。 */
function time(date: Date): Buffer {
  const pad = (value: number) => String(value).padStart(2, '0');
  const rest = `${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}`
    + `${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  const year = date.getUTCFullYear();
  return year < 2050
    ? der(0x17, Buffer.from(`${pad(year % 100)}${rest}`, 'ascii'))
    : der(0x18, Buffer.from(`${year}${rest}`, 'ascii'));
}

const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const OID_COMMON_NAME = '2.5.4.3';
const OID_SUBJECT_KEY_ID = '2.5.29.14';
const OID_KEY_USAGE = '2.5.29.15';
const OID_SUBJECT_ALT_NAME = '2.5.29.17';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_EXT_KEY_USAGE = '2.5.29.37';
const OID_SERVER_AUTH = '1.3.6.1.5.5.7.3.1';

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return sequence(oid(id), ...(critical ? [boolTrue()] : []), octetString(value));
}

// ---- SAN ----

function ipv4Bytes(address: string): Buffer {
  return Buffer.from(address.split('.').map(Number));
}

/** 把 IPv6 文本展开成 16 字节；带区域标识（%eth0）或写法不合法时返回 null。 */
function ipv6Bytes(address: string): Buffer | null {
  if (address.includes('%') || net.isIPv6(address) === false) return null;
  let text = address;
  // 末尾内嵌的 IPv4（如 ::ffff:192.168.1.2）先换成两组十六进制。
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4Bytes(tail);
    text = `${text.slice(0, lastColon + 1)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const [head, rest] = text.split('::') as [string, string | undefined];
  const headGroups = head ? head.split(':') : [];
  const restGroups = rest ? rest.split(':') : [];
  const missing = 8 - headGroups.length - restGroups.length;
  if (rest === undefined ? missing !== 0 : missing < 0) return null;
  const groups = [...headGroups, ...Array<string>(rest === undefined ? 0 : missing).fill('0'), ...restGroups];
  const bytes = Buffer.alloc(16);
  groups.forEach((group, index) => bytes.writeUInt16BE(Number.parseInt(group, 16), index * 2));
  return bytes;
}

const DNS_NAME_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/** 一个 SAN 条目的 GeneralName 编码；认不出的值返回 null（跳过，不让整张证书失败）。 */
function generalName(host: string): Buffer | null {
  if (net.isIPv4(host)) return der(0x87, ipv4Bytes(host));
  if (net.isIPv6(host)) {
    const bytes = ipv6Bytes(host);
    return bytes ? der(0x87, bytes) : null;
  }
  return DNS_NAME_RE.test(host) ? der(0x82, Buffer.from(host.toLowerCase(), 'ascii')) : null;
}

/** 去重、去掉认不出的值；一个都没有时写入 localhost，SAN 不能为空。 */
export function normalizeCertificateHosts(hosts: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const raw of hosts) {
    const host = raw.trim().toLowerCase();
    if (host && generalName(host)) seen.add(host);
    if (seen.size >= MAX_SAN_ENTRIES) break;
  }
  return seen.size > 0 ? [...seen] : ['localhost'];
}

// ---- 生成与读取 ----

export function generatePanelCertificate(hosts: readonly string[], now = new Date()): { certPem: string; keyPem: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  // 序列号：16 字节随机数，最高位清零保证为正。
  const serial = crypto.randomBytes(16);
  serial[0] = (serial[0]! & 0x7f) | 0x01;
  const signatureAlgorithm = sequence(oid(OID_ECDSA_SHA256));
  const name = sequence(set(sequence(oid(OID_COMMON_NAME), utf8String('Mystry Dashboard'))));
  // 起始时间往前拨一小时，容忍设备之间的时钟误差。
  const notBefore = new Date(Math.floor(now.getTime() / 1000) * 1000 - 60 * 60 * 1000);
  const notAfter = new Date(Math.floor(now.getTime() / 1000) * 1000 + CERTIFICATE_VALID_DAYS * DAY_MS);
  const names = normalizeCertificateHosts(hosts).map((host) => generalName(host)!);
  const extensions = sequence(
    // CA:false：空 SEQUENCE，cA 取默认值 FALSE。
    extension(OID_BASIC_CONSTRAINTS, true, sequence()),
    // digitalSignature（第 0 位），ECDHE 握手只需要它。
    extension(OID_KEY_USAGE, true, bitString(Buffer.from([0x80]), 7)),
    extension(OID_EXT_KEY_USAGE, false, sequence(oid(OID_SERVER_AUTH))),
    extension(OID_SUBJECT_KEY_ID, false, octetString(crypto.createHash('sha1').update(spki).digest())),
    extension(OID_SUBJECT_ALT_NAME, false, sequence(...names)),
  );
  const tbs = sequence(
    der(0xa0, integer(Buffer.from([2]))), // v3
    integer(serial),
    signatureAlgorithm,
    name,
    sequence(time(notBefore), time(notAfter)),
    name,
    spki,
    der(0xa3, extensions),
  );
  const signature = crypto.sign('sha256', tbs, privateKey);
  const certificate = sequence(tbs, signatureAlgorithm, bitString(signature));
  const body = certificate.toString('base64').replace(/(.{64})/g, '$1\n').trimEnd();
  return {
    certPem: `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`,
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  };
}

/** 从 subjectAltName 文本（如 "IP Address:192.168.1.2, DNS:mc.example.com"）取出地址和域名。 */
function parseSubjectAltName(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .map((entry) => /^(?:IP Address|DNS):(.+)$/.exec(entry)?.[1]?.trim() ?? '')
    .filter(Boolean);
}

export function describeCertificate(certPem: string): PanelCertificateInfo {
  const x509 = new crypto.X509Certificate(certPem);
  return {
    fingerprint256: x509.fingerprint256,
    notAfter: new Date(x509.validTo).toISOString(),
    addresses: parseSubjectAltName(x509.subjectAltName),
  };
}

export function panelCertificatePaths(dataDir = config.dataDir): { dir: string; key: string; cert: string } {
  const dir = path.join(dataDir, 'tls');
  return { dir, key: path.join(dir, 'panel.key'), cert: path.join(dir, 'panel.crt') };
}

/** 读出磁盘上的证书；缺失、读不出、私钥不匹配、已过期或快过期时返回 null。 */
function readUsableCertificate(paths: { key: string; cert: string }, now: Date): PanelCertificate | null {
  try {
    const certPem = fs.readFileSync(paths.cert, 'utf8');
    const keyPem = fs.readFileSync(paths.key, 'utf8');
    const x509 = new crypto.X509Certificate(certPem);
    if (!x509.checkPrivateKey(crypto.createPrivateKey(keyPem))) return null;
    const notAfter = new Date(x509.validTo).getTime();
    if (!Number.isFinite(notAfter) || notAfter - now.getTime() < CERTIFICATE_RENEW_BEFORE_DAYS * DAY_MS) return null;
    return { certPem, keyPem, info: describeCertificate(certPem) };
  } catch {
    return null;
  }
}

/** 只读：给状态接口显示指纹和有效期，不生成。 */
export function readPanelCertificateInfo(dataDir = config.dataDir): PanelCertificateInfo | null {
  try {
    return describeCertificate(fs.readFileSync(panelCertificatePaths(dataDir).cert, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 取得面板证书：能用就复用（指纹不变，浏览器不用重新确认），否则在本机重新生成。
 * hosts 只在生成时写入 SAN；已有证书不因地址变化而重新生成。
 */
export function loadOrCreatePanelCertificate(
  hosts: readonly string[],
  options: { forceRenew?: boolean; now?: Date; dataDir?: string } = {},
): PanelCertificate {
  const now = options.now ?? new Date();
  const paths = panelCertificatePaths(options.dataDir);
  if (!options.forceRenew) {
    const existing = readUsableCertificate(paths, now);
    if (existing) return existing;
  }
  const generated = generatePanelCertificate(hosts, now);
  ensureSecureDirectory(paths.dir);
  // 先写私钥再写证书：中途失败时留下的是「没有证书」，下次会整对重新生成。
  writeFileAtomic(paths.key, generated.keyPem);
  forceSecureSensitiveFile(paths.key);
  writeFileAtomic(paths.cert, generated.certPem);
  return { ...generated, info: describeCertificate(generated.certPem) };
}
