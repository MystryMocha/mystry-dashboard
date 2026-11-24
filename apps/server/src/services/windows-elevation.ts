import { execFile } from 'node:child_process';
import path from 'node:path';
import { getMinecraftChildEnv } from '../utils/child-env.js';

/**
 * Whether the panel process runs elevated on Windows. EasyTier can create its virtual adapter only from an elevated process, and the panel
 * starts easytier-core as its own child, so it is the panel that has to be started as administrator.
 * The answer comes from the integrity label in `whoami /groups`, whose SIDs are not localized (the group names are). Under UAC an
 * administrator's unelevated token is Medium (S-1-16-8192); elevated is High (S-1-16-12288) and the SYSTEM account is System (S-1-16-16384).
 * A process keeps its token for its whole life, so the first answer is kept. A lookup that fails is not: one slow whoami at startup
 * would otherwise hide the missing rights for as long as the panel runs.
 */

const WHOAMI_TIMEOUT_MS = 10_000;
/** After a failed lookup, how long until a request tries again; the runtime endpoint is polled every few seconds. */
const RETRY_AFTER_FAILURE_MS = 30_000;
const HIGH_INTEGRITY_RID = 12288;

export type WhoamiGroupsRunner = () => Promise<string>;

let runner: WhoamiGroupsRunner = runWhoamiGroups;
let platform: NodeJS.Platform = process.platform;
let known: boolean | null = null;
let pending: Promise<boolean | null> | null = null;
let failedAt: number | null = null;
let warned = false;

/** For tests: replaces the whoami runner and the platform check and forgets every earlier answer; pass null to restore the defaults. */
export function setWindowsElevationForTests(next: { runner: WhoamiGroupsRunner; platform: NodeJS.Platform } | null): void {
  runner = next?.runner ?? runWhoamiGroups;
  platform = next?.platform ?? process.platform;
  known = null;
  pending = null;
  failedAt = null;
  warned = false;
}

/** true when elevated, false when not, null when the output carries no integrity label. */
export function parseWindowsElevation(whoamiGroups: string): boolean | null {
  const label = /S-1-16-(\d+)/.exec(whoamiGroups);
  return label ? Number(label[1]) >= HIGH_INTEGRITY_RID : null;
}

/**
 * Windows only. null on other systems, and when whoami cannot run or its output cannot be read: an unknown answer must not
 * warn someone who already started the panel as administrator.
 */
export function windowsPanelElevated(): Promise<boolean | null> {
  if (platform !== 'win32') return Promise.resolve(null);
  if (known !== null) return Promise.resolve(known);
  if (pending) return pending;
  if (failedAt !== null && Date.now() - failedAt < RETRY_AFTER_FAILURE_MS) return Promise.resolve(null);
  pending = runner()
    .then((output) => parseWindowsElevation(output) ?? Promise.reject(new Error('whoami /groups printed no integrity label')))
    .then(
      (elevated) => {
        known = elevated;
        failedAt = null;
        return elevated;
      },
      (error: unknown) => {
        failedAt = Date.now();
        // Once per panel process: the lookup is retried every half minute while the page is open.
        if (!warned) {
          warned = true;
          console.warn(`Could not tell whether the panel runs as administrator; trying again later: ${error instanceof Error ? error.message : String(error)}`);
        }
        return null;
      },
    )
    .finally(() => {
      pending = null;
    });
  return pending;
}

/**
 * EasyTier failed in a way that points at missing administrator rights. While the lookup has no answer, the next request runs it
 * again without waiting out the retry delay, so the page can show the steps instead of only the failure.
 */
export function recheckWindowsElevationSoon(): void {
  if (known === null) failedAt = null;
}

/** Uses the whoami in the system directory, without a PATH lookup. */
function runWhoamiGroups(): Promise<string> {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  const whoami = path.join(systemRoot, 'System32', 'whoami.exe');
  return new Promise((resolve, reject) => {
    execFile(
      whoami,
      ['/groups', '/fo', 'csv', '/nh'],
      { env: getMinecraftChildEnv(), windowsHide: true, timeout: WHOAMI_TIMEOUT_MS },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}
