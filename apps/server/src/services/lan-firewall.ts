import { spawn } from 'node:child_process';
import path from 'node:path';
import { getMinecraftChildEnv } from '../utils/child-env.js';

/**
 * Windows firewall rules. EasyTier's virtual interface is usually classified as a "Public network",
 * while Java's inbound allow rule often applies only on "Private networks", so friends get into the virtual network but cannot reach the game port.
 * The panel adds only three narrowly scoped allow rules and deletes them by name when the virtual LAN stops:
 * - the game TCP port, restricted to the destination address being this instance's virtual IP (only traffic on the virtual interface can match);
 * - TCP and UDP on the EasyTier listen port, for IPv6 / LAN direct connections, restricted to the easytier-core actually started (program=).
 * The game port rule has no program restriction: instances start with the java on PATH by default, and the panel cannot be sure of the image path that actually listens
 * (javapath links, shim forwarding, etc.); restricting it wrongly would break connectivity, and localip already confines it to the virtual interface.
 * Rules left behind by a crashed panel are deleted by name by lan-manager, in the startup sweep and on later stop / shutdown / delete.
 * Other systems are not handled; the user's own firewall decides.
 */

const INSTANCE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const NETSH_TIMEOUT_MS = 10_000;

export type LanFirewallRunner = (args: readonly string[]) => Promise<number>;
export type LanFirewallResult = 'applied' | 'failed' | 'skipped';

export interface LanFirewallInput {
  instanceId: string;
  virtualIp: string;
  gamePort: number;
  listenPort: number;
  /**
   * Absolute path of the easytier-core actually started; it comes only from the panel's own runtime directory, never from a request.
   * When null or not suitable to pass to netsh, the listen port rules have no program restriction (same as before narrowing).
   */
  corePath: string | null;
}

export interface LanFirewallRule {
  args: string[];
  /** Arguments used instead when the preferred ones cannot be added (no program restriction), so connectivity is never worse than before narrowing. */
  fallback: string[] | null;
}

let runner: LanFirewallRunner = runNetsh;
let platform: NodeJS.Platform = process.platform;

/** For tests: replaces the netsh runner and the platform check; pass null to restore the defaults. */
export function setLanFirewallForTests(next: { runner: LanFirewallRunner; platform: NodeJS.Platform } | null): void {
  runner = next?.runner ?? runNetsh;
  platform = next?.platform ?? process.platform;
}

/** Only on Windows does the panel manage firewall rules; on other systems open, close and sweep are all no-ops. */
export function lanFirewallApplies(): boolean {
  return platform === 'win32';
}

/** Rule names contain no spaces, to avoid differences in Windows command-line quoting. */
export function lanFirewallRuleName(instanceId: string): string {
  if (!INSTANCE_ID.test(instanceId)) throw new Error('invalid instance id');
  return `MystryDashboard-LAN-${instanceId}`;
}

export function lanFirewallRuleArgs(input: LanFirewallInput): LanFirewallRule[] {
  const name = `name=${lanFirewallRuleName(input.instanceId)}`;
  assertPort(input.gamePort);
  assertPort(input.listenPort);
  if (!/^10\.126\.\d{1,3}\.1$/.test(input.virtualIp)) throw new Error('invalid virtual ip');
  const base = ['advfirewall', 'firewall', 'add', 'rule', name, 'dir=in', 'action=allow', 'profile=any', 'enable=yes'];
  const program = usableProgramPath(input.corePath);
  const listener = (protocol: 'TCP' | 'UDP'): LanFirewallRule => {
    const broad = [...base, `protocol=${protocol}`, `localport=${input.listenPort}`];
    // The path is passed to netsh as a separate array argument, not concatenated into a command-line string.
    return program ? { args: [...broad, `program=${program}`], fallback: broad } : { args: broad, fallback: null };
  };
  return [
    { args: [...base, 'protocol=TCP', `localport=${input.gamePort}`, `localip=${input.virtualIp}`], fallback: null },
    listener('TCP'),
    listener('UDP'),
  ];
}

/** Deletes the old rule of the same name before adding, so repeated calls give the same result. If any rule (including its fallback arguments) cannot be added, everything is rolled back. */
export async function openLanFirewall(input: LanFirewallInput): Promise<LanFirewallResult> {
  if (!lanFirewallApplies()) return 'skipped';
  let rules: LanFirewallRule[];
  try {
    rules = lanFirewallRuleArgs(input);
  } catch {
    // Rules are best effort only: with invalid arguments, report that they could not be added rather than keeping the whole virtual LAN from starting.
    return 'failed';
  }
  await closeLanFirewall(input.instanceId);
  for (const rule of rules) {
    if (await runSucceeded(rule.args)) continue;
    if (rule.fallback && await runSucceeded(rule.fallback)) continue;
    await closeLanFirewall(input.instanceId);
    return 'failed';
  }
  return 'applied';
}

/**
 * Deletes all rules of this instance by name; safe to call repeatedly. netsh also returns non-zero when the rule does not exist, so it counts as handled as long as netsh ran to completion;
 * false means netsh could not run or timed out, so it is unknown whether the rules are still there and the caller should try again later.
 */
export async function closeLanFirewall(instanceId: string): Promise<boolean> {
  if (!lanFirewallApplies()) return true;
  if (!INSTANCE_ID.test(instanceId)) return true;
  const code = await runner(['advfirewall', 'firewall', 'delete', 'rule', `name=${lanFirewallRuleName(instanceId)}`])
    .catch(() => -1);
  return code >= 0;
}

async function runSucceeded(args: readonly string[]): Promise<boolean> {
  return (await runner(args).catch(() => -1)) === 0;
}

/** Only absolute paths are accepted; quotes, control characters and % (the firewall expands paired % as environment variables) all give up narrowing. */
function usableProgramPath(value: string | null): string | null {
  if (!value || !path.isAbsolute(value) || /["%\u0000-\u001f]/.test(value)) return null;
  return value;
}

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port');
}

/** Uses the netsh in the system directory, without a PATH lookup. The panel port rules (panel-firewall.ts) use it as well. */
export function runNetsh(args: readonly string[]): Promise<number> {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  const netsh = path.join(systemRoot, 'System32', 'netsh.exe');
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    };
    const child = spawn(netsh, args, {
      env: getMinecraftChildEnv(),
      windowsHide: true,
      stdio: 'ignore',
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(-1);
    }, NETSH_TIMEOUT_MS);
    child.on('error', () => finish(-1));
    child.on('exit', (code) => finish(code ?? -1));
  });
}
