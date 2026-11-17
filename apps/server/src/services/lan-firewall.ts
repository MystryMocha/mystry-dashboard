import { spawn } from 'node:child_process';
import path from 'node:path';
import { getMinecraftChildEnv } from '../utils/child-env.js';

/**
 * Windows 防火墙规则。EasyTier 的虚拟网卡通常被识别为「公用网络」，
 * 而 Java 的入站放行往往只在「专用网络」生效，结果朋友进了虚拟网却连不上游戏端口。
 * 面板只加三条范围很窄的放行规则，并在虚拟局域网停止时按名字删除：
 * - 游戏 TCP 端口，且只限目标地址是本实例的虚拟 IP（只有虚拟网卡上的流量能命中）；
 * - EasyTier 监听端口的 TCP 与 UDP，供 IPv6 / 局域网直连，且只限实际启动的 easytier-core（program=）。
 * 游戏端口规则不限程序：实例默认用 PATH 里的 java 启动，真正监听的映像路径（javapath 链接、shim 转发等）
 * 面板拿不准，限错了反而连不上；localip 已把它限在虚拟网卡上。
 * 面板异常退出留下的规则由 lan-manager 在启动清扫、之后的停止 / 关闭 / 删除时按名字补删。
 * 其他系统不处理，由用户自己的防火墙决定。
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
   * 实际启动的 easytier-core 绝对路径，只来自面板自己的运行时目录，不来自请求。
   * 为 null 或不适合交给 netsh 时，监听端口规则不限程序（与收窄前相同）。
   */
  corePath: string | null;
}

export interface LanFirewallRule {
  args: string[];
  /** 首选参数加不上时改用的参数（不限程序），保证连通性不比收窄前差。 */
  fallback: string[] | null;
}

let runner: LanFirewallRunner = runNetsh;
let platform: NodeJS.Platform = process.platform;

/** 测试用：替换 netsh 执行器和平台判断；传 null 恢复默认。 */
export function setLanFirewallForTests(next: { runner: LanFirewallRunner; platform: NodeJS.Platform } | null): void {
  runner = next?.runner ?? runNetsh;
  platform = next?.platform ?? process.platform;
}

/** 只有 Windows 由面板管理防火墙规则；其他系统上开、关、清扫都是空操作。 */
export function lanFirewallApplies(): boolean {
  return platform === 'win32';
}

/** 规则名不含空格，避免 Windows 命令行引号处理的差异。 */
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
    // 路径作为单独的数组参数传给 netsh，不拼命令行字符串。
    return program ? { args: [...broad, `program=${program}`], fallback: broad } : { args: broad, fallback: null };
  };
  return [
    { args: [...base, 'protocol=TCP', `localport=${input.gamePort}`, `localip=${input.virtualIp}`], fallback: null },
    listener('TCP'),
    listener('UDP'),
  ];
}

/** 先删同名旧规则再添加，重复调用结果一致。任何一条（含退回参数）都加不上就整体回滚。 */
export async function openLanFirewall(input: LanFirewallInput): Promise<LanFirewallResult> {
  if (!lanFirewallApplies()) return 'skipped';
  let rules: LanFirewallRule[];
  try {
    rules = lanFirewallRuleArgs(input);
  } catch {
    // 规则只是尽力而为：参数不合法时提示加不上，不能让虚拟局域网整个起不来。
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
 * 按名字删掉本实例的全部规则，可重复调用。规则不存在时 netsh 也返回非零，所以只要 netsh 跑完就算处理过；
 * 返回 false 表示 netsh 没能运行或超时，规则是否还在不确定，调用方之后应再试。
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

/** 只接受绝对路径；引号、控制字符和 %（防火墙会把成对的 % 当环境变量展开）都放弃收窄。 */
function usableProgramPath(value: string | null): string | null {
  if (!value || !path.isAbsolute(value) || /["%\u0000-\u001f]/.test(value)) return null;
  return value;
}

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port');
}

/** 用系统目录里的 netsh，不经 PATH 查找。面板端口的规则（panel-firewall.ts）也用它。 */
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
