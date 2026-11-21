import type { MessageKey, MessageParams } from './i18n';

/**
 * Local form validation: the primary button is disabled while the information is incomplete or clearly invalid, with an explanation of what is missing.
 * The rules match the server (which still validates again); this only blocks early and explains.
 */
export interface Issue {
  key: MessageKey;
  params?: MessageParams;
}

/** Same as the server's instance name schema: not empty after trimming, at most 128 characters. */
export const INSTANCE_NAME_MAX = 128;

/** Counted in Unicode code points, matching maxLength in the server's JSON Schema (an emoji counts as 1). */
export function charCount(value: string): number {
  return [...value].length;
}

export function instanceNameIssue(name: string): Issue | null {
  if (name.trim() === '') return { key: 'validation.instanceName.required' };
  if (charCount(name) > INSTANCE_NAME_MAX) return { key: 'validation.instanceName.tooLong', params: { max: INSTANCE_NAME_MAX } };
  return null;
}

/** Parses integer input: returns null for an empty string and NaN for a non-integer. */
export function parseIntegerInput(value: string): number | null {
  const text = value.trim();
  if (text === '') return null;
  return /^-?\d+$/.test(text) ? Number(text) : Number.NaN;
}

/** Integer range validation; an omitted max means only a lower bound. When empty is allowed, an empty string is not an error. */
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

/** UTF-8 byte count, for bcrypt's 72-byte limit. */
export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

// Same as the server's admin password rules: 12–128 characters, and no more than the 72 bytes bcrypt actually uses (about 24 Chinese characters).
export const PASSWORD_MIN = 12;
const PASSWORD_MAX = 128;
const PASSWORD_MAX_BYTES = 72;

/** Returns the reason when a new password is filled in but does not comply; an empty password only disables the button, without reporting early. */
export function newPasswordIssue(password: string): Issue | null {
  if (password === '') return null;
  if (password.length < PASSWORD_MIN) return { key: 'server.auth.passwordTooShort', params: { min: PASSWORD_MIN } };
  if (password.length > PASSWORD_MAX) return { key: 'server.auth.passwordTooLong', params: { max: PASSWORD_MAX } };
  if (utf8Length(password) > PASSWORD_MAX_BYTES) return { key: 'server.auth.passwordTooManyBytes', params: { max: PASSWORD_MAX_BYTES } };
  return null;
}

/** The setup token is always 64 characters (the 64-digit hex value in the config file). */
export const SETUP_TOKEN_LENGTH = 64;

/** When the setup token is filled in but has the wrong length, says how many characters there are now; an empty token only disables the button, without reporting early. */
export function setupTokenIssue(token: string): Issue | null {
  if (token === '' || token.length === SETUP_TOKEN_LENGTH) return null;
  return { key: 'login.form.setupTokenLength', params: { max: SETUP_TOKEN_LENGTH, count: token.length } };
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function isHostname(host: string): boolean {
  return host.length <= 253 && host.split('.').every((label) => HOST_LABEL.test(label));
}

/** frp server address: same as the server's assertFrpHost, accepting only IPv4 or a hostname, without scheme, port or path. Returns null for an empty string, and the caller handles it as required. */
export function frpHostIssue(value: string): Issue | null {
  const host = value.trim();
  if (host === '') return null;
  if (/[\s/\x5c?#@:[\]"']/.test(host) || host.includes('{{') || host.includes('}}')) return { key: 'server.frp.hostInvalid' };
  return IPV4.test(host) || isHostname(host) ? null : { key: 'server.frp.hostInvalid' };
}

/** frp token: same as the server, at most 256 characters, without control characters or template markers. */
export function frpTokenIssue(value: string): Issue | null {
  if (value === '') return null;
  return value.length > 256 || /[\u0000-\u001f\u007f]/.test(value) || value.includes('{{') || value.includes('}}')
    ? { key: 'server.frp.tokenInvalid' }
    : null;
}

const PEER_SCHEMES = new Set(['tcp', 'udp', 'ws', 'wss', 'quic']);
const PEER_PATTERN = /^([A-Za-z]+):\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})(\/?)$/;

/** Relay peers: same as the server's normalizeLanPeer, scheme://host:port, where only ws/wss may have a trailing /. Returns the explanation for the first non-compliant peer. */
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
  // IPv6 has at least two colons; a single colon is "address:port".
  return (host.match(/:/g)?.length ?? 0) >= 2 && /^[0-9a-f:.]+$/i.test(host) && host.split('::').length <= 2;
}

/** Public address: same as the server's normalizePublicHost, accepting IPv4, IPv6 or a domain, optionally with http(s):// and a trailing slash, but no port. Returns null for an empty string. */
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
