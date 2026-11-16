import { spawn } from 'node:child_process';
import path from 'node:path';
import { getMinecraftChildEnv } from '../utils/child-env.js';

/**
 * Windows 防火墙规则。EasyTier 的虚拟网卡通常被识别为「公用网络」，
 * 而 Java 的入站放行往往只在「专用网络」生效，结果朋友进了虚拟网却连不上游戏端口。
 * 面板只加三条范围很窄的放行规则，并在虚拟局域网停止时按名字删除：
 * - 游戏 TCP 端口，且只限目标地址是本实例的虚拟 IP（只有虚拟网卡上的流量能命中）；
 * - EasyTier 监听端口的 TCP 与 UDP，供 IPv6 / 局域网直连。
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
}

let runner: LanFirewallRunner = runNetsh;
let platform: NodeJS.Platform = process.platform;

/** 测试用：替换 netsh 执行器和平台判断；传 null 恢复默认。 */
export function setLanFirewallForTests(next: { runner: LanFirewallRunner; platform: NodeJS.Platform } | null): void {
  runner = next?.runner ?? runNetsh;
  platform = next?.platform ?? process.platform;
}

/** 规则名不含空格，避免 Windows 命令行引号处理的差异。 */
export function lanFirewallRuleName(instanceId: string): string {
  if (!INSTANCE_ID.test(instanceId)) throw new Error('invalid instance id');
  return `MystryDashboard-LAN-${instanceId}`;
}

export function lanFirewallRuleArgs(input: LanFirewallInput): string[][] {
  const name = `name=${lanFirewallRuleName(input.instanceId)}`;
  assertPort(input.gamePort);
  assertPort(input.listenPort);
  if (!/^10\.126\.\d{1,3}\.1$/.test(input.virtualIp)) throw new Error('invalid virtual ip');
  const base = ['advfirewall', 'firewall', 'add', 'rule', name, 'dir=in', 'action=allow', 'profile=any', 'enable=yes'];
  return [
    [...base, 'protocol=TCP', `localport=${input.gamePort}`, `localip=${input.virtualIp}`],
    [...base, 'protocol=TCP', `localport=${input.listenPort}`],
    [...base, 'protocol=UDP', `localport=${input.listenPort}`],
  ];
}

/** 先删同名旧规则再添加，重复调用结果一致。任何一条失败都回滚。 */
export async function openLanFirewall(input: LanFirewallInput): Promise<LanFirewallResult> {
  if (platform !== 'win32') return 'skipped';
  const rules = lanFirewallRuleArgs(input);
  await closeLanFirewall(input.instanceId);
  for (const args of rules) {
    const code = await runner(args).catch(() => -1);
    if (code !== 0) {
      await closeLanFirewall(input.instanceId);
      return 'failed';
    }
  }
  return 'applied';
}

/** 按名字删掉本实例的全部规则。规则不存在时 netsh 返回非零，忽略即可。 */
export async function closeLanFirewall(instanceId: string): Promise<void> {
  if (platform !== 'win32') return;
  if (!INSTANCE_ID.test(instanceId)) return;
  await runner(['advfirewall', 'firewall', 'delete', 'rule', `name=${lanFirewallRuleName(instanceId)}`]).catch(() => -1);
}

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port');
}

/** 用系统目录里的 netsh，不经 PATH 查找。 */
function runNetsh(args: readonly string[]): Promise<number> {
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
