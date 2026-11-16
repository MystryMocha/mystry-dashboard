import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import dgram from 'node:dgram';
import net from 'node:net';
import type { InstanceLan, LanStatus, PanelMessage } from '@mystry/shared';
import { config } from '../config.js';
import { getMinecraftChildEnv } from '../utils/child-env.js';
import { PanelError } from '../utils/errors.js';
import { readServerProperties } from './config-service.js';
import {
  LAN_SHARED_PEERS,
  lanCoreArgs,
  lanFailureDetail,
  lanVirtualIp,
  renderFriendInstructions,
  renderLanToml,
  serverIpBlocksLan,
} from './lan-config.js';
import {
  getInstanceLanRow,
  lanRenderInput,
  lanWorkDir,
  listEnabledLanInstanceIds,
  removeLanFiles,
  writeLanFile,
} from './lan-service.js';
import { closeLanFirewall, openLanFirewall } from './lan-firewall.js';
import { lanCliPath, lanCorePath, lanInstalled, lanPlatformSupported } from './lan-runtime.js';
import { processManager } from './process-manager.js';

interface LanRuntime {
  status: Exclude<LanStatus, 'disabled' | 'stopped'>;
  detail: PanelMessage | null;
  child: ChildProcess | null;
  generation: number;
  configHash: string;
  rpcPort: number;
  virtualIp: string | null;
  /** EasyTier 监听端口（TCP/UDP 相同），供非打洞直连。 */
  listenPort: number | null;
  /** 本代是否已加上 Windows 防火墙规则，停止时据此删除。 */
  firewallOpened: boolean;
  warning: PanelMessage | null;
}

const runtimes = new Map<string, LanRuntime>();
const tails = new Map<string, Promise<void>>();
let shuttingDown = false;
let attached = false;
let spawner: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess = spawn;
let cliRunner: ((rpcPort: number) => Promise<string>) | null = null;
let gameStatus = (instanceId: string): string => processManager.getStatus(instanceId);
let listenPortAllocator: (exclude: readonly number[]) => Promise<number> = allocateListenPort;
// 全模块单调递增：停止会删掉 runtimes 条目，若从旧条目推算会恒为 1，旧探测循环的代次守卫就失效。
let nextGeneration = 0;

interface LanProbeTiming {
  /** 前若干次探测的间隔 */
  fastMs: number;
  /** 之后的探测间隔 */
  slowMs: number;
  /** 快速探测次数，用完后提示仍在等待地址 */
  fastAttempts: number;
}

const DEFAULT_PROBE_TIMING: LanProbeTiming = { fastMs: 1000, slowMs: 5000, fastAttempts: 15 };
let probeTiming: LanProbeTiming = DEFAULT_PROBE_TIMING;

export function setLanSpawnerForTests(
  next: ((command: string, args: readonly string[], options: SpawnOptions) => ChildProcess) | null,
): void {
  spawner = next ?? spawn;
}

export function setLanCliRunnerForTests(next: ((rpcPort: number) => Promise<string>) | null): void {
  cliRunner = next;
}

export function setLanGameStatusForTests(next: ((instanceId: string) => string) | null): void {
  gameStatus = next ?? ((instanceId) => processManager.getStatus(instanceId));
}

export function setLanListenPortAllocatorForTests(
  next: ((exclude: readonly number[]) => Promise<number>) | null,
): void {
  listenPortAllocator = next ?? allocateListenPort;
}

/** 测试用：缩短地址探测间隔，传 null 恢复默认。 */
export function setLanProbeIntervalsForTests(next: LanProbeTiming | null): void {
  probeTiming = next ?? DEFAULT_PROBE_TIMING;
}

export function resetLanRuntimeForTests(): void {
  shuttingDown = false;
  runtimes.clear();
  tails.clear();
  spawner = spawn;
  cliRunner = null;
  gameStatus = (instanceId) => processManager.getStatus(instanceId);
  listenPortAllocator = allocateListenPort;
  probeTiming = DEFAULT_PROBE_TIMING;
}

export function attachLanLifecycle(): void {
  if (attached) return;
  attached = true;
  processManager.on('status', (instanceId: string, status: string) => {
    if (shuttingDown) return;
    if (status === 'running') {
      void enqueue(instanceId, () => syncInstanceLan(instanceId)).catch((error: unknown) => {
        recordLanFailure(instanceId, error);
      });
      return;
    }
    if (status === 'stopping' || status === 'stopped' || status === 'crashed') {
      void enqueue(instanceId, () => stopInstanceLan(instanceId)).catch(() => undefined);
    }
  });
}

