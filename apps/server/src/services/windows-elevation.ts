import { execFile } from 'node:child_process';
import path from 'node:path';
import { getMinecraftChildEnv } from '../utils/child-env.js';

/**
 * Whether the panel process runs elevated on Windows. EasyTier can create its virtual adapter only from an elevated process, and the panel
 * starts easytier-core as its own child, so it is the panel that has to be started as administrator.
 * The answer comes from `whoami /groups`, whose SIDs are not localized (the group names are). Under UAC an administrator's unelevated
 * token is Medium (S-1-16-8192); elevated is High (S-1-16-12288) and the SYSTEM account is System (S-1-16-16384).
 * A process keeps its token for its whole life, so the first answer is cached.
 */

const WHOAMI_TIMEOUT_MS = 10_000;
const HIGH_INTEGRITY_RID = 12288;
/** BUILTIN\Administrators. An unelevated administrator still lists it, as a deny-only group; a standard account does not list it at all. */
const ADMINISTRATORS_SID = 'S-1-5-32-544';

export interface WindowsToken {
  elevated: boolean;
  /**
   * The account belongs to Administrators, so accepting the UAC prompt elevates this same account.
   * For a standard account the prompt asks for another account's password, and a panel restarted that way would run as that other user.
   */
  administrator: boolean;
}

export type WhoamiGroupsRunner = () => Promise<string>;

let runner: WhoamiGroupsRunner = runWhoamiGroups;
let platform: NodeJS.Platform = process.platform;
let cached: Promise<WindowsToken | null> | null = null;

/** For tests: replaces the whoami runner and the platform check and clears the cached answer; pass null to restore the defaults. */
export function setWindowsElevationForTests(next: { runner: WhoamiGroupsRunner; platform: NodeJS.Platform } | null): void {
  runner = next?.runner ?? runWhoamiGroups;
  platform = next?.platform ?? process.platform;
  cached = null;
}

/** null when the output carries no integrity label. */
export function parseWindowsToken(whoamiGroups: string): WindowsToken | null {
  const label = /S-1-16-(\d+)/.exec(whoamiGroups);
  if (!label) return null;
  return {
    elevated: Number(label[1]) >= HIGH_INTEGRITY_RID,
    administrator: whoamiGroups.includes(`"${ADMINISTRATORS_SID}"`),
  };
}

/** true when elevated, false when not, null when the output carries no integrity label. */
export function parseWindowsElevation(whoamiGroups: string): boolean | null {
  return parseWindowsToken(whoamiGroups)?.elevated ?? null;
}

/** Windows only. null on other systems, and when whoami cannot run or its output cannot be read. */
export function windowsPanelToken(): Promise<WindowsToken | null> {
  if (platform !== 'win32') return Promise.resolve(null);
  cached ??= runner().then(parseWindowsToken, () => null);
  return cached;
}

/**
 * Windows only. null on other systems, and when whoami cannot run or its output cannot be read: an unknown answer must not
 * warn someone who already started the panel as administrator.
 */
export async function windowsPanelElevated(): Promise<boolean | null> {
  return (await windowsPanelToken())?.elevated ?? null;
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
