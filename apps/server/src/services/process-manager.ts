import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { TextDecoder } from 'node:util';
import {
  renderPanelMessage,
  type InstanceStartIssue,
  type InstanceStatus,
  type OrphanProcessInfo,
  type PanelMessageParams,
  type ServerMessageKey,
} from '@mystry/shared';
import type { InstanceRow } from '../db.js';
import { config } from '../config.js';
import { assertSafeInstanceRoot, resolveDirFromRow, resolveSafePath } from '../utils/path.js';
import { getMinecraftChildEnv } from '../utils/child-env.js';
import {
  captureProcessIdentityAsync,
  captureProcessIdentitySync,
  inspectTrackedProcess,
  isTrackedProcessPresentSync,
  signalProcess,
  type TrackedProcessCandidate,
  type TrackedProcessState,
} from '../utils/process-inspect.js';
import { parseJvmArgs, serializeJvmArgFile } from '@mystry/shared';
import { ensureServerPropertiesDefaults } from './config-service.js';
import { resolveJavaRuntimeCommand } from './java-runtime-service.js';
import { normalizeAndAssertJvmArgs } from './jvm-validation-service.js';
import { resolvePlatformModLoaderArgsFile } from './server-launch-detect.js';
import { diagnoseStartFailure, hasFinishedStarting } from './start-diagnosis.js';
import { errorMessage, hasErrorCode, PanelError } from '../utils/errors.js';

const { maxCommandBytes, maxConsoleBufferBytes, maxConsoleChunkBytes, maxConsoleStdinBytes } = config;

const defaultStopGraceMs = 15_000;

function getStopGraceMs(): number {
  const fromEnv = process.env.MYSTRY_TEST_STOP_GRACE_MS;
  if (!fromEnv) return defaultStopGraceMs;
  const parsed = Number(fromEnv);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultStopGraceMs;
}

export class InstanceOperationConflictError extends PanelError {
  readonly code = 'INSTANCE_OPERATION_CONFLICT' as const;

  constructor(key: ServerMessageKey, params?: PanelMessageParams) {
    super(key, params, { statusCode: 409 });
    this.name = 'InstanceOperationConflictError';
  }
}

export class InstanceStopPendingError extends PanelError {
  readonly code = 'INSTANCE_STOP_PENDING' as const;

  constructor(key: ServerMessageKey = 'server.instance.stopPending', params?: PanelMessageParams) {
    super(key, params);
    this.name = 'InstanceStopPendingError';
  }
}

export function isInstanceOperationConflictError(error: unknown): error is InstanceOperationConflictError {
  return error instanceof InstanceOperationConflictError;
}

export function isInstanceStopPendingError(error: unknown): error is InstanceStopPendingError {
  return error instanceof InstanceStopPendingError;
}

type ManagedProcess = {
  child: ChildProcessWithoutNullStreams | null;
  status: InstanceStatus;
  buffer: string[];
  bufferBytes: number;
  stdinAvailable: boolean;
  stdinBackpressured: boolean;
  /** The server has printed the marker line for finished startup, so players can join. */
  ready: boolean;
};

type ProcessSnapshot = Pick<ManagedProcess, 'status' | 'buffer' | 'bufferBytes'> & {
  /** The startup failure reason recognized at the latest exit; cleared along with the snapshot on the next start. */
  startIssue: InstanceStartIssue | null;
};

export type MinecraftProcessSpawner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; windowsHide: boolean },
) => ChildProcessWithoutNullStreams;

export type JavaRuntimeResolver = (javaRuntimeId: string | null) => Promise<string>;

export type OrphanProcessRecord = OrphanProcessInfo & {
  runId: number;
  processIdentity: string | null;
  cwd?: string;
};

export type ProcessInspectTools = {
  captureIdentitySync: (pid: number) => string | null;
  captureIdentityAsync: (pid: number) => Promise<string | null>;
  inspectTrackedProcess: (candidate: TrackedProcessCandidate) => Promise<TrackedProcessState>;
  isTrackedProcessPresentSync: (candidate: TrackedProcessCandidate) => boolean;
  signalProcess: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
};

