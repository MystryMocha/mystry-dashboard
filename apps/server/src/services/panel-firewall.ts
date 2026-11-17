import path from 'node:path';
import type { RemoteAccessFirewall } from '@mystry/shared';
import { runNetsh } from './lan-firewall.js';

/**
 * 面板端口的 Windows 防火墙放行规则（从其他设备访问面板时用）。
 * 每种访问方式一条按名字管理的规则：开启时先删同名旧规则再添加，关闭这种方式或关闭面板时按名字删除。
 * 规则名带面板端口：同一台电脑上的两个面板端口必然不同，开关时不会删掉对方的规则。
 * 仍只删本进程加过的规则，不在启动时无条件清扫（同 对实例联机规则的做法）；
 * 面板异常退出留下的规则，在下次用同一端口开启同一种方式时被先删后加覆盖。
 * netsh 添加规则要管理员权限，面板通常不是管理员身份，所以 failed 是常见结果，由界面说明怎么手动放行。
 * 其他系统不处理（skipped），由用户自己的防火墙决定。
 */

export type PanelFirewallRunner = (args: readonly string[]) => Promise<number>;
export type PanelFirewallTarget = 'direct' | 'overlay' | 'panelNetwork';

const PANEL_FIREWALL_RULE_PREFIXES: Record<PanelFirewallTarget, string> = {
  direct: 'MystryDashboard-Panel-Direct',
  overlay: 'MystryDashboard-Panel-Overlay',
  panelNetwork: 'MystryDashboard-PanelNet',
};

/** 规则名：前缀加面板端口。自带网络的 EasyTier 监听端口每次启动都会变，所以也用面板端口而不是它。 */
export function panelFirewallRuleName(target: PanelFirewallTarget, panelPort: number): string {
  if (!Number.isInteger(panelPort) || panelPort < 1 || panelPort > 65535) throw new Error('invalid port');
  return `${PANEL_FIREWALL_RULE_PREFIXES[target]}-${panelPort}`;
}

export interface PanelPortFirewallInput {
  target: 'direct' | 'overlay';
  port: number;
  /** 只监听部分地址时填写；空数组表示不限本机地址 */
  localAddresses: readonly string[];
  /** 开了「只允许同一网段」时填写允许的来源网段（CIDR）；空数组表示不限来源 */
  remoteRanges: readonly string[];
  /** 面板进程的可执行文件路径；不适合交给 netsh 时不限程序 */
  programPath: string | null;
}

let runner: PanelFirewallRunner = runNetsh;
let platform: NodeJS.Platform = process.platform;

/** 测试用：替换 netsh 执行器和平台判断；传 null 恢复默认。 */
export function setPanelFirewallForTests(next: { runner: PanelFirewallRunner; platform: NodeJS.Platform } | null): void {
  runner = next?.runner ?? runNetsh;
  platform = next?.platform ?? process.platform;
}

export function panelFirewallApplies(): boolean {
  return platform === 'win32';
}

/** 只接受绝对路径；引号、控制字符和 %（防火墙会把成对的 % 当环境变量展开）都放弃收窄。 */
function usableProgramPath(value: string | null): string | null {
  if (!value || !path.win32.isAbsolute(value) || /["%\u0000-\u001f]/.test(value)) return null;
  return value;
}

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const CIDR_RE = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;

/** 首选参数带 program=，加不上时退回不限程序的参数。 */
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
  // 路径作为单独的数组参数传给 netsh，不拼命令行字符串。
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
 * 面板自带 EasyTier 的监听端口（TCP 与 UDP），供 IPv6 / 局域网直连，做法同实例联机：
 * 限定实际启动的 easytier-core 和它的监听端口；限定程序加不上时退回只限端口。
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

/** 按名字删掉一种方式的全部规则，可重复调用；规则不存在时 netsh 返回非零，同样算处理过。 */
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

