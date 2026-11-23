import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomInt } from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { InstanceLan, LanStatus, PanelMessage } from '@mystry/shared';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { getMinecraftChildEnv } from '../utils/child-env.js';
import { PanelError } from '../utils/errors.js';
import { gamePortFromProperties, readServerProperties } from './config-service.js';
import { getInstanceRow } from './instance-service.js';
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
import { closeLanFirewall, lanFirewallApplies, openLanFirewall } from './lan-firewall.js';
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
  /** EasyTier listen port (same for TCP/UDP), for direct connections without hole punching. */
  listenPort: number | null;
  /** Whether this generation has added Windows firewall rules; used to delete them on stop. */
  firewallOpened: boolean;
  warning: PanelMessage | null;
}

const INSTANCE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const runtimes = new Map<string, LanRuntime>();
const tails = new Map<string, Promise<void>>();
/**
 * Instances whose firewall rules this process has confirmed deleted. After the panel crashes or is killed and restarts there is no runtime state, so whether rules remain has to be treated as unknown:
 * an instance that is not in here and is owned by this panel (it has a virtual LAN record or a work directory) gets one delete by name on stop, shutdown, delete or the startup sweep.
 * Removed before every rule add; a DATA_DIR has only one panel process, so the confirmation can be trusted within this process.
 */
const firewallCleared = new Set<string>();
let shuttingDown = false;
let attached = false;
let spawner: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess = spawn;
let cliRunner: ((rpcPort: number) => Promise<string>) | null = null;
let gameStatus = (instanceId: string): string => processManager.getStatus(instanceId);
let listenPortAllocator: (exclude: readonly number[]) => Promise<number> = allocateListenPort;
// Monotonic across the module: stop deletes the runtimes entry, and deriving from the old entry would always give 1, which would defeat the generation guard of old probe loops.
let nextGeneration = 0;

interface LanProbeTiming {
  /** Interval of the first few probes */
  fastMs: number;
  /** Probe interval after that */
  slowMs: number;
  /** Number of fast probes; once used up, a notice says it is still waiting for an address */
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

/** For tests: shortens the address probe intervals; pass null to restore the defaults. */
export function setLanProbeIntervalsForTests(next: LanProbeTiming | null): void {
  probeTiming = next ?? DEFAULT_PROBE_TIMING;
}

export function resetLanRuntimeForTests(): void {
  shuttingDown = false;
  runtimes.clear();
  tails.clear();
  firewallCleared.clear();
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
  // Not awaited: each netsh call takes up to 10 seconds and must not slow down panel startup; ordering is guaranteed by the per-instance queues.
  void sweepLanFirewall().catch(() => undefined);
}

/**
 * Startup sweep: when the panel crashes or is killed, rules stay in the system, and after a restart there is no matching runtime state.
 * Deletion by name happens only for instance IDs owned by this panel: those with a virtual LAN record in the database (including disabled ones),
 * and those that still have a work directory under DATA_DIR/lan (the instance was deleted but its rules could not be deleted last time). Not everything with the prefix
 * MystryDashboard-LAN-* is deleted: a panel using another DATA_DIR may be using its own rules.
 * Queued synchronously into each instance's queue, ahead of any later start; when its turn comes and runtime state already exists it is skipped (start already deleted before adding).
 */
export async function sweepLanFirewall(): Promise<void> {
  if (!lanFirewallApplies()) return;
  const rows = getDb().prepare('SELECT instance_id FROM instance_lans').all() as Array<{ instance_id: string }>;
  const ids = new Set([...rows.map((row) => row.instance_id), ...listLanWorkDirIds()]);
  await Promise.all([...ids].map((instanceId) => enqueue(instanceId, async () => {
    if (!await removeLeftoverLanFirewall(instanceId)) return;
    // The instance is deleted and only the work directory is left: once the rules are confirmed deleted, the directory (including the network secret) is removed too, so it is not swept on every later start.
    if (!runtimes.has(instanceId) && !getInstanceRow(instanceId)) removeLanFiles(instanceId);
  })));
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
  // lanInstalled does several file checks, so it is computed only once per description.
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
  // The config key used for comparison excludes the listen port: the port is reallocated on every start and must not cause repeated restarts.
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
  // Once a rule add is attempted, the earlier "confirmed deleted" conclusion no longer holds (a half-finished add that was rolled back may not have rolled back cleanly either).
  firewallCleared.delete(instanceId);
  const firewall = await openLanFirewall({
    instanceId,
    virtualIp: lanVirtualIp(row.octet),
    gamePort: bind.port,
    listenPort,
    corePath: lanFirewallProgramPath(),
  });
  if (runtimes.get(instanceId)?.generation !== generation) {
    // Stopped or replaced while waiting for the firewall: this generation takes back the rules it added.
    if (firewall === 'applied' && !runtimes.has(instanceId)) await removeLanFirewall(instanceId);
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
    // When an instance is deleted its virtual LAN record is already cascade-deleted, so a leftover work directory is what shows the ID is owned by this panel (arbitrary IDs do not trigger netsh).
    // When netsh could not run, do not retry right away (each attempt waits up to 10 seconds); keep the directory so the next startup sweep deletes by it.
    const hadRuntime = runtimes.has(instanceId);
    if (!await stopInstanceLan(instanceId)) return;
    // With runtime state, stop deletes only by this generation's flag; whether the rollback after a failed add was clean is uncertain, so delete once more here.
    if (hadRuntime && !await removeLeftoverLanFirewall(instanceId)) return;
    removeLanFiles(instanceId);
  });
}