export async function shutdownLan(): Promise<void> {
  shuttingDown = true;
  await Promise.all([...runtimes.keys()].map((instanceId) => enqueue(instanceId, () => stopInstanceLan(instanceId))));
}

export async function syncEnabledLans(): Promise<void> {
  await Promise.all(listEnabledLanInstanceIds().map((instanceId) => (
    enqueue(instanceId, () => syncInstanceLan(instanceId)).catch((error: unknown) => {
      recordLanFailure(instanceId, error);
    })
  )));
}

export function describeInstanceLan(instanceId: string): InstanceLan {
  // lanInstalled 要做多次文件检查，一次描述里只算一遍。
  const installed = lanInstalled();
  const row = getInstanceLanRow(instanceId);
  const bind = readBind(instanceId);
  const runtime = runtimes.get(instanceId);
  const enabled = row?.enabled === 1;
  let status: LanStatus = 'disabled';
  if (enabled) status = runtime?.status ?? 'stopped';
  const virtualIp = enabled && bind && !bind.serverIpBlocked ? lanVirtualIp(row.octet) : null;
  let detail: PanelMessage | null = bind?.error ?? null;
  if (!detail && bind?.serverIpBlocked) detail = { key: 'server.lan.serverIpBlocked' };
  if (!detail && enabled && gameStatus(instanceId) !== 'running' && status !== 'error') {
    detail = { key: 'server.lan.notRunning' };
  }
  if (!detail && enabled && status !== 'error' && status !== 'running' && bind && !bind.error && !bind.serverIpBlocked) {
    if (!lanPlatformSupported()) detail = { key: 'server.lan.platformUnsupported' };
    else if (!installed) detail = { key: 'server.lan.clientMissing' };
  }
  if (!detail) detail = runtime?.detail ?? null;
  const confirmed = status === 'running' && runtime?.virtualIp === virtualIp;
  return {
    instanceId,
    enabled,
    status,
    localPort: bind?.port ?? null,
    virtualIp: confirmed ? virtualIp : null,
    joinAddress: confirmed && virtualIp && bind ? `${virtualIp}:${bind.port}` : null,
    serverIpBlocked: bind?.serverIpBlocked ?? false,
    runtimeInstalled: installed,
    peers: row?.peers ?? [],
    useSharedPeers: row?.useSharedPeers ?? true,
    sharedPeers: [...LAN_SHARED_PEERS],
    listenPort: runtime?.child ? runtime.listenPort : null,
    detail,
    warning: enabled ? runtime?.warning ?? null : null,
  };
}

export function renderLanFriendConfig(instanceId: string): string {
  const row = getInstanceLanRow(instanceId);
  if (!row || row.enabled !== 1) throw new PanelError('server.lan.notEnabled');
  const bind = readBind(instanceId);
  if (!bind) throw new PanelError('server.lan.localPortInvalid');
  if (bind.error) throw new PanelError(bind.error.key);
  if (bind.serverIpBlocked) throw new PanelError('server.lan.serverIpBlocked');
  return renderFriendInstructions(lanRenderInput(row, bind.port, null));
}

