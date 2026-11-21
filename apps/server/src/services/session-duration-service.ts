/**
 * 登录有效期：登录后多久需要重新输入密码。保存在 panel_settings，面板里随时可改，默认 12 小时。
 * 签发令牌时按当前设置写 exp（不过期则不写）；每次请求再用签发时间 iat 对照当前设置，
 * 所以改短后，登录时间已超过新时长的令牌（包括以前按「不过期」签发的）立即失效。
 */
import { SESSION_DURATION_ENUM, type SessionDuration } from '@mystry/shared';
import { getDb } from '../db.js';

const SETTING_KEY = 'session_duration';
export const DEFAULT_SESSION_DURATION: SessionDuration = '12h';

const HOUR_MS = 60 * 60 * 1000;
const DURATION_MS: Record<Exclude<SessionDuration, 'never'>, number> = {
  '2h': 2 * HOUR_MS,
  '12h': 12 * HOUR_MS,
  '1d': 24 * HOUR_MS,
  '7d': 7 * 24 * HOUR_MS,
  '30d': 30 * 24 * HOUR_MS,
};

export function isSessionDuration(value: unknown): value is SessionDuration {
  return (SESSION_DURATION_ENUM as readonly unknown[]).includes(value);
}

export function getSessionDuration(): SessionDuration {
  const row = getDb().prepare('SELECT value FROM panel_settings WHERE key = ?').get(SETTING_KEY) as
    | { value: string }
    | undefined;
  return isSessionDuration(row?.value) ? row.value : DEFAULT_SESSION_DURATION;
}

export function setSessionDuration(duration: SessionDuration): void {
  getDb().prepare(
    `INSERT INTO panel_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(SETTING_KEY, duration, new Date().toISOString());
}

/** 签发令牌用的 expiresIn；不过期返回 undefined，令牌不带 exp。 */
export function sessionExpiresIn(duration: SessionDuration): string | undefined {
  return duration === 'never' ? undefined : duration;
}

/**
 * 令牌的签发时间是否仍在当前登录有效期内。不过期时一律通过；
 * 没有 iat 的令牌无法判断登录了多久，按已过期处理（@fastify/jwt 签发的令牌都带 iat）。
 */
export function isWithinSessionDuration(issuedAtSeconds: unknown, now = Date.now()): boolean {
  const duration = getSessionDuration();
  if (duration === 'never') return true;
  if (typeof issuedAtSeconds !== 'number' || !Number.isFinite(issuedAtSeconds)) return false;
  return now - issuedAtSeconds * 1000 <= DURATION_MS[duration];
}