const defaultProcessInspectTools: ProcessInspectTools = {
  captureIdentitySync: captureProcessIdentitySync,
  captureIdentityAsync: captureProcessIdentityAsync,
  inspectTrackedProcess,
  isTrackedProcessPresentSync,
  signalProcess,
};

const ORPHAN_REINSPECT_INTERVAL_MS = 30_000;

export type StdinSafetyState = Pick<ManagedProcess, 'stdinAvailable' | 'stdinBackpressured'>;

/** Registers a permanent listener on stdin, so asynchronous write errors do not become unhandled exceptions. */
export function registerStdinSafetyHandlers(stdin: Writable, state: StdinSafetyState): void {
  const markUnavailable = () => {
    state.stdinAvailable = false;
    state.stdinBackpressured = true;
  };
  stdin.on('error', markUnavailable);
  stdin.on('close', markUnavailable);
  stdin.on('finish', markUnavailable);
}

/**
 * ignoreBOM keeps a leading BOM in the text, matching what Buffer#toString('utf8') did before the streaming decoder.
 * A new decoder per stream is required: stdout and stderr interleave, and one stream's half character must not merge with the other's bytes.
 */
function createConsoleDecoder(): TextDecoder {
  return new TextDecoder('utf-8', { ignoreBOM: true });
}

function takeUtf8Prefix(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let bytes = 0;
  let end = '';
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) break;
    end += character;
    bytes += characterBytes;
  }
  return end;
}

function takeUtf8Suffix(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const characters = Array.from(text);
  let bytes = 0;
  let start = characters.length;
  while (start > 0) {
    const characterBytes = Buffer.byteLength(characters[start - 1], 'utf8');
    if (bytes + characterBytes > maxBytes) break;
    bytes += characterBytes;
    start -= 1;
  }
  return characters.slice(start).join('');
}

function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<'exited' | 'timeout'> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve('exited');
      return;
    }
    const timeout = setTimeout(() => resolve('timeout'), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve('exited');
    });
  });
}

/**
 * Manages start/stop and console I/O of local Minecraft instance processes.
 */
export class ProcessManager extends EventEmitter {
  private processes = new Map<string, ManagedProcess>();
  private snapshots = new Map<string, ProcessSnapshot>();
  private orphans = new Map<string, OrphanProcessRecord>();
  /** When each detached process last went through full identity inspection (a pending one counts from its start). */
  private orphanInspectedAt = new WeakMap<OrphanProcessRecord, number>();
  private operationTails = new Map<string, Promise<void>>();
  /** Instance maintenance flag during backup/restore: the value is the message key returned when operations such as start are refused. */
  private maintenance = new Map<string, ServerMessageKey>();
  private shuttingDown = false;

  constructor(
    private readonly spawnMinecraft: MinecraftProcessSpawner = (command, args, options) =>
      spawn(command, args, options),
    private readonly resolveJavaCommand: JavaRuntimeResolver = resolveJavaRuntimeCommand,
    private readonly processTools: ProcessInspectTools = defaultProcessInspectTools,
  ) {
    super();
  }

  registerOrphanProcess(instanceId: string, record: OrphanProcessRecord): void {
    this.orphans.set(instanceId, record);
    this.orphanInspectedAt.set(record, Date.now());
  }

  clearOrphanProcesses(): void {
    this.orphans.clear();
  }

  /**
   * Returns active detached-process metadata if still alive; clears and closes the run record
   * synchronously if the OS process has exited since startup recovery.
   */
  getOrphanProcess(instanceId: string): OrphanProcessInfo | null {
    const orphan = this.orphans.get(instanceId);
    if (!orphan) return null;
    if (!this.processTools.isTrackedProcessPresentSync(orphan)) {
      this.releaseOrphan(instanceId, orphan);
      return null;
    }
    this.reinspectOrphanIfDue(instanceId, orphan);
    return {
      pid: orphan.pid,
      startedAt: orphan.startedAt,
      canGracefulStop: orphan.canGracefulStop,
      state: orphan.state,
    };
  }

