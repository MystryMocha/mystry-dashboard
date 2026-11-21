/**
 * Session duration (D-040): how long after sign-in the password must be entered again. Stored in panel_settings, changeable in the panel at any time, 12 hours by default.
 * When a token is issued, exp is written from the current setting (not written for never expire); on every request the issue time iat is checked against the current setting again,
 * so after shortening, tokens whose sign-in is older than the new duration (including ones issued earlier as "never expire") are invalidated immediately.
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

/** expiresIn used when issuing a token; returns undefined for never expire, and the token carries no exp. */
export function sessionExpiresIn(duration: SessionDuration): string | undefined {
  return duration === 'never' ? undefined : duration;
}

/**
 * Whether a token's issue time is still within the current session duration. Always passes for never expire;
 * for a token without iat there is no telling how long ago the sign-in was, so it is treated as expired (tokens issued by @fastify/jwt all carry iat).
 */
export function isWithinSessionDuration(issuedAtSeconds: unknown, now = Date.now()): boolean {
  const duration = getSessionDuration();
  if (duration === 'never') return true;
  if (typeof issuedAtSeconds !== 'number' || !Number.isFinite(issuedAtSeconds)) return false;
  return now - issuedAtSeconds * 1000 <= DURATION_MS[duration];
}
