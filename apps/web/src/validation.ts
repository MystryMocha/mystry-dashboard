import type { MessageKey, MessageParams } from './i18n';

/**
 * 表单本地校验：主按钮在信息不完整或明显不合法时不可点，并说明缺什么。
 * 规则与服务端保持一致（服务端仍会再校验一次），这里只负责提前拦住和给出说明。
 */
export interface Issue {
  key: MessageKey;
  params?: MessageParams;
}

/** 与服务端实例名称 schema 一致：去掉首尾空格后不能为空，最多 128 个字符。 */
export const INSTANCE_NAME_MAX = 128;

/** 按 Unicode 码点计数，与服务端 JSON Schema 的 maxLength 一致（emoji 算 1 个）。 */
export function charCount(value: string): number {
  return [...value].length;
}

export function instanceNameIssue(name: string): Issue | null {
  if (name.trim() === '') return { key: 'validation.instanceName.required' };
  if (charCount(name) > INSTANCE_NAME_MAX) return { key: 'validation.instanceName.tooLong', params: { max: INSTANCE_NAME_MAX } };
  return null;
}

/** 解析整数输入：空串返回 null，不是整数返回 NaN。 */
export function parseIntegerInput(value: string): number | null {
  const text = value.trim();
  if (text === '') return null;
  return /^-?\d+$/.test(text) ? Number(text) : Number.NaN;
}

/** 整数范围校验；max 省略表示只限下限。允许留空时空串不算错误。 */
export function integerIssue(value: string, min: number, max?: number, allowEmpty = false): Issue | null {
  const parsed = parseIntegerInput(value);
  if (parsed === null) {
    if (allowEmpty) return null;
    return max == null ? { key: 'validation.number.min', params: { min } } : { key: 'validation.number.range', params: { min, max } };
  }
  if (Number.isNaN(parsed) || parsed < min || (max != null && parsed > max)) {
    return max == null ? { key: 'validation.number.min', params: { min } } : { key: 'validation.number.range', params: { min, max } };
  }
  return null;
}

export function portIssue(value: string, allowEmpty = false): Issue | null {
  return integerIssue(value, 1, 65535, allowEmpty) ? { key: 'validation.port.range' } : null;
}

/** UTF-8 字节数，用于 bcrypt 的 72 字节上限。 */
export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

// 与服务端管理员密码规则一致：12–128 个字符，且不超过 bcrypt 实际使用的 72 字节（约 24 个汉字）。
export const PASSWORD_MIN = 12;
const PASSWORD_MAX = 128;
const PASSWORD_MAX_BYTES = 72;

/** 新密码已经填了但不合规时返回原因；空密码只让按钮不可点，不提前报错。 */
export function newPasswordIssue(password: string): Issue | null {
  if (password === '') return null;
  if (password.length < PASSWORD_MIN) return { key: 'server.auth.passwordTooShort', params: { min: PASSWORD_MIN } };
  if (password.length > PASSWORD_MAX) return { key: 'server.auth.passwordTooLong', params: { max: PASSWORD_MAX } };
  if (utf8Length(password) > PASSWORD_MAX_BYTES) return { key: 'server.auth.passwordTooManyBytes', params: { max: PASSWORD_MAX_BYTES } };
  return null;
}

/** 初始化令牌固定 64 个字符（配置文件里的 64 位十六进制值）。 */
export const SETUP_TOKEN_LENGTH = 64;

/** 初始化令牌已经填了但长度不对时说明现在有几个字符；空令牌只让按钮不可点，不提前报错。 */
export function setupTokenIssue(token: string): Issue | null {
  if (token === '' || token.length === SETUP_TOKEN_LENGTH) return null;
  return { key: 'login.form.setupTokenLength', params: { max: SETUP_TOKEN_LENGTH, count: token.length } };
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function isHostname(host: string): boolean {
  return host.length <= 253 && host.split('.').every((label) => HOST_LABEL.test(label));
}

/** frp 服务器地址：与服务端 assertFrpHost 一致，只接受 IPv4 或主机名，不带协议、端口和路径。空串返回 null，由调用方按必填处理。 */
export function frpHostIssue(value: string): Issue | null {
  const host = value.trim();
  if (host === '') return null;
  if (/[\s/\x5c?#@:[\]"']/.test(host) || host.includes('{{') || host.includes('}}')) return { key: 'server.frp.hostInvalid' };
  return IPV4.test(host) || isHostname(host) ? null : { key: 'server.frp.hostInvalid' };
}

/** frp 令牌：与服务端一致，最多 256 个字符，不能含控制字符或模板标记。 */
export function frpTokenIssue(value: string): Issue | null {
  if (value === '') return null;
  return value.length > 256 || /[\u0000-\u001f\u007f]/.test(value) || value.includes('{{') || value.includes('}}')
    ? { key: 'server.frp.tokenInvalid' }
    : null;
}

const PEER_SCHEMES = new Set(['tcp', 'udp', 'ws', 'wss', 'quic']);
const PEER_PATTERN = /^([A-Za-z]+):\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})(\/?)$/;

/** 中继节点：与服务端 normalizeLanPeer 一致，scheme://主机:端口，只有 ws/wss 可带结尾的 /。返回第一个不合规节点的说明。 */
export function lanPeersIssue(peers: readonly string[]): Issue | null {
  for (const peer of peers) {
    const match = PEER_PATTERN.exec(peer);
    const scheme = match?.[1]?.toLowerCase() ?? '';
    const host = match?.[2] ?? '';
    const port = Number(match?.[3]);
    const ok = match !== null
      && PEER_SCHEMES.has(scheme)
      && port >= 1 && port <= 65535
      && (!match[4] || scheme === 'ws' || scheme === 'wss')
      && (host.startsWith('[') || IPV4.test(host) || isHostname(host));
    if (!ok) return { key: 'server.lan.peerInvalid', params: { peer: peer.slice(0, 80) } };
  }
  return null;
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

function looksLikeIpv6(host: string): boolean {
  // IPv6 至少有两个冒号；只有一个冒号的是「地址:端口」。
  return (host.match(/:/g)?.length ?? 0) >= 2 && /^[0-9a-f:.]+$/i.test(host) && host.split('::').length <= 2;
}

/** 公网地址：与服务端 normalizePublicHost 一致，接受 IPv4、IPv6 或域名，可带 http(s):// 和结尾斜杠，不能带端口。空串返回 null。 */
export function publicHostIssue(value: string): Issue | null {
  let host = value.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (host === '') return null;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(host);
  if (bracketed) {
    if (!looksLikeIpv6(bracketed[1]!)) return { key: 'server.publicHost.invalid' };
    if (bracketed[2] !== undefined) return { key: 'server.publicHost.hasPort' };
    host = bracketed[1]!;
  }
  if (IPV4.test(host) || looksLikeIpv6(host)) return null;
  const withPort = /^(.+):(\d+)$/.exec(host);
  if (withPort && (IPV4.test(withPort[1]!) || DOMAIN_RE.test(withPort[1]!))) return { key: 'server.publicHost.hasPort' };
  if (host.length > 253 || !DOMAIN_RE.test(host) || /^[\d.]+$/.test(host)) return { key: 'server.publicHost.invalid' };
  return null;
}