  /** Inspects the detached process, releasing it when gone and remembering whether it could be confirmed otherwise. */
  private async inspectOrphan(instanceId: string, orphan: OrphanProcessRecord): Promise<TrackedProcessState> {
    const state = await this.processTools.inspectTrackedProcess(orphan);
    if (state === 'dead') this.releaseOrphan(instanceId, orphan);
    else orphan.state = state;
    return state;
  }

  /**
   * Drops a detached process the panel cannot inspect, once the user has checked that its PID is not this server.
   * Without it an instance whose recorded PID now belongs to a protected system process stays blocked until that
   * process exits. A PID confirmed to still be this server is never dismissed: it has to be stopped.
   */
  async dismissOrphan(instanceId: string): Promise<void> {
    return this.withInstanceOperation(instanceId, async () => {
      const orphan = this.orphans.get(instanceId);
      if (!orphan) return;
      if ((await this.inspectOrphan(instanceId, orphan)) === 'alive') {
        throw new InstanceOperationConflictError('server.instance.orphanDismissAlive', { pid: orphan.pid });
      }
      this.releaseOrphan(instanceId, orphan);
    });
  }

  /**
   * The synchronous check above cannot see a recycled PID on Windows and macOS, where reading a start time needs a
   * subprocess. Status reads therefore start a full inspection in the background, at most once per interval, so a
   * detached marker left on someone else's PID clears without waiting for the user to attempt an operation.
   */
  private reinspectOrphanIfDue(instanceId: string, orphan: OrphanProcessRecord): void {
    const now = Date.now();
    if (now - (this.orphanInspectedAt.get(orphan) ?? 0) < ORPHAN_REINSPECT_INTERVAL_MS) return;
    this.orphanInspectedAt.set(orphan, now);
    void this.inspectOrphan(instanceId, orphan).catch(
      () => { /* An inspection that throws proves nothing; the next interval tries again. */ },
    );
  }

  private releaseOrphan(instanceId: string, orphan: OrphanProcessRecord): void {
    if (this.orphans.get(instanceId) !== orphan) return;
    this.orphans.delete(instanceId);
    this.emit('orphan-exited', instanceId, orphan.runId);
  }

  /**
   * Refuses mutating instance operations unless the detached server process is proven gone. A process that cannot
   * be inspected is refused as well, since it may still hold the world directory.
   */
  async assertNoOrphanProcess(instanceId: string): Promise<void> {
    const orphan = this.orphans.get(instanceId);
    if (!orphan) return;
    const state = await this.inspectOrphan(instanceId, orphan);
    if (state === 'dead') return;
    throw new InstanceOperationConflictError(
      state === 'alive' ? 'server.instance.orphanProcessRunning' : 'server.instance.orphanProcessUnverified',
      { pid: orphan.pid },
    );
  }

  getStatus(instanceId: string): InstanceStatus {
    return this.processes.get(instanceId)?.status
      ?? this.snapshots.get(instanceId)?.status
      ?? 'stopped';
  }

  /** The recognizable reason for the latest start failure; null when the instance is running, was never started, or the reason is unknown. */
  getStartIssue(instanceId: string): InstanceStartIssue | null {
    if (this.processes.has(instanceId)) return null;
    return this.snapshots.get(instanceId)?.startIssue ?? null;
  }

  /** Whether the server has finished starting and can be joined; false when stopping or not running. */
  isReady(instanceId: string): boolean {
    const managed = this.processes.get(instanceId);
    return managed?.status === 'running' && managed.ready;
  }

  /** Provides the local collector only with live processes the panel currently holds; external PIDs are not accepted. */
  getMetricTargets(): Array<{ id: string; pid: number }> {
    return [...this.processes].flatMap(([id, managed]) => {
      const child = managed.child;
      return child?.pid && child.exitCode === null && child.signalCode === null
        ? [{ id, pid: child.pid }] : [];
    });
  }

  getBuffer(instanceId: string): string[] {
    return [...(this.processes.get(instanceId)?.buffer
      ?? this.snapshots.get(instanceId)?.buffer
      ?? [])];
  }

