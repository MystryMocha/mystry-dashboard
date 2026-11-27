import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { hasErrorCode } from './errors.js';

const execFileAsync = promisify(execFile);

const WIN32_POWERSHELL_PREAMBLE =
  "$PSModuleAutoLoadingPreference = 'None'; Import-Module ($PSHOME + '\\Modules\\Microsoft.PowerShell.Management'), ($PSHOME + '\\Modules\\Microsoft.PowerShell.Utility');";

/** Tolerance for wall-clock jitter and NTP adjustment when comparing lock/run timestamps against estimated OS boot time. */
export const BOOT_TIME_SKEW_MS = 5_000;

export type TrackedProcessCandidate = {
  pid: number;
  startedAt: string;
  processIdentity: string | null;
  cwd?: string;
};

let cachedLinuxBootId: string | null | undefined;

function powershellExecutable(): string {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function powershellEnv(): NodeJS.ProcessEnv {
  return { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR };
}

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

/** Checks whether an OS PID currently exists (`kill(pid, 0)` succeeding or returning EPERM). */
export function isProcessAliveSync(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasErrorCode(error, 'EPERM');
  }
}

/**
 * Returns the start-time tick field (field 22) of a `/proc/<pid>/stat` line. The command name in field 2 may itself
 * contain spaces and `)`, so fields are counted from the last `)`.
 */
export function parseProcStatStartTicks(stat: string): string | null {
  const rparen = stat.lastIndexOf(')');
  if (rparen === -1) return null;
  const fields = stat.slice(rparen + 2).trim().split(/\s+/);
  const ticks = fields[19];
  return ticks && /^\d+$/.test(ticks) ? ticks : null;
}

/** Reads the start-time tick field from `/proc/<pid>/stat` on Linux. */
export function readLinuxProcStartTicksSync(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    return parseProcStatStartTicks(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return null;
  }
}

/** Synchronously captures a reboot- and PID-reuse-resistant identity when available without subprocesses (Linux). */
export function captureProcessIdentitySync(pid: number): string | null {
  if (process.platform !== 'linux') return null;
  const bootId = readLinuxBootId();
  const ticks = readLinuxProcStartTicksSync(pid);
  return bootId && ticks ? `linux:${bootId}:${ticks}` : null;
}

/** Captures a process start identity across supported OSes (fast sync path on Linux, short subprocess query on Windows/macOS). */
export async function captureProcessIdentityAsync(pid: number, timeoutMs = 3500): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') return captureProcessIdentitySync(pid);
  if (process.platform === 'win32') {
    const script = `${WIN32_POWERSHELL_PREAMBLE} try { $p = Get-Process -Id ${pid} -ErrorAction Stop; $p.StartTime.ToUniversalTime().Ticks.ToString() } catch {}`;
    try {
      const { stdout } = await execFileAsync(
        powershellExecutable(),
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 4096, env: powershellEnv() },
      );
      const ticks = stdout.trim();
      return /^\d+$/.test(ticks) ? `win32:${ticks}` : null;
    } catch {
      return null;
    }
  }
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart='], {
        timeout: timeoutMs,
        maxBuffer: 4096,
      });
      const started = stdout.trim();
      return started ? `darwin:${started}` : null;
    } catch {
      return null;
    }
  }
  return null;
}

function isJavaExecutableToken(token: string): boolean {
  const base = path.basename(token.trim()).toLowerCase();
  return base === 'java' || base === 'javaw' || base === 'java.exe' || base === 'javaw.exe';
}

