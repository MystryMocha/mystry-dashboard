import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import path from 'node:path';
import type { InstanceTunnel, PanelMessage, TunnelStatus } from '@mystry/shared';
import { config } from '../config.js';
import { getMinecraftChildEnv } from '../utils/child-env.js';
import { PanelError } from '../utils/errors.js';
import { gamePortFromProperties, readServerProperties } from './config-service.js';
import {
  formatJoinAddress,
  renderServerConfig,
  renderVisitorConfig,
  serverIpBlocksTunnel,
} from './frp-config.js';
import { processManager } from './process-manager.js';
import { frpcBinaryPath, frpcInstalled, frpcPlatformSupported } from './frp-runtime.js';
import {
  getInstanceTunnelRow,
  listEnabledTunnelInstanceIds,
  removeTunnelFiles,
  renderInputForTunnel,
  writeTunnelFiles,
} from './frp-service.js';

interface TunnelRuntime {
  status: Exclude<TunnelStatus, 'disabled' | 'stopped'>;
  detail: PanelMessage | null;
  child: ChildProcess | null;
  generation: number;
  configHash: string;
  pendingLine: string;
}

const runtimes = new Map<string, TunnelRuntime>();
const tails = new Map<string, Promise<void>>();
// 全局单调递增的代号。stopInstanceTunnel 会删掉 runtimes 条目，不能再从旧条目推算下一代，否则代号恒为 1。
let nextGeneration = 0;
let shuttingDown = false;
let attached = false;
let spawner: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess = spawn;

export function setFrpcSpawnerForTests(
  next: ((command: string, args: readonly string[], options: SpawnOptions) => ChildProcess) | null,
): void {
  spawner = next ?? spawn;
}

let gameStatus = (instanceId: string): string => processManager.getStatus(instanceId);

export function setFrpGameStatusForTests(next: ((instanceId: string) => string) | null): void {
  gameStatus = next ?? ((instanceId) => processManager.getStatus(instanceId));
}

export function resetFrpRuntimeForTests(): void {
  shuttingDown = false;
  runtimes.clear();
  tails.clear();
  spawner = spawn;
  gameStatus = (instanceId) => processManager.getStatus(instanceId);
}

export function attachFrpLifecycle(): void {
  if (attached) return;
  attached = true;
  processManager.on('status', (instanceId: string, status: string) => {
    if (shuttingDown) return;
    if (status === 'running') {
      // 后台同步会在未安装客户端、端口非法等普通情况下抛错。这里必须接住，否则 Node 22 会因未处理的 rejection 退出整个面板。
      void enqueue(instanceId, () => syncInstanceTunnel(instanceId)).catch((error: unknown) => {
        recordTunnelFailure(instanceId, error);
      });
      return;
    }
    if (status === 'stopping' || status === 'stopped' || status === 'crashed') {
      // 停止失败同样不能变成未处理的 rejection。游戏已经离开运行态，不再另记一条隧道错误。
      void enqueue(instanceId, () => stopInstanceTunnel(instanceId)).catch(() => undefined);
    }
  });
}

export async function shutdownFrp(): Promise<void> {
  shuttingDown = true;
  await Promise.all([...runtimes.keys()].map((instanceId) => enqueue(instanceId, () => stopInstanceTunnel(instanceId))));
}

function enqueue(instanceId: string, job: () => Promise<unknown>): Promise<void> {
  const previous = tails.get(instanceId) ?? Promise.resolve();
  const next = previous.then(job, job).then(() => undefined);
  tails.set(instanceId, next);
  return next;
}
function recordTunnelFailure(instanceId: string, error: unknown): void {
  if (shuttingDown) return;
  const current = runtimes.get(instanceId);
  if (current?.child && current.child.exitCode === null) return;
  const detail: PanelMessage = error instanceof PanelError
    ? error.toPanelMessage()
    : { key: 'server.frp.startFailed' };
  runtimes.set(instanceId, {
    status: 'error',
    detail,
    child: null,
    generation: current?.generation ?? 0,
    configHash: current?.configHash ?? '',
    pendingLine: '',
  });
}