  isRunning(instanceId: string): boolean {
    const status = this.getStatus(instanceId);
    return status === 'running' || status === 'starting' || status === 'stopping';
  }

  getRunningCount(): number {
    return this.processes.size;
  }

  /** The panel enters shutdown: new starts are refused, and a start that has not spawned yet exits after resolving Java. */
  beginShutdown(): void {
    this.shuttingDown = true;
  }

  async start(instance: InstanceRow): Promise<void> {
    if (this.shuttingDown) {
      throw new PanelError('server.instance.startShuttingDown');
    }
    return this.withInstanceOperation(instance.id, () => this.startWithinLock(instance));
  }

  async stop(instanceId: string, force = false): Promise<void> {
    return this.withInstanceOperation(instanceId, () => this.stopWithinLock(instanceId, force));
  }

  async restart(instance: InstanceRow): Promise<void> {
    return this.withInstanceOperation(instance.id, async () => {
      // Check the maintenance flag first: otherwise a restart would stop the server first and then refuse to start because of the backup/restore.
      this.assertNotInMaintenance(instance.id);
      await this.assertNoOrphanProcess(instance.id);
      if (this.isRunning(instance.id)) {
        await this.stopWithinLock(instance.id, false);
      }
      await this.startWithinLock(instance);
    });
  }

  /** Safely stops, one by one, all instances managed by the current process before the panel exits. */
  async stopAll(): Promise<{ attempted: number; errors: string[]; stillStopping: string[] }> {
    this.beginShutdown();
    // Wait for unfinished start/stop/delete first: a start still in resolveJava sees the shutdown flag and cancels the spawn.
    await Promise.allSettled([...this.operationTails.values()]);
    const instanceIds = [...this.processes.keys()];
    const errors: string[] = [];
    const pending: string[] = [];
    for (const instanceId of instanceIds) {
      try {
        await this.stop(instanceId);
      } catch (error) {
        if (isInstanceStopPendingError(error)) {
          pending.push(instanceId);
          continue;
        }
        errors.push(`${instanceId}: ${errorMessage(error)}`);
      }
    }
    // A stop that reaches a server while it is still loading can be lost (Paper has failed the command right as it finished starting),
    // so the servers still running get it once more before the panel gives up on them.
    for (const instanceId of pending) {
      if (!this.processes.has(instanceId)) continue;
      try {
        await this.stop(instanceId);
      } catch (error) {
        if (!isInstanceStopPendingError(error) && this.processes.has(instanceId)) {
          errors.push(`${instanceId}: ${errorMessage(error)}`);
        }
      }
    }
    // Whatever still has a process, for whatever reason, is still running: the caller must not hand the data directory to another panel.
    const stillStopping = instanceIds.filter((instanceId) => this.processes.has(instanceId));
    return { attempted: instanceIds.length, errors, stillStopping };
  }

  sendCommand(instanceId: string, command: string): void {
    const managed = this.processes.get(instanceId);
    if (!managed || managed.status === 'stopped' || !managed.child) {
      throw new PanelError('server.instance.commandNotRunning');
    }

    if (typeof command !== 'string' || command.trim().length === 0) {
      throw new PanelError('server.instance.commandEmpty');
    }
    if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(command)) {
      throw new PanelError('server.instance.commandControlChars');
    }
    const commandBytes = Buffer.byteLength(command, 'utf8');
    if (commandBytes > maxCommandBytes) {
      throw new PanelError('server.instance.commandTooLarge', { limit: maxCommandBytes });
    }

