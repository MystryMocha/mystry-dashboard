import net from 'node:net';
import { getDb } from '../db.js';
import { PanelError } from '../utils/errors.js';

/**
 * The public IP or domain entered by the user, one value per computer: the multiplayer page builds "address:game port", and panel URLs build "address:panel port".
 * No auto-detection (detection would need a request to a third-party service), no DNS resolution, no external requests at all.
 */
const SETTING_KEY = 'network.public_host';
const MAX_HOST_LENGTH = 253;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

function invalid(): PanelError {
  return new PanelError('server.publicHost.invalid', undefined, { statusCode: 400 });
}

/** Normalizes and validates; private and loopback addresses are not rejected (the UI gives a hint). */
export function normalizePublicHost(raw: string): string {
  // Strip the scheme and trailing slashes users tend to include.
  let host = raw.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!host || host.length > MAX_HOST_LENGTH + 8) throw invalid();
  // [IPv6] or [IPv6]:port
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(host);
  if (bracketed) {
    if (!net.isIPv6(bracketed[1]!)) throw invalid();
    if (bracketed[2] !== undefined) throw new PanelError('server.publicHost.hasPort', undefined, { statusCode: 400 });
    host = bracketed[1]!;
  }
  if (net.isIPv4(host)) return host;
  if (net.isIPv6(host) && !host.includes('%')) return host.toLowerCase();
  const withPort = /^(.+):(\d+)$/.exec(host);
  if (withPort && (net.isIPv4(withPort[1]!) || DOMAIN_RE.test(withPort[1]!))) {
    throw new PanelError('server.publicHost.hasPort', undefined, { statusCode: 400 });
  }
  if (host.length > MAX_HOST_LENGTH || !DOMAIN_RE.test(host)) throw invalid();
  // Something made only of digits and dots (such as 1.2.3) is not a domain, most likely an unfinished IP.
  if (/^[\d.]+$/.test(host)) throw invalid();
  return host.toLowerCase();
}

export function getPublicHost(): string | null {
  const row = getDb().prepare('SELECT value FROM panel_settings WHERE key = ?').get(SETTING_KEY) as
    | { value: string }
    | undefined;
  if (!row?.value) return null;
  try {
    return normalizePublicHost(row.value);
  } catch {
    return null;
  }
}

/** Pass null to clear; returns the saved value. */
export function setPublicHost(raw: string | null): string | null {
  if (raw === null) {
    getDb().prepare('DELETE FROM panel_settings WHERE key = ?').run(SETTING_KEY);
    return null;
  }
  const host = normalizePublicHost(raw);
  getDb().prepare(
    `INSERT INTO panel_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(SETTING_KEY, host, new Date().toISOString());
  return host;
}

/** IPv6 needs square brackets when put into a URL or "address:port". */
export function hostForUrl(host: string): string {
  return net.isIPv6(host) ? `[${host}]` : host;
}
