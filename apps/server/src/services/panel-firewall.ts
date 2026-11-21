import path from 'node:path';
import type { RemoteAccessFirewall } from '@mystry/shared';
import { runNetsh } from './lan-firewall.js';

/**
 * Windows firewall allow rules for the panel port (used when accessing the panel from other devices).
 * One rule per access mode, managed by name: on enable, the old rule of the same name is deleted before adding; on disabling the mode or shutting down the panel, it is deleted by name.
 * The rule name includes the panel port: two panels on the same computer always have different ports, so toggling never deletes the other's rules.
 * Still only rules added by this process are deleted, with no unconditional sweep at startup (same as D-031 for instance multiplayer rules);
 * rules left behind by a crashed panel are overwritten by delete-then-add the next time the same mode is enabled on the same port.
 * Adding a rule with netsh needs admin rights and the panel usually does not run as admin, so failed is a common result, and the UI explains how to allow it manually.
 * Other systems are not handled (skipped); the user's own firewall decides.
 */

export type PanelFirewallRunner = (args: readonly string[]) => Promise<number>;
export type PanelFirewallTarget = 'direct' | 'overlay' | 'panelNetwork';

const PANEL_FIREWALL_RULE_PREFIXES: Record<PanelFirewallTarget, string> = {
  direct: 'MystryDashboard-Panel-Direct',
  overlay: 'MystryDashboard-Panel-Overlay',
  panelNetwork: 'MystryDashboard-PanelNet',
};

/** Rule name: prefix plus the panel port. The built-in network's EasyTier listen port changes on every start, so the panel port is used here too instead of it. */
export function panelFirewallRuleName(target: PanelFirewallTarget, panelPort: number): string {
  if (!Number.isInteger(panelPort) || panelPort < 1 || panelPort > 65535) throw new Error('invalid port');
  return `${PANEL_FIREWALL_RULE_PREFIXES[target]}-${panelPort}`;
}

export interface PanelPortFirewallInput {
  target: 'direct' | 'overlay';
  port: number;
  /** Set when listening on only some addresses; an empty array means no restriction on local addresses */
  localAddresses: readonly string[];
  /** Set to the allowed source subnets (CIDR) when "same subnet only" is on; an empty array means no restriction on source */
  remoteRanges: readonly string[];
  /** Executable path of the panel process; no program restriction when it is not suitable to pass to netsh */
  programPath: string | null;
}

let runner: PanelFirewallRunner = runNetsh;
let platform: NodeJS.Platform = process.platform;

/** For tests: replaces the netsh runner and the platform check; pass null to restore the defaults. */
export function setPanelFirewallForTests(next: { runner: PanelFirewallRunner; platform: NodeJS.Platform } | null): void {
  runner = next?.runner ?? runNetsh;
  platform = next?.platform ?? process.platform;
}

export function panelFirewallApplies(): boolean {
  return platform === 'win32';
}

/** Only absolute paths are accepted; quotes, control characters and % (the firewall expands paired % as environment variables) all give up narrowing. */
function usableProgramPath(value: string | null): string | null {
  if (!value || !path.win32.isAbsolute(value) || /["%\u0000-\u001f]/.test(value)) return null;
  return value;
}

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const CIDR_RE = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;

/** The preferred arguments include program=; when that cannot be added, fall back to arguments without a program restriction. */
export function panelPortFirewallArgs(input: PanelPortFirewallInput): { args: string[]; fallback: string[] | null } {
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error('invalid port');
  if (!input.localAddresses.every((value) => IPV4_RE.test(value))) throw new Error('invalid local address');
  if (!input.remoteRanges.every((value) => CIDR_RE.test(value))) throw new Error('invalid remote range');
  const broad = [
    'advfirewall', 'firewall', 'add', 'rule',
    `name=${panelFirewallRuleName(input.target, input.port)}`,
    'dir=in', 'action=allow', 'profile=any', 'enable=yes',
    'protocol=TCP', `localport=${input.port}`,
  ];
  if (input.localAddresses.length > 0) broad.push(`localip=${input.localAddresses.join(',')}`);
  if (input.remoteRanges.length > 0) broad.push(`remoteip=${input.remoteRanges.join(',')}`);
  const program = usableProgramPath(input.programPath);
  // The path is passed to netsh as a separate array argument, not concatenated into a command-line string.
  return program ? { args: [...broad, `program=${program}`], fallback: broad } : { args: broad, fallback: null };
}

async function runSucceeded(args: readonly string[]): Promise<boolean> {
  return (await runner(args).catch(() => -1)) === 0;
}

export async function openPanelPortFirewall(input: PanelPortFirewallInput): Promise<RemoteAccessFirewall> {
  if (!panelFirewallApplies()) return 'skipped';
  let rule: { args: string[]; fallback: string[] | null };
  try {
    rule = panelPortFirewallArgs(input);
  } catch {
    return 'failed';
  }
  await closePanelFirewall(input.target, input.port);
  if (await runSucceeded(rule.args)) return 'applied';
  if (rule.fallback && await runSucceeded(rule.fallback)) return 'applied';
  await closePanelFirewall(input.target, input.port);
  return 'failed';
}

/**
 * Listen ports (TCP and UDP) of the panel's built-in EasyTier, for IPv6 / LAN direct connections, done the same way as instance multiplayer:
 * restricted to the easytier-core actually started and its listen port; when the program restriction cannot be added, fall back to restricting the port only.
 */
export async function openPanelNetworkFirewall(corePath: string, listenPort: number, panelPort: number): Promise<RemoteAccessFirewall> {
  if (!panelFirewallApplies()) return 'skipped';
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) return 'failed';
  let name: string;
  try {
    name = panelFirewallRuleName('panelNetwork', panelPort);
  } catch {
    return 'failed';
  }
  const program = usableProgramPath(corePath);
  await closePanelFirewall('panelNetwork', panelPort);
  for (const protocol of ['TCP', 'UDP']) {
    const broad = [
      'advfirewall', 'firewall', 'add', 'rule',
      `name=${name}`,
      'dir=in', 'action=allow', 'profile=any', 'enable=yes',
      `protocol=${protocol}`, `localport=${listenPort}`,
    ];
    if (program && await runSucceeded([...broad, `program=${program}`])) continue;
    if (await runSucceeded(broad)) continue;
    await closePanelFirewall('panelNetwork', panelPort);
    return 'failed';
  }
  return 'applied';
}

/** Deletes all rules of one mode by name; safe to call repeatedly. netsh returns non-zero when the rule does not exist, which also counts as handled. */
export async function closePanelFirewall(target: PanelFirewallTarget, panelPort: number): Promise<void> {
  if (!panelFirewallApplies()) return;
  let name: string;
  try {
    name = panelFirewallRuleName(target, panelPort);
  } catch {
    return;
  }
  await runner(['advfirewall', 'firewall', 'delete', 'rule', `name=${name}`]).catch(() => -1);
}

