import fs from 'node:fs';
import os from 'node:os';

/** Tolerance for wall-clock jitter and NTP adjustment when comparing lock/run timestamps against estimated OS boot time. */
export const BOOT_TIME_SKEW_MS = 5_000;

let cachedLinuxBootId: string | null | undefined;

/** Returns the kernel boot UUID on Linux (unique per OS reboot), or null on other platforms. */
export function readLinuxBootId(): string | null {
  if (cachedLinuxBootId !== undefined) return cachedLinuxBootId;
  if (process.platform !== 'linux') {
    cachedLinuxBootId = null;
    return null;
  }
  try {
    const raw = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    cachedLinuxBootId = raw || null;
  } catch {
    cachedLinuxBootId = null;
  }
  return cachedLinuxBootId;
}

/**
 * Returns true when an ISO timestamp clearly predates the current OS boot, so a stale PID
 * recorded before a power loss or reboot is not mistaken for a recycled PID in this boot.
 */
export function isTimestampBeforeBoot(
  iso: string,
  nowMs = Date.now(),
  uptimeSeconds = os.uptime(),
): boolean {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed) || !Number.isFinite(uptimeSeconds) || uptimeSeconds < 0) {
    return false;
  }
  const bootTimeMs = nowMs - uptimeSeconds * 1000;
  return parsed < bootTimeMs - BOOT_TIME_SKEW_MS;
}