function linuxProcessLooksLikeInstanceJava(pid: number, cwd?: string): boolean {
  try {
    let isJava = false;
    try {
      const comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
      if (isJavaExecutableToken(comm)) isJava = true;
    } catch {
      /* Fall back to cmdline below. */
    }
    if (!isJava) {
      try {
        const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        const firstArg = raw.split('\0')[0] ?? '';
        if (isJavaExecutableToken(firstArg)) isJava = true;
      } catch {
        return false;
      }
    }
    if (!isJava) return false;
    if (cwd) {
      const procCwd = fs.realpathSync(`/proc/${pid}/cwd`);
      const expectedCwd = fs.realpathSync(cwd);
      if (procCwd !== expectedCwd) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * `unknown` means the PID exists but the OS could not be asked who owns it (inspection blocked, timed out or
 * unreadable). Callers must treat it as possibly still running: only `dead` may release a tracked process.
 */
export type TrackedProcessState = 'alive' | 'dead' | 'unknown';

/**
 * An unreadable identity proves exit only when the PID is gone or the record predates this boot. The boot check
 * matters after a reboot, when the old PID may now belong to a system process whose start time an unprivileged
 * panel cannot read; without it such an instance would stay blocked.
 */
function stateWhenUninspectable(candidate: TrackedProcessCandidate): TrackedProcessState {
  if (!isProcessAliveSync(candidate.pid)) return 'dead';
  return isTimestampBeforeBoot(candidate.startedAt) ? 'dead' : 'unknown';
}

/**
 * Determines whether a tracked PID still refers to the same managed Java process, has exited or been recycled,
 * or cannot be inspected right now.
 */
export async function inspectTrackedProcess(
  candidate: TrackedProcessCandidate,
  timeoutMs = 3500,
): Promise<TrackedProcessState> {
  if (!Number.isSafeInteger(candidate.pid) || candidate.pid <= 0 || candidate.pid === process.pid) {
    return 'dead';
  }
  if (!isProcessAliveSync(candidate.pid)) {
    return 'dead';
  }

  if (candidate.processIdentity) {
    // A readable start identity decides on its own; the wall-clock boot estimate is only a tie-breaker when the
    // identity cannot be read, so a forward clock jump alone cannot declare a live server dead.
    if (!candidate.processIdentity.startsWith(`${process.platform}:`)) return 'dead';
    const current = await captureProcessIdentityAsync(candidate.pid, timeoutMs);
    if (current === null) return stateWhenUninspectable(candidate);
    return current === candidate.processIdentity ? 'alive' : 'dead';
  }

  // Legacy/crash-window fallback when the panel died before the async identity write completed.
  const startedMs = Date.parse(candidate.startedAt);
  if (!Number.isFinite(startedMs)) return 'dead';
  if (isTimestampBeforeBoot(candidate.startedAt)) return 'dead';

  if (process.platform === 'linux') {
    if (linuxProcessLooksLikeInstanceJava(candidate.pid, candidate.cwd)) return 'alive';
    return readLinuxProcStartTicksSync(candidate.pid) === null ? stateWhenUninspectable(candidate) : 'dead';
  }
  if (process.platform === 'win32') {
    // PowerShell reads a literal such as [datetime]'1970-01-01T00:00:00Z' as local time, so subtracting an epoch built
    // that way is off by the UTC offset; DateTimeOffset converts the local start time on its own.
    const script = `${WIN32_POWERSHELL_PREAMBLE} try { $p = Get-Process -Id ${candidate.pid} -ErrorAction Stop; [PSCustomObject]@{ name=$p.ProcessName; startMs=([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress } catch {}`;
    try {
      const { stdout } = await execFileAsync(
        powershellExecutable(),
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 4096, env: powershellEnv() },
      );
      const parsed = JSON.parse(stdout.trim()) as { name?: unknown; startMs?: unknown };
      if (typeof parsed.name !== 'string' || typeof parsed.startMs !== 'number' || !Number.isFinite(parsed.startMs)) {
        return stateWhenUninspectable(candidate);
      }
      return isJavaExecutableToken(parsed.name)
        && parsed.startMs >= startedMs - BOOT_TIME_SKEW_MS
        && parsed.startMs <= startedMs + 60_000
        ? 'alive'
        : 'dead';
    } catch {
      return stateWhenUninspectable(candidate);
    }
  }
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('ps', ['-p', String(candidate.pid), '-o', 'comm=,lstart='], {
        timeout: timeoutMs,
        maxBuffer: 4096,
      });
      const match = /^(\S+)\s+(.+)$/.exec(stdout.trim());
      const startMs = match ? Date.parse(match[2]) : Number.NaN;
      if (!match || !Number.isFinite(startMs)) return stateWhenUninspectable(candidate);
      return isJavaExecutableToken(match[1])
        && startMs >= startedMs - BOOT_TIME_SKEW_MS
        && startMs <= startedMs + 60_000
        ? 'alive'
        : 'dead';
    } catch {
      return stateWhenUninspectable(candidate);
    }
  }
  return 'unknown';
}

/**
 * Lightweight synchronous liveness check suitable for frequent status reads and stop polling.
 * Full OS identity verification runs at startup recovery and before delivering termination signals.
 * It only reports absence on positive evidence, because callers drop the tracked process when it returns false.
 */
export function isTrackedProcessPresentSync(candidate: TrackedProcessCandidate): boolean {
  if (!Number.isSafeInteger(candidate.pid) || candidate.pid <= 0 || candidate.pid === process.pid) {
    return false;
  }
  if (!isProcessAliveSync(candidate.pid)) return false;
  if (candidate.processIdentity) {
    if (candidate.processIdentity.startsWith('linux:')) {
      if (process.platform !== 'linux') return false;
      const current = captureProcessIdentitySync(candidate.pid);
      return current === null || current === candidate.processIdentity;
    }
    if (candidate.processIdentity.startsWith('win32:')) {
      return process.platform === 'win32';
    }
    if (candidate.processIdentity.startsWith('darwin:')) {
      return process.platform === 'darwin';
    }
    return false;
  }
  return true;
}

/** On Unix SIGTERM triggers an orderly Minecraft save-and-exit; on Windows only TerminateProcess is available without stdin. */
export function canGracefullyStopOrphan(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32';
}

export function signalProcess(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
  process.kill(pid, signal);
}
