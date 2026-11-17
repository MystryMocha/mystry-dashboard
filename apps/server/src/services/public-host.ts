import net from 'node:net';
import { getDb } from '../db.js';
import { PanelError } from '../utils/errors.js';

/**
 * 用户填写的公网 IP 或域名，一台电脑一个值：联机页拼「地址:游戏端口」，面板网址拼「地址:面板端口」。
 * 不自动探测（探测要请求第三方服务），不解析域名，不发任何外部请求。
 */
const SETTING_KEY = 'network.public_host';
const MAX_HOST_LENGTH = 253;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

function invalid(): PanelError {
  return new PanelError('server.publicHost.invalid', undefined, { statusCode: 400 });
}

/** 规范化并校验；私网、回环地址不拒绝（由界面提示）。 */
export function normalizePublicHost(raw: string): string {
  // 去掉用户顺手带上的协议头和末尾的斜杠。
  let host = raw.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!host || host.length > MAX_HOST_LENGTH + 8) throw invalid();
  // [IPv6] 或 [IPv6]:端口
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
  // 全是数字和点的写法（如 1.2.3）不是域名，多半是没写完的 IP。
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

/** 传 null 清除；返回保存后的值。 */
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

/** 拼进网址或「地址:端口」时，IPv6 要加方括号。 */
export function hostForUrl(host: string): string {
  return net.isIPv6(host) ? `[${host}]` : host;
}