/** false means netsh could not run while deleting rules, so it is unknown whether they are still there. */
async function stopInstanceLan(instanceId: string): Promise<boolean> {
  const runtime = runtimes.get(instanceId);
  // No runtime state does not mean no rules: the panel may have been killed last time.
  if (!runtime) return removeLeftoverLanFirewall(instanceId);
  // Deleting the entry invalidates the old generation: every callback and probe loop compares against the generation of the current entry in runtimes.
  const child = runtime.child;
  const firewallOpened = runtime.firewallOpened;
  runtimes.delete(instanceId);
  if (child && child.exitCode === null) {
    // Attach the exit listener before sending the signal, so a synchronous exit does not miss the event and wait 2 seconds for nothing.
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
  if (firewallOpened) return removeLanFirewall(instanceId);
  // When adding rules fails, openLanFirewall has already rolled back, so nothing is deleted here; whether the rollback was clean is uncertain, and it is deleted again later when there is no runtime state.
  return true;
}

/** Deletes rules by name and records the result: it only counts as confirmed deleted when netsh ran to completion; false means it could not run, it is unknown whether the rules are still there, and it is retried later. */
async function removeLanFirewall(instanceId: string): Promise<boolean> {
  const done = await closeLanFirewall(instanceId);
  if (done) firewallCleared.add(instanceId);
  return done;
}

/**
 * Deletes possibly leftover rules when there is no runtime state; false means netsh could not run.
 * Rules are only ever added after the work directory is written, for an instance with a virtual LAN record, so an ID with neither is not owned by this panel and netsh is not called;
 * it is not called either when this process has confirmed deletion or runtime state exists (start already deleted before adding), so netsh is not launched on every stop of every instance.
 */
async function removeLeftoverLanFirewall(instanceId: string): Promise<boolean> {
  if (!lanFirewallApplies() || firewallCleared.has(instanceId) || runtimes.has(instanceId)) return true;
  if (!getInstanceLanRow(instanceId) && !lanWorkDirExists(instanceId)) return true;
  return removeLanFirewall(instanceId);
}

function lanWorkDirExists(instanceId: string): boolean {
  try {
    return fs.statSync(lanWorkDir(instanceId)).isDirectory();
  } catch {
    // Invalid ID (lanWorkDir throws) or the directory does not exist
    return false;
  }
}

/** Names of instance work directories under DATA_DIR/lan; only regular directories in valid instance ID form are accepted. */
function listLanWorkDirIds(): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(config.dataDir, 'lan'), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isDirectory() && INSTANCE_ID.test(entry.name)).map((entry) => entry.name);
}

/**
 * The program the listen port rules are restricted to is the lanCorePath() actually started, which comes only from the panel's own runtime directory.
 * subst drives and mapped drives are valid only in the current user session and the firewall service may not recognize them, so the path is resolved to the real path first (which also expands 8.3 short names);
 * when resolution fails, the original launch path is used.
 */