/** 客户端装好后把已经启用的隧道接上。失败记到状态里，不往外抛。 */
export async function syncEnabledTunnels(): Promise<void> {
  await Promise.all(listEnabledTunnelInstanceIds().map((instanceId) => (
    enqueue(instanceId, () => syncInstanceTunnel(instanceId)).catch((error: unknown) => {
      recordTunnelFailure(instanceId, error);
    })
  )));
}

function gameBind(instanceId: string): { port: number; serverIpBlocked: boolean } {
  const properties = readServerProperties(instanceId);
  const port = gamePortFromProperties(properties);
  if (port === null) throw new PanelError('server.frp.localPortInvalid');
  if (port === config.port) throw new PanelError('server.frp.localPortIsPanel');
  return { port, serverIpBlocked: serverIpBlocksTunnel(properties['server-ip']) };
}

export function describeInstanceTunnel(instanceId: string): InstanceTunnel {
  let localPort = 25565;
  let serverIpBlocked = false;
  let bindError: PanelMessage | null = null;
  try {
    const bind = gameBind(instanceId);
    localPort = bind.port;
    serverIpBlocked = bind.serverIpBlocked;
  } catch (error) {
    if (error instanceof PanelError) bindError = error.toPanelMessage();
    else throw error;
  }
  const row = getInstanceTunnelRow(instanceId);
  const runtime = runtimes.get(instanceId);
  const input = row && !bindError ? renderInputForTunnel(instanceId, localPort) : null;
  const enabled = row?.enabled === 1;
  let status: TunnelStatus = 'disabled';
  if (enabled) status = runtime?.status ?? 'stopped';
  if (enabled && (serverIpBlocked || bindError)) status = 'error';
  const waitingForGame = enabled && !serverIpBlocked && !bindError && !runtime
    && gameStatus(instanceId) !== 'running';
  const joinAddress = enabled && input && !serverIpBlocked && !bindError
    ? input.mode === 'public'
      ? input.remotePort === null ? null : formatJoinAddress(input.visitHost, input.remotePort)
      : formatJoinAddress('127.0.0.1', input.visitorBindPort)
    : null;
  let detail: PanelMessage | null = bindError;
  if (!detail && serverIpBlocked) detail = { key: 'server.frp.serverIpBlocked' };
  if (!detail && waitingForGame) detail = { key: 'server.frp.notRunning' };
  if (!detail) detail = runtime?.detail ?? null;
  return {
    instanceId,
    enabled,
    endpointId: row?.endpoint_id ?? null,
    mode: row?.mode === 'stcp' || row?.mode === 'xtcp' ? row.mode : 'public',
    remotePort: row?.remote_port ?? null,
    visitorBindPort: row?.visitor_bind_port ?? 25565,
    localPort,
    status,
    joinAddress,
    serverIpBlocked,
    runtimeInstalled: frpcInstalled(),
    detail,
  };
}

export function renderFriendConfig(instanceId: string): string {
  const bind = gameBind(instanceId);
  if (bind.serverIpBlocked) throw new PanelError('server.frp.serverIpBlocked');
  const input = renderInputForTunnel(instanceId, bind.port);
  if (!input || input.mode === 'public') throw new PanelError('server.frp.visitorUnavailable');
  return renderVisitorConfig(input);
}

