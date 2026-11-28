import { AUTO_RESTART_DEFAULTS, AUTO_RESTART_LIMITS, type AutoRestartSettings } from '@mystry/shared';
import { getDb } from '../db.js';

const SETTING_KEY = 'instances.auto_restart';

function inRange(value: unknown, limits: { min: number; max: number }): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= limits.min && value <= limits.max;
}

/** The saved setting; anything missing or out of range falls back to its default, so a hand-edited row cannot disable the limits. */
export function getAutoRestartSettings(): AutoRestartSettings {
  const row = getDb().prepare('SELECT value FROM panel_settings WHERE key = ?').get(SETTING_KEY) as
    | { value: string }
    | undefined;
  let saved: Partial<Record<keyof AutoRestartSettings, unknown>> = {};
  try {
    const parsed: unknown = row?.value ? JSON.parse(row.value) : null;
    if (parsed && typeof parsed === 'object') saved = parsed;
  } catch {
    // Unreadable text is treated as never saved.
  }
  return {
    enabled: saved.enabled === true,
    delaySeconds: inRange(saved.delaySeconds, AUTO_RESTART_LIMITS.delaySeconds) ? saved.delaySeconds : AUTO_RESTART_DEFAULTS.delaySeconds,
    maxAttempts: inRange(saved.maxAttempts, AUTO_RESTART_LIMITS.maxAttempts) ? saved.maxAttempts : AUTO_RESTART_DEFAULTS.maxAttempts,
    windowMinutes: inRange(saved.windowMinutes, AUTO_RESTART_LIMITS.windowMinutes) ? saved.windowMinutes : AUTO_RESTART_DEFAULTS.windowMinutes,
  };
}

/** The route validates the body against the same ranges before calling this. */
export function setAutoRestartSettings(settings: AutoRestartSettings): void {
  getDb().prepare(
    `INSERT INTO panel_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(SETTING_KEY, JSON.stringify(settings), new Date().toISOString());
}