function lanFirewallProgramPath(): string {
  const corePath = lanCorePath();
  try {
    return fs.realpathSync.native(corePath);
  } catch {
    return corePath;
  }
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
    // While waiting for the CLI to return, the client may already have failed or exited, so the status must not be set back to running.
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
    // The management port may not be open yet right after the client starts.
  }
  return false;
}

/** Keeps waiting for an address as long as this generation's client is alive: dense probing for the first few attempts, then slower; a timeout only shows a waiting notice and does not give up. */
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

/** Condition for the probe loop to continue: still the same generation, the client process alive, and not in the error state. */
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
  const port = gamePortFromProperties(properties);
  if (port === null) {
    return { port: 0, serverIpBlocked: false, error: { key: 'server.lan.localPortInvalid' } };
  }
  if (port === config.port) {
    return { port, serverIpBlocked: false, error: { key: 'server.lan.localPortIsPanel' } };
  }
  return { port, serverIpBlocked: serverIpBlocksLan(properties['server-ip']), error: null };
}

/** Loopback trial binds behind allocateListenPort; tests pass their own so the outcome does not depend on which ports the machine refuses. */
export interface ListenPortProbes {
  /** pickTcp and pickUdp: a port the OS assigns for that protocol, so never one the OS keeps back for it. */
  pickTcp: () => Promise<number>;
  pickUdp: () => Promise<number>;
  tcpFree: (port: number) => Promise<boolean>;
  udpFree: (port: number) => Promise<boolean>;
  /** A candidate from the dynamic range, tried only after the OS-assigned candidates. */
  randomPort: () => number;
}

export const loopbackListenPortProbes: ListenPortProbes = {
  pickTcp: allocateLoopbackPort,
  pickUdp: allocateLoopbackUdpPort,
  tcpFree: tcpPortFree,
  udpFree: udpPortFree,
  randomPort: () => randomInt(49152, 65536),
};

const OS_ASSIGNED_ATTEMPTS = 20;
const RANDOM_ATTEMPTS = 20;

/**
 * Picks a port free on both TCP and UDP for EasyTier to listen on. Trial binds happen only on the loopback address,
 * never on 0.0.0.0, so Windows does not show a firewall prompt for the panel's own node.exe.
 * TCP and UDP have separate ephemeral counters and Windows hands ports out in sequence, so taking only TCP ports and checking them
 * for UDP covers just the numbers right after the TCP counter: when a run of those cannot be bound for UDP, every attempt fails although
 * most ports are free. Candidates therefore alternate between the two counters, and random ports come last for when both sit in such a run.
 * Conflicts this misses are recognized from EasyTier's output when it fails to start (listenPortUnavailable).
 */
export async function allocateListenPort(
  exclude: readonly number[],
  probes: ListenPortProbes = loopbackListenPortProbes,
): Promise<number> {
  let lastError: unknown;
  for (let attempt = 0; attempt < OS_ASSIGNED_ATTEMPTS + RANDOM_ATTEMPTS; attempt += 1) {
    try {
      let port: number;
      if (attempt >= OS_ASSIGNED_ATTEMPTS) port = probes.randomPort();
      else if (attempt % 2 === 0) port = await probes.pickUdp();
      else port = await probes.pickTcp();
      if (exclude.includes(port)) continue;
      if (await probes.tcpFree(port) && await probes.udpFree(port)) return port;
    } catch (error) {
      // A refused bind(0) (no ports or handles left) counts as a failed attempt; the user gets the same message.
      lastError = error;
    }
  }
  throw new PanelError('server.lan.listenPortUnavailable', undefined, { cause: lastError });
}

function tcpPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

function udpPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', () => {
      try {
        socket.close();
      } catch {
        // A socket that failed to bind may no longer be running; ignore
      }
      resolve(false);
    });
    socket.bind({ port, address: '127.0.0.1', exclusive: true }, () => {
      socket.close(() => resolve(true));
    });
  });
}

export function allocateLoopbackPort(): Promise<number> {
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

function allocateLoopbackUdpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', (error) => {
      try {
        socket.close();
      } catch {
        // A socket that failed to bind may no longer be running; ignore
      }
      reject(error);
    });
    socket.bind({ port: 0, address: '127.0.0.1', exclusive: true }, () => {
      const { port } = socket.address();
      socket.close(() => resolve(port));
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
    // Keep the flag, so a later stop still takes back the firewall rules this generation added.
    firewallOpened: current?.firewallOpened ?? false,
    warning: null,
  });
}