export async function syncInstanceTunnel(instanceId: string): Promise<InstanceTunnel> {
  if (shuttingDown) return describeInstanceTunnel(instanceId);
  const row = getInstanceTunnelRow(instanceId);
  if (!row || row.enabled !== 1 || gameStatus(instanceId) !== 'running') {
    await stopInstanceTunnel(instanceId);
    return describeInstanceTunnel(instanceId);
  }
  const bind = gameBind(instanceId);
  if (bind.serverIpBlocked) {
    await stopInstanceTunnel(instanceId);
    return describeInstanceTunnel(instanceId);
  }
  const input = renderInputForTunnel(instanceId, bind.port);
  if (!input) {
    await stopInstanceTunnel(instanceId);
    return describeInstanceTunnel(instanceId);
  }
  if (!frpcPlatformSupported()) throw new PanelError('server.frp.platformUnsupported');
  if (!frpcInstalled()) throw new PanelError('server.frp.clientMissing');
  const toml = renderServerConfig(input);
  const configHash = `${toml}\n${input.token}`;
  const current = runtimes.get(instanceId);
  if (
    current
    && current.configHash === configHash
    && current.child
    && current.child.exitCode === null
    && (current.status === 'running' || current.status === 'starting')
  ) {
    return describeInstanceTunnel(instanceId);
  }
  await stopInstanceTunnel(instanceId);
  if (shuttingDown || gameStatus(instanceId) !== 'running') return describeInstanceTunnel(instanceId);
  const generation = ++nextGeneration;
  writeTunnelFiles(input, toml);
  const runtime: TunnelRuntime = {
    status: 'starting',
    detail: null,
    child: null,
    generation,
    configHash,
    pendingLine: '',
  };
  runtimes.set(instanceId, runtime);
  let child: ChildProcess;
  try {
    child = spawner(frpcBinaryPath(), ['-c', 'frpc.toml'], {
      cwd: path.dirname(input.tokenPath),
      env: getMinecraftChildEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    runtime.status = 'error';
    runtime.detail = { key: 'server.frp.startFailed' };
    throw new PanelError('server.frp.startFailed', undefined, { cause: error });
  }
  if (runtimes.get(instanceId)?.generation !== generation) {
    child.kill();
    return describeInstanceTunnel(instanceId);
  }
  runtime.child = child;
  const consume = (chunk: Buffer) => {
    if (runtimes.get(instanceId)?.generation !== generation) return;
    runtime.pendingLine = (runtime.pendingLine + chunk.toString('utf8')).slice(-4096);
    const lines = runtime.pendingLine.split(/\r?\n/);
    runtime.pendingLine = lines.pop() ?? '';
    for (const line of lines) noteFrpcLine(runtime, line, input.token, input.secretKey);
  };
  child.stdout?.on('data', consume);
  child.stderr?.on('data', consume);
  child.stdout?.on('error', () => {});
  child.stderr?.on('error', () => {});
  child.on('error', () => {
    if (runtimes.get(instanceId)?.generation !== generation) return;
    runtime.status = 'error';
    runtime.detail = { key: 'server.frp.startFailed' };
    runtime.child = null;
  });
  child.on('exit', () => {
    if (runtimes.get(instanceId)?.generation !== generation) return;
    if (runtime.status !== 'error') runtime.detail = { key: 'server.frp.exited' };
    runtime.status = 'error';
    runtime.child = null;
  });
  return describeInstanceTunnel(instanceId);
}

function noteFrpcLine(runtime: TunnelRuntime, line: string, token: string, secret: string | null): void {
  if ((token.length > 0 && line.includes(token)) || (secret && line.includes(secret))) return;
  if (/login to the server failed|authorization failed/i.test(line)) {
    runtime.status = 'error';
    runtime.detail = { key: 'server.frp.loginFailed' };
    return;
  }
  if (/port already used|port is already used|already in use/i.test(line)) {
    runtime.status = 'error';
    runtime.detail = { key: 'server.frp.proxyFailed' };
    return;
  }
  if (/start proxy success/i.test(line)) {
    runtime.status = 'running';
    runtime.detail = null;
  }
}

export async function stopInstanceTunnel(instanceId: string): Promise<void> {
  const runtime = runtimes.get(instanceId);
  if (!runtime) return;
  // 删除条目后，旧子进程的回调按闭包里的代号比对 runtimes，自然失效。
  const child = runtime.child;
  runtimes.delete(instanceId);
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      resolve();
    }, 2000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function removeInstanceFrp(instanceId: string): Promise<void> {
  await enqueue(instanceId, async () => {
    await stopInstanceTunnel(instanceId);
    removeTunnelFiles(instanceId);
  });
}

export async function syncInstanceTunnelQueued(instanceId: string): Promise<InstanceTunnel> {
  let described: InstanceTunnel | undefined;
  await enqueue(instanceId, async () => {
    described = await syncInstanceTunnel(instanceId);
  });
  return described ?? describeInstanceTunnel(instanceId);
}
