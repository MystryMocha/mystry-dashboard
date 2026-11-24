import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getMinecraftChildEnv } from '../utils/child-env.js';
import { PanelError } from '../utils/errors.js';
import { windowsPanelToken } from './windows-elevation.js';

/**
 * One-click restart as administrator (Windows only).
 *
 * The panel cannot raise its own token. Instead it asks Windows to open the launcher it was started from, `mdash.cmd restart`, in an
 * elevated window: the same command a user runs by hand after "Run as administrator", so nothing new runs behind the UAC prompt.
 * Accepting the prompt is what stops this panel and starts an elevated one; declining leaves everything running as it is.
 *
 * An elevated process starts from a fresh environment, not this one's, so the launcher has to find the same config and data directory
 * on its own. The launcher passes MYSTRY_LAUNCHER to the panel only when that holds; otherwise the page keeps the manual steps.
 *
 * `launcher/admin.json` in the data directory carries what cannot cross the prompt as environment: whether the launcher should ask for
 * administrator rights on every start (the user's choice, shown on the page), and that this restart came from the page, so the elevated
 * launcher does not open a second browser tab while the page reloads itself.
 */

const ADMIN_PREFS_FILE = 'admin.json';
/** The prompt waits for the user; past this the attempt counts as failed rather than holding the request open indefinitely. */
const ELEVATION_TIMEOUT_MS = 5 * 60_000;
/** The path ends up on a cmd.exe command line; any character cmd could treat as syntax rules the one-click restart out. */
const CMD_SPECIAL = /["%^&|<>!\u0000-\u001f]/;
/**
 * Exit codes of ELEVATE_SCRIPT. 1223 is ERROR_CANCELLED, which Windows reports when the prompt is declined.
 * Process.Start rather than Start-Process: Windows PowerShell 5.1's Start-Process rethrows the failure as an InvalidOperationException
 * without the Win32Exception inside, so a declined prompt could not be told apart from a failure.
 */
const ELEVATE_SCRIPT = [
  '$start = New-Object System.Diagnostics.ProcessStartInfo $env:ComSpec, $env:MYSTRY_ELEVATE_ARGS;',
  "$start.Verb = 'runas'; $start.UseShellExecute = $true;",
  'try { [Diagnostics.Process]::Start($start) | Out-Null; exit 0 }',
  'catch { $e = $_.Exception; while ($e) { if ($e -is [ComponentModel.Win32Exception] -and $e.NativeErrorCode -eq 1223) { exit 2 }; $e = $e.InnerException }; exit 1 }',
].join(' ');

export type ElevationOutcome = 'started' | 'cancelled' | 'failed';
/** Receives the cmd.exe arguments to run elevated. */
export type ElevationRunner = (cmdArguments: string) => Promise<ElevationOutcome>;

export interface AdminPrefs {
  startAsAdmin: boolean;
  /** Set by the page's restart; the launcher clears it once it has used it. */
  panelRestartRequestedAt?: string;
}

let runner: ElevationRunner = runElevated;
let platform: NodeJS.Platform = process.platform;
let inFlight = false;

/** For tests: replaces the elevation runner and the platform check; pass null to restore the defaults. No test may open a real prompt. */
export function setAdminRestartForTests(next: { runner: ElevationRunner; platform: NodeJS.Platform } | null): void {
  runner = next?.runner ?? runElevated;
  platform = next?.platform ?? process.platform;
  inFlight = false;
}

function prefsPath(): string {
  return path.join(config.dataDir, 'launcher', ADMIN_PREFS_FILE);
}

export function readAdminPrefs(): AdminPrefs {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(prefsPath(), 'utf8'));
  } catch {
    return { startAsAdmin: false };
  }
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const requestedAt = record.panelRestartRequestedAt;
  return { startAsAdmin: record.startAsAdmin === true, ...(typeof requestedAt === 'string' ? { panelRestartRequestedAt: requestedAt } : {}) };
}

/** Without anything to keep, the file is removed, so a launcher from before this feature finds the directory as it left it. */
function writeAdminPrefs(prefs: AdminPrefs): void {
  const file = prefsPath();
  if (!prefs.startAsAdmin && !prefs.panelRestartRequestedAt) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ version: 1, ...prefs }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** The launcher the panel was started from, as the launcher itself reported it. Never taken from a request. */
export function launcherForAdminRestart(): string | null {
  const launcher = process.env.MYSTRY_LAUNCHER?.trim();
  if (!launcher || !path.isAbsolute(launcher) || path.basename(launcher).toLowerCase() !== 'mdash.cmd' || CMD_SPECIAL.test(launcher)) {
    return null;
  }
  return fs.existsSync(launcher) ? launcher : null;
}

/**
 * Whether this request may offer the one-click restart. The prompt appears on this computer's screen, so only a browser on this
 * computer is offered it; a panel started without the launcher (development mode) has nothing to restart into.
 */
export async function adminRestartAvailable(localRequest: boolean): Promise<boolean> {
  if (platform !== 'win32' || !localRequest || !config.processFingerprint || !launcherForAdminRestart()) return false;
  const token = await windowsPanelToken();
  return token !== null && !token.elevated && token.administrator;
}

/** Resolves once the elevated window has opened; this panel is stopped from there shortly after. */
export async function requestAdminRestart(rememberForStart: boolean, localRequest: boolean): Promise<void> {
  if (!(await adminRestartAvailable(localRequest))) {
    throw new PanelError('server.lan.adminRestartUnavailable', undefined, { statusCode: 403 });
  }
  if (inFlight) throw new PanelError('server.lan.adminRestartBusy', undefined, { statusCode: 409 });
  inFlight = true;
  const previous = readAdminPrefs();
  try {
    writeAdminPrefs({ startAsAdmin: rememberForStart, panelRestartRequestedAt: new Date().toISOString() });
    // cmd /c strips the outer quotes and runs `"<launcher>" restart || pause`: the window closes after a successful restart and
    // stays open after a failed one, which may already have stopped this panel.
    const outcome = await runner(`/c ""${launcherForAdminRestart()}" restart || pause"`);
    if (outcome !== 'started') {
      writeAdminPrefs({ startAsAdmin: previous.startAsAdmin });
      throw outcome === 'cancelled'
        ? new PanelError('server.lan.adminRestartCancelled', undefined, { statusCode: 409 })
        : new PanelError('server.lan.adminRestartFailed', undefined, { statusCode: 500 });
    }
  } finally {
    inFlight = false;
  }
}

/** Only turns the remembered choice on or off; it never restarts anything. */
export function setStartAsAdmin(enabled: boolean): void {
  if (platform !== 'win32') throw new PanelError('server.lan.adminRestartUnavailable', undefined, { statusCode: 403 });
  writeAdminPrefs({ ...readAdminPrefs(), startAsAdmin: enabled });
}

/** Windows only; false elsewhere. */
export function startsAsAdmin(): boolean {
  return platform === 'win32' && readAdminPrefs().startAsAdmin;
}

/** Uses the PowerShell in the system directory, without a PATH lookup; the arguments travel in an environment variable, not the script. */
function runElevated(cmdArguments: string): Promise<ElevationOutcome> {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve) => {
    execFile(
      powershell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ELEVATE_SCRIPT],
      { env: { ...getMinecraftChildEnv(), MYSTRY_ELEVATE_ARGS: cmdArguments }, windowsHide: true, timeout: ELEVATION_TIMEOUT_MS },
      (error) => {
        if (!error) return resolve('started');
        resolve(typeof error.code === 'number' && error.code === 2 ? 'cancelled' : 'failed');
      },
    );
  });
}