export async function syncInstanceLan(instanceId: string): Promise<InstanceLan> {
  if (shuttingDown) return describeInstanceLan(instanceId);
  const row = getInstanceLanRow(instanceId);
  if (!row || row.enabled !== 1 || gameStatus(instanceId) !== 'running') {
    await stopInstanceLan(instanceId);
    return describeInstanceLan(instanceId);
  }
  const bind = readBind(instanceId);
  if (!bind || bind.error || bind.serverIpBlocked) {
    await stopInstanceLan(instanceId);
    return describeInstanceLan(instanceId);
  }
  if (!lanPlatformSupported() || !lanInstalled()) return describeInstanceLan(instanceId);
  // 比较用的配置键不含监听端口：端口每次启动重新分配，不能因此反复重启。
  const keyInput = lanRenderInput(row, bind.port, null);
  const configHash = renderLanToml(keyInput);
  const current = runtimes.get(instanceId);
  if (
    current
    && current.configHash === configHash
    && current.child
    && current.child.exitCode === null
    && (current.status === 'running' || current.status === 'starting')
  ) {
    return describeInstanceLan(instanceId);
  }
  await stopInstanceLan(instanceId);
  if (shuttingDown || gameStatus(instanceId) !== 'running') return describeInstanceLan(instanceId);
  const generation = ++nextGeneration;
  const rpcPort = await allocateLoopbackPort();
  const listenPort = await listenPortAllocator([rpcPort, bind.port, config.port]);
  const input = { ...keyInput, listenPort };
  const cwd = lanWorkDir(instanceId);
  writeLanFile(input, instanceId);
  const runtime: LanRuntime = {
    status: 'starting',
    detail: null,
    child: null,
    generation,
    configHash,
    rpcPort,
    virtualIp: null,
    listenPort,
    firewallOpened: false,
    warning: null,
  };
  runtimes.set(instanceId, runtime);
  const firewall = await openLanFirewall({
    instanceId,
    virtualIp: lanVirtualIp(row.octet),
    gamePort: bind.port,
    listenPort,
  });
  if (runtimes.get(instanceId)?.generation !== generation) {
    // 等防火墙期间已被停止或替换：本代加上的规则由自己收回。
    if (firewall === 'applied' && !runtimes.has(instanceId)) await closeLanFirewall(instanceId);
    return describeInstanceLan(instanceId);
  }
  runtime.firewallOpened = firewall === 'applied';
  if (firewall === 'failed') runtime.warning = { key: 'server.lan.firewallFailed' };
  let child: ChildProcess;
  try {
    child = spawner(lanCorePath(), lanCoreArgs(rpcPort), {
      cwd,
      env: getMinecraftChildEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    runtime.status = 'error';
    runtime.detail = { key: 'server.lan.startFailed' };
    throw new PanelError('server.lan.startFailed', undefined, { cause: error });
  }
  if (runtimes.get(instanceId)?.generation !== generation) {
    child.kill();
    return describeInstanceLan(instanceId);
  }
  runtime.child = child;
  const consume = (chunk: Buffer) => {
    if (runtimes.get(instanceId)?.generation !== generation) return;
    const detail = lanFailureDetail(chunk.toString('utf8'), row.networkSecret);
    if (!detail) return;
    runtime.status = 'error';
    runtime.detail = detail;
  };
  child.stdout?.on('data', consume);
  child.stderr?.on('data', consume);
  child.stdout?.on('error', () => {});
  child.stderr?.on('error', () => {});
  child.on('error', () => {
    if (runtimes.get(instanceId)?.generation !== generation) return;
    runtime.status = 'error';
    runtime.detail = { key: 'server.lan.startFailed' };
    runtime.child = null;
  });
  child.on('exit', () => {
    if (runtimes.get(instanceId)?.generation !== generation) return;
    if (runtime.status !== 'error') runtime.detail = { key: 'server.lan.exited' };
    runtime.status = 'error';
    runtime.child = null;
  });
  if (!await probeAddress(instanceId, generation, rpcPort, lanVirtualIp(row.octet))) {
    watchAddress(instanceId, generation, rpcPort, lanVirtualIp(row.octet));
  }
  return describeInstanceLan(instanceId);
}

export async function syncInstanceLanQueued(instanceId: string): Promise<InstanceLan> {
  let described: InstanceLan | undefined;
  await enqueue(instanceId, async () => {
    described = await syncInstanceLan(instanceId);
  });
  return described ?? describeInstanceLan(instanceId);
}

export async function removeInstanceLan(instanceId: string): Promise<void> {
  await enqueue(instanceId, async () => {
    await stopInstanceLan(instanceId);
    removeLanFiles(instanceId);
  });
}

async function stopInstanceLan(instanceId: string): Promise<void> {
  const runtime = runtimes.get(instanceId);
  if (!runtime) return;
  // 删除条目即让旧代次失效：所有回调和探测循环都按 runtimes 里当前条目的代次比对。
  const child = runtime.child;
  const firewallOpened = runtime.firewallOpened;
  runtimes.delete(instanceId);
  if (child && child.exitCode === null) {
    // 先挂退出监听再发信号，避免同步退出时错过事件、白等 2 秒。
    const exited = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
        resolve();
      }, 2000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    child.kill();
    await exited;
  }
  if (firewallOpened) await closeLanFirewall(instanceId);
}

async function probeAddress(
  instanceId: string,
  generation: number,
  rpcPort: number,
  expected: string,
): Promise<boolean> {
  if (runtimes.get(instanceId)?.generation !== generation) return true;
  try {
    const reported = virtualIpFromCli(await readCli(rpcPort));
    const runtime = runtimes.get(instanceId);
    if (!runtime || runtime.generation !== generation) return true;
    // 等命令行返回期间客户端可能已报错或退出，不能再把状态改回运行中。
    if (runtime.status === 'error') return true;
    if (reported === expected) {
      runtime.virtualIp = reported;
      runtime.status = 'running';
      runtime.detail = null;
      return true;
    }
    if (reported) {
      runtime.status = 'error';
      runtime.detail = { key: 'server.lan.addressMismatch' };
      runtime.child?.kill();
      return true;
    }
  } catch {
    // 客户端刚起来时管理端口可能还没打开。
  }
  return false;
}

/** 只要本代客户端还活着就一直等地址：前几次密集探测，之后放慢；超时只提示等待，不放弃。 */
function watchAddress(instanceId: string, generation: number, rpcPort: number, expected: string): void {
  void (async () => {
    for (let attempt = 1; ; attempt += 1) {
      const timing = probeTiming;
      const delay = attempt <= timing.fastAttempts ? timing.fastMs : timing.slowMs;
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (!watchingCurrent(instanceId, generation)) return;
      if (await probeAddress(instanceId, generation, rpcPort, expected)) return;
      if (attempt === timing.fastAttempts) {
        if (!watchingCurrent(instanceId, generation)) return;
        const runtime = runtimes.get(instanceId)!;
        runtime.detail = { key: 'server.lan.waitingForAddress' };
      }
    }
  })();
}

/** 探测循环继续的条件：仍是同一代、客户端进程存活、未进入错误状态。 */
function watchingCurrent(instanceId: string, generation: number): boolean {
  const runtime = runtimes.get(instanceId);
  return Boolean(
    runtime
    && runtime.generation === generation
    && runtime.child
    && runtime.child.exitCode === null
    && runtime.status !== 'error',
  );
}

async function readCli(rpcPort: number): Promise<string> {
  if (cliRunner) return cliRunner(rpcPort);
  return new Promise((resolve, reject) => {
    const child = spawn(lanCliPath(), ['--rpc-portal', `127.0.0.1:${rpcPort}`, '-o', 'json', 'node'], {
      env: getMinecraftChildEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('easytier-cli timed out'));
    }, 3000);
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error('easytier-cli failed'));
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

function virtualIpFromCli(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const record = parsed !== null && typeof parsed === 'object' ? parsed as { ipv4_addr?: unknown; result?: { ipv4_addr?: unknown } } : null;
  const value = record?.ipv4_addr ?? record?.result?.ipv4_addr;
  if (typeof value !== 'string') return null;
  const ip = value.split('/')[0] ?? '';
  return net.isIP(ip) === 4 ? ip : null;
}

function readBind(instanceId: string): { port: number; serverIpBlocked: boolean; error: PanelMessage | null } | null {
  let properties: Record<string, string>;
  try {
    properties = readServerProperties(instanceId);
  } catch {
    return null;
  }
  const port = Number((properties['server-port'] ?? '25565').trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { port: 0, serverIpBlocked: false, error: { key: 'server.lan.localPortInvalid' } };
  }
  if (port === config.port) {
    return { port, serverIpBlocked: false, error: { key: 'server.lan.localPortIsPanel' } };
  }
  return { port, serverIpBlocked: serverIpBlocksLan(properties['server-ip']), error: null };
}

/**
 * 给 EasyTier 监听挑一个 TCP 与 UDP 都空闲的端口。只在回环地址上试绑，
 * 不在 0.0.0.0 上监听，避免 Windows 为面板自己的 node.exe 弹出防火墙提示。
 * 漏掉的冲突由 EasyTier 启动失败时的输出识别（listenPortUnavailable）。
 */
async function allocateListenPort(exclude: readonly number[]): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await allocateLoopbackPort();
    if (exclude.includes(port)) continue;
    if (await udpPortFree(port)) return port;
  }
  throw new PanelError('server.lan.listenPortUnavailable');
}

function udpPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', () => {
      try {
        socket.close();
      } catch {
        // 绑定失败的套接字可能已不在运行，忽略
      }
      resolve(false);
    });
    socket.bind({ port, address: '127.0.0.1', exclusive: true }, () => {
      socket.close(() => resolve(true));
    });
  });
}

function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function enqueue(instanceId: string, job: () => Promise<unknown>): Promise<void> {
  const previous = tails.get(instanceId) ?? Promise.resolve();
  const next = previous.then(job, job).then(() => undefined);
  tails.set(instanceId, next);
  return next;
}

function recordLanFailure(instanceId: string, error: unknown): void {
  if (shuttingDown) return;
  const current = runtimes.get(instanceId);
  if (current?.child && current.child.exitCode === null) return;
  const detail: PanelMessage = error instanceof PanelError
    ? error.toPanelMessage()
    : { key: 'server.lan.startFailed' };
  runtimes.set(instanceId, {
    status: 'error',
    detail,
    child: null,
    generation: current?.generation ?? 0,
    configHash: current?.configHash ?? '',
    rpcPort: current?.rpcPort ?? 0,
    virtualIp: null,
    listenPort: null,
    // 保留标记，之后停止时仍会收回本代加上的防火墙规则。
    firewallOpened: current?.firewallOpened ?? false,
    warning: null,
  });
}