    const line = `${command}\n`;
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (lineBytes > maxCommandBytes + 1) {
      throw new PanelError('server.instance.commandTooLarge', { limit: maxCommandBytes });
    }
    if (managed.stdinBackpressured) {
      throw new PanelError('server.instance.stdinBusy');
    }
    const stdin = managed.child.stdin;
    if (!managed.stdinAvailable || stdin.writableEnded || stdin.destroyed || !stdin.writable) {
      throw new PanelError('server.instance.stdinUnavailable');
    }
    if (stdin.writableLength + lineBytes > maxConsoleStdinBytes) {
      throw new PanelError('server.instance.stdinTooLarge', { limit: maxConsoleStdinBytes });
    }
    try {
      const accepted = stdin.write(line);
      if (!accepted) {
        managed.stdinBackpressured = true;
      }
    } catch {
      managed.stdinAvailable = false;
      managed.stdinBackpressured = true;
      throw new PanelError('server.instance.commandWriteFailed');
    }
    // Minecraft does not echo stdin, so after a command is written the console looks completely unresponsive; the command is recorded in the console buffer as "> command",
    // so it shows as sent on reconnect, when coming back from another page, and when someone else opens it. When the previous output chunk had no line break, one is added first so it does not follow a half line.
    const last = managed.buffer[managed.buffer.length - 1] ?? '';
    this.appendOutput(instanceId, `${last && !last.endsWith('\n') ? '\n' : ''}> ${command}\n`);
  }

  getHistory(instanceId: string): string {
    return this.getBuffer(instanceId).join('');
  }

  /** After the instance record is deleted, also clears the final state and console history kept in the current process. */
  forget(instanceId: string): void {
    if (this.processes.has(instanceId) || this.getOrphanProcess(instanceId)) {
      throw new PanelError('server.instance.forgetRunning');
    }
    this.snapshots.delete(instanceId);
  }

  /**
   * Enters maintenance (backup or restore): start, restart, delete and takeover are refused meanwhile; stop and console commands are unaffected.
   * The caller should check the state inside runExclusive before calling; the returned function ends maintenance and can be called repeatedly.
   */
  beginMaintenance(instanceId: string, key: ServerMessageKey): () => void {
    const existing = this.maintenance.get(instanceId);
    if (existing) throw new InstanceOperationConflictError(existing);
    this.maintenance.set(instanceId, key);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      if (this.maintenance.get(instanceId) === key) this.maintenance.delete(instanceId);
    };
  }

  /** Throws a conflict error when the instance is under maintenance (the message says whether it is a backup or a restore). */
  assertNotInMaintenance(instanceId: string): void {
    const key = this.maintenance.get(instanceId);
    if (key) throw new InstanceOperationConflictError(key);
  }

  getMaintenance(instanceId: string): ServerMessageKey | null {
    return this.maintenance.get(instanceId) ?? null;
  }

  /** Delete/takeover share the same instance lock with start/stop, so a directory being started is not torn down concurrently. */
  runExclusive<T>(instanceId: string, operation: () => Promise<T>): Promise<T> {
    return this.withInstanceOperation(instanceId, operation);
  }

  private async withInstanceOperation<T>(instanceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTails.get(instanceId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.operationTails.set(instanceId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.operationTails.get(instanceId) === tail) {
        this.operationTails.delete(instanceId);
      }
    }
  }

  private async startWithinLock(instance: InstanceRow): Promise<void> {
    if (this.shuttingDown) {
      throw new PanelError('server.instance.startShuttingDown');
    }
    if (this.isRunning(instance.id)) {
      throw new InstanceOperationConflictError('server.instance.alreadyRunning');
    }
    await this.assertNoOrphanProcess(instance.id);
    this.assertNotInMaintenance(instance.id);

    const cwd = resolveDirFromRow(instance);
    assertSafeInstanceRoot(cwd);

    if (instance.accept_eula) {
      const eulaPath = resolveSafePath(cwd, 'eula.txt');
      fs.writeFileSync(eulaPath, 'eula=true\n', 'utf8');
    }

    const normalizedJvmArgs = normalizeAndAssertJvmArgs(instance.jvm_args, {
      coreType: instance.core_type as import('@mystry/shared').CoreType,
      javaRuntimeId: instance.java_runtime_id,
    });
    const jvmArgs = parseJvmArgs(normalizedJvmArgs);
    let args: string[];

    if (instance.jar_file.startsWith('@args:')) {
      const rawArgsRel = instance.jar_file.slice('@args:'.length);
      // Prefer the current platform's win_args.txt / unix_args.txt sibling when present so a migrated data directory
      // or restored record still boots with the right classpath separator.
      const argsRel = resolvePlatformModLoaderArgsFile(cwd, rawArgsRel) ?? rawArgsRel;
      const argsAbs = resolveSafePath(cwd, argsRel);
      if (!fs.existsSync(argsAbs)) {
        throw new PanelError('server.instance.forgeArgsMissing', { path: argsRel });
      }
      const safeArgsRel = path.relative(cwd, argsAbs).replace(/\\/g, '/');
      const userJvm = resolveSafePath(cwd, 'user_jvm_args.txt');
      fs.writeFileSync(userJvm, `${serializeJvmArgFile(jvmArgs)}\n`, 'utf8');
      args = ['@user_jvm_args.txt', `@${safeArgsRel}`, 'nogui'];
    } else if (instance.jar_file === '@modloader') {
      throw new PanelError('server.instance.modloaderNotInstalled');
    } else {
      const jarPath = resolveSafePath(cwd, instance.jar_file);
      if (!fs.existsSync(jarPath)) {
        throw new PanelError('server.instance.jarMissing', { jar: instance.jar_file });
      }
      const safeJarRel = path.relative(cwd, jarPath).replace(/\\/g, '/');
      args = [...jvmArgs, '-jar', safeJarRel, 'nogui'];
    }

    const managed: ManagedProcess = {
      child: null,
      status: 'starting',
      buffer: [],
      bufferBytes: 0,
      stdinAvailable: true,
      stdinBackpressured: false,
      ready: false,
    };
    this.snapshots.delete(instance.id);
    this.processes.set(instance.id, managed);
    this.emitStatus(instance.id, 'starting');

    try {
      const javaCommand = await this.resolveJavaCommand(instance.java_runtime_id);
      if (this.shuttingDown) {
        throw new PanelError('server.instance.startCancelledShuttingDown');
      }
      ensureServerPropertiesDefaults(instance.id, instance.mc_version);
      const child = this.spawnMinecraft(javaCommand, args, {
        cwd,
        env: getMinecraftChildEnv(),
        windowsHide: true,
      });
      managed.child = child;
      registerStdinSafetyHandlers(child.stdin, managed);
      if (typeof child.pid === 'number' && child.pid > 0) {
        const pid = child.pid;
        const syncIdentity = this.processTools.captureIdentitySync(pid);
        this.emit('spawned', instance.id, pid, syncIdentity);
        if (!syncIdentity) {
          void this.processTools.captureIdentityAsync(pid).then((identity) => {
            if (identity && this.processes.get(instance.id) === managed && managed.child?.pid === pid) {
              this.emit('process-identity', instance.id, pid, identity);
            }
          }, () => {});
        }
      }

      const decoders = { stdout: createConsoleDecoder(), stderr: createConsoleDecoder() };
      const decodeChunk = (stream: keyof typeof decoders, chunk: Buffer): string => {
        if (chunk.length <= maxConsoleChunkBytes) {
          return decoders[stream].decode(chunk, { stream: true });
        }
        const retained = decoders[stream].decode(chunk.subarray(0, maxConsoleChunkBytes), { stream: true });
        // The rest of an oversized chunk is discarded by design. Resetting the decoder also discards the partial character at the cut,
        // so its remaining bytes cannot turn into a replacement character when they are never delivered.
        decoders[stream] = createConsoleDecoder();
        return retained;
      };
      const flushDecodedOutput = () => {
        for (const stream of ['stdout', 'stderr'] as const) {
          const tail = decoders[stream].decode();
          if (tail) this.appendOutput(instance.id, tail);
        }
      };

      const onChunk = (stream: keyof typeof decoders) => (chunk: Buffer) => {
        if (this.processes.get(instance.id) !== managed) return;
        // The marker line may be split across two adjacent output chunks, so it is checked together with the end of the previous output.
        // That end is read before appending, because one chunk can take several buffer entries.
        const previous = managed.buffer[managed.buffer.length - 1] ?? '';
        const text = decodeChunk(stream, chunk);
        this.appendOutput(instance.id, text);
        if (managed.status === 'starting') {
          managed.status = 'running';
          this.emitStatus(instance.id, 'running');
        }
        if (!managed.ready && hasFinishedStarting(previous + text)) {
          managed.ready = true;
          this.emit('ready', instance.id);
        }
      };

      child.stdout.on('data', onChunk('stdout'));
      child.stderr.on('data', onChunk('stderr'));
      // A pipe stream error without a listener becomes an uncaught exception; EPIPE on the pipe when the child exits is normal.
      child.stdout.on('error', () => {});
      child.stderr.on('error', () => {});
      child.stdin.on('drain', () => {
        if (this.processes.get(instance.id) === managed && managed.stdinAvailable) {
          managed.stdinBackpressured = false;
        }
      });

      child.on('error', (err) => {
        if (this.processes.get(instance.id) !== managed) return;
        flushDecodedOutput();
        // Console log lines are written whole in English; Web recognizes the sentence pattern and rewrites it in the current language for display.
        const line = renderPanelMessage({
          key: 'server.instance.consoleProcessStartFailed',
          params: { reason: err.message },
        });
        this.appendOutput(instance.id, `\n${line}\n`);
        this.archiveProcess(instance.id, managed, 'crashed');
      });

      child.on('exit', (code, signal) => {
        if (this.processes.get(instance.id) !== managed) return;
        // Flush before diagnosing so a half character still held by the decoder appears in the output the diagnosis reads.
        flushDecodedOutput();
        const wasStopping = managed.status === 'stopping';
        // The process ending on its own with exit code 0 (EULA not accepted, stop run in-game, etc.) is not a crash.
        const status = wasStopping || code === 0 ? 'stopped' : 'crashed';
        // When the stop was not requested by the user, look in the output for a reason that directly tells the user what to do.
        const startIssue = wasStopping
          ? null
          : diagnoseStartFailure(managed.buffer.join(''), instance.mc_version);
        const none = renderPanelMessage({ key: 'server.instance.consoleNone' });
        const line = renderPanelMessage({
          key: 'server.instance.consoleProcessExited',
          params: { code: code ?? none, signal: signal ?? none },
        });
        this.appendOutput(instance.id, `\n${line}\n`);
        this.archiveProcess(instance.id, managed, status, startIssue);
      });
    } catch (error) {
      this.processes.delete(instance.id);
      this.emitStatus(instance.id, 'stopped');
      throw error;
    }
  }

  private async stopWithinLock(instanceId: string, force: boolean): Promise<void> {
    const managed = this.processes.get(instanceId);
    if (!managed) {
      if (this.orphans.has(instanceId)) {
        await this.stopOrphanWithinLock(instanceId, force);
        return;
      }
      throw new PanelError('server.instance.notRunning');
    }
    if (!managed.child) {
      throw new InstanceOperationConflictError('server.instance.stillStarting');
    }

    const child = managed.child;

    if (force) {
      managed.status = 'stopping';
      this.emitStatus(instanceId, 'stopping');
      child.kill('SIGKILL');
      const outcome = await waitForChildExit(child, getStopGraceMs());
      if (outcome === 'timeout' && this.processes.get(instanceId) === managed) {
        throw new InstanceStopPendingError('server.instance.forceStopPending');
      }
      return;
    }

    // Confirm the input stream is usable before entering stopping, so the instance is not stuck in stopping forever when validation fails.
    const stdin = child.stdin;
    if (!managed.stdinAvailable || stdin.writableEnded || stdin.destroyed || !stdin.writable) {
      throw new PanelError('server.instance.stopStdinUnavailable');
    }

    managed.status = 'stopping';
    this.emitStatus(instanceId, 'stopping');

    try {
      if (!stdin.write('stop\n')) managed.stdinBackpressured = true;
    } catch {
      managed.stdinAvailable = false;
      managed.stdinBackpressured = true;
      managed.status = 'running';
      this.emitStatus(instanceId, 'running');
      throw new PanelError('server.instance.stopWriteFailed');
    }

    const outcome = await waitForChildExit(child, getStopGraceMs());
    if (outcome === 'timeout' && this.processes.get(instanceId) === managed) {
      throw new InstanceStopPendingError();
    }
  }

  private async stopOrphanWithinLock(instanceId: string, force: boolean): Promise<void> {
    const orphan = this.orphans.get(instanceId);
    if (!orphan) {
      throw new PanelError('server.instance.notRunning');
    }
    const state = await this.inspectOrphan(instanceId, orphan);
    if (state === 'dead') return;
    // Never signal a PID whose owner cannot be confirmed: it may have been recycled by an unrelated process.
    if (state === 'unknown') {
      throw new InstanceOperationConflictError('server.instance.orphanProcessUnverified', { pid: orphan.pid });
    }
    if (!force && !orphan.canGracefulStop) {
      throw new InstanceOperationConflictError('server.instance.orphanStopRequiresForce', { pid: orphan.pid });
    }
    const signal: 'SIGTERM' | 'SIGKILL' = force ? 'SIGKILL' : 'SIGTERM';
    try {
      this.processTools.signalProcess(orphan.pid, signal);
    } catch (error) {
      if (hasErrorCode(error, 'ESRCH')) {
        this.releaseOrphan(instanceId, orphan);
        return;
      }
      throw new PanelError('server.instance.orphanSignalFailed', {
        pid: orphan.pid,
        reason: errorMessage(error),
      });
    }

    const deadline = Date.now() + getStopGraceMs();
    while (Date.now() < deadline) {
      if (!this.processTools.isTrackedProcessPresentSync(orphan)) {
        this.releaseOrphan(instanceId, orphan);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if ((await this.inspectOrphan(instanceId, orphan)) === 'dead') return;

    throw new InstanceStopPendingError(
      force ? 'server.instance.orphanForceStopPending' : 'server.instance.orphanStopPending',
      { pid: orphan.pid },
    );
  }

  private archiveProcess(
    instanceId: string,
    managed: ManagedProcess,
    status: Extract<InstanceStatus, 'stopped' | 'crashed'>,
    startIssue: InstanceStartIssue | null = null,
  ): void {
    managed.status = status;
    this.processes.delete(instanceId);
    // Save the snapshot before emitting the state event: listeners query right after receiving the event and must be able to read this diagnosis.
    this.snapshots.set(instanceId, {
      status,
      buffer: [...managed.buffer],
      bufferBytes: managed.bufferBytes,
      startIssue,
    });
    this.emitStatus(instanceId, status);
  }

  private appendOutput(instanceId: string, text: string): void {
    const managed = this.processes.get(instanceId);
    if (!managed) return;

    // Decoded text can be larger than the chunk limit: a partial character carried over from the previous chunk adds up to 3 bytes,
    // and invalid bytes decode to 3-byte replacement characters. The console route closes the connection on a larger output
    // message, and cutting would drop delivered text such as a newline, so the text is appended in pieces at character boundaries.
    let rest = text;
    while (rest) {
      const output = takeUtf8Prefix(rest, maxConsoleChunkBytes);
      // A configured limit smaller than one character admits nothing more.
      if (!output) return;
      rest = rest.slice(output.length);
      const outputBytes = Buffer.byteLength(output, 'utf8');

      managed.buffer.push(output);
      managed.bufferBytes += outputBytes;
      while (managed.bufferBytes > maxConsoleBufferBytes && managed.buffer.length > 0) {
        const excess = managed.bufferBytes - maxConsoleBufferBytes;
        const oldest = managed.buffer[0];
        const oldestBytes = Buffer.byteLength(oldest, 'utf8');
        if (oldestBytes <= excess) {
          managed.buffer.shift();
          managed.bufferBytes -= oldestBytes;
        } else {
          const retained = takeUtf8Suffix(oldest, oldestBytes - excess);
          managed.buffer[0] = retained;
          managed.bufferBytes -= oldestBytes - Buffer.byteLength(retained, 'utf8');
        }
      }
      this.emit('output', instanceId, output);
    }
  }

  private emitStatus(instanceId: string, status: InstanceStatus): void {
    this.emit('status', instanceId, status);
  }
}

export const processManager = new ProcessManager();
