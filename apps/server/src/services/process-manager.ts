import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Writable } from 'node:stream';
import {
  renderPanelMessage,
  type InstanceStartIssue,
  type InstanceStatus,
  type ServerMessageKey,
} from '@mystry/shared';
import type { InstanceRow } from '../db.js';
import { config } from '../config.js';
import { assertSafeInstanceRoot, resolveDirFromRow, resolveSafePath } from '../utils/path.js';
import { getMinecraftChildEnv } from '../utils/child-env.js';
import { parseJvmArgs, serializeJvmArgFile } from '@mystry/shared';
import { ensureServerPropertiesDefaults } from './config-service.js';
import { resolveJavaRuntimeCommand } from './java-runtime-service.js';
import { normalizeAndAssertJvmArgs } from './jvm-validation-service.js';
import { diagnoseStartFailure } from './start-diagnosis.js';
import { errorMessage, PanelError } from '../utils/errors.js';

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

  constructor(key: ServerMessageKey) {
    super(key);
    this.name = 'InstanceOperationConflictError';
  }
}

export class InstanceStopPendingError extends PanelError {
  readonly code = 'INSTANCE_STOP_PENDING' as const;

  constructor(key: ServerMessageKey = 'server.instance.stopPending') {
    super(key);
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
};

type ProcessSnapshot = Pick<ManagedProcess, 'status' | 'buffer' | 'bufferBytes'> & {
  /** 最近一次退出时认出的启动失败原因；下次启动会随快照一起清掉。 */
  startIssue: InstanceStartIssue | null;
};

export type MinecraftProcessSpawner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; windowsHide: boolean },
) => ChildProcessWithoutNullStreams;

export type JavaRuntimeResolver = (javaRuntimeId: string | null) => Promise<string>;

export type StdinSafetyState = Pick<ManagedProcess, 'stdinAvailable' | 'stdinBackpressured'>;

/** 给 stdin 注册永久监听，避免异步写入错误变成未处理异常。 */
export function registerStdinSafetyHandlers(stdin: Writable, state: StdinSafetyState): void {
  const markUnavailable = () => {
    state.stdinAvailable = false;
    state.stdinBackpressured = true;
  };
  stdin.on('error', markUnavailable);
  stdin.on('close', markUnavailable);
  stdin.on('finish', markUnavailable);
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
 * 管理本机 Minecraft 实例进程的启停与控制台 I/O。
 */
export class ProcessManager extends EventEmitter {
  private processes = new Map<string, ManagedProcess>();
  private snapshots = new Map<string, ProcessSnapshot>();
  private operationTails = new Map<string, Promise<void>>();
  /** 备份/还原期间的实例维护标记：值为拒绝启动等操作时返回的消息键。 */
  private maintenance = new Map<string, ServerMessageKey>();
  private shuttingDown = false;

  constructor(
    private readonly spawnMinecraft: MinecraftProcessSpawner = (command, args, options) =>
      spawn(command, args, options),
    private readonly resolveJavaCommand: JavaRuntimeResolver = resolveJavaRuntimeCommand,
  ) {
    super();
  }

  getStatus(instanceId: string): InstanceStatus {
    return this.processes.get(instanceId)?.status
      ?? this.snapshots.get(instanceId)?.status
      ?? 'stopped';
  }

  /** 最近一次启动失败的可识别原因；实例在运行、从未启动或原因不明时为 null。 */
  getStartIssue(instanceId: string): InstanceStartIssue | null {
    if (this.processes.has(instanceId)) return null;
    return this.snapshots.get(instanceId)?.startIssue ?? null;
  }

  /** 只向本机采集器提供面板当前持有的活进程，不接受外部 PID。 */
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

  /** 面板进入关闭流程：拒绝新的启动，并让尚未 spawn 的 start 在解析 Java 后退出。 */
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
      // 先检查维护标记：否则重启会先停掉服务器，再因备份/还原拒绝启动。
      this.assertNotInMaintenance(instance.id);
      if (this.isRunning(instance.id)) {
        await this.stopWithinLock(instance.id, false);
      }
      await this.startWithinLock(instance);
    });
  }

  /** 面板退出前逐个安全停止所有由当前进程管理的实例。 */
  async stopAll(): Promise<{ attempted: number; errors: string[]; stillStopping: string[] }> {
    this.beginShutdown();
    // 先等未完成的启停/删除：正在 resolveJava 的 start 会看到关闭标志并取消 spawn。
    await Promise.allSettled([...this.operationTails.values()]);
    const instanceIds = [...this.processes.keys()];
    const errors: string[] = [];
    const stillStopping: string[] = [];
    for (const instanceId of instanceIds) {
      try {
        await this.stop(instanceId);
      } catch (error) {
        if (isInstanceStopPendingError(error)) {
          stillStopping.push(instanceId);
          continue;
        }
        errors.push(`${instanceId}: ${errorMessage(error)}`);
      }
    }
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
  }

  getHistory(instanceId: string): string {
    return this.getBuffer(instanceId).join('');
  }

  /** 实例记录删除后同步清理当前进程内保留的终态与控制台历史。 */
  forget(instanceId: string): void {
    if (this.processes.has(instanceId)) {
      throw new PanelError('server.instance.forgetRunning');
    }
    this.snapshots.delete(instanceId);
  }

  /**
   * 进入维护（备份或还原）：期间拒绝启动、重启、删除和接管；停止与控制台命令不受影响。
   * 调用方应在 runExclusive 内检查状态后再调用，返回的函数用于结束维护，可重复调用。
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

  /** 实例处于维护中时抛出冲突错误（消息说明是备份还是还原）。 */
  assertNotInMaintenance(instanceId: string): void {
    const key = this.maintenance.get(instanceId);
    if (key) throw new InstanceOperationConflictError(key);
  }

  getMaintenance(instanceId: string): ServerMessageKey | null {
    return this.maintenance.get(instanceId) ?? null;
  }

  /** 删除/接管与启停共用同一把实例锁，避免并发拆掉正在启动的目录。 */
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
      const argsRel = instance.jar_file.slice('@args:'.length);
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

      const onChunk = (chunk: Buffer) => {
        if (this.processes.get(instance.id) !== managed) return;
        this.appendOutput(instance.id, chunk);
        if (managed.status === 'starting') {
          managed.status = 'running';
          this.emitStatus(instance.id, 'running');
        }
      };

      child.stdout.on('data', onChunk);
      child.stderr.on('data', onChunk);
      // 管道流 error 无监听器会成为未捕获异常；子进程退出时管道 EPIPE 属正常现象。
      child.stdout.on('error', () => {});
      child.stderr.on('error', () => {});
      child.stdin.on('drain', () => {
        if (this.processes.get(instance.id) === managed && managed.stdinAvailable) {
          managed.stdinBackpressured = false;
        }
      });

      child.on('error', (err) => {
        if (this.processes.get(instance.id) !== managed) return;
        // 控制台日志写英文整行，Web 识别该句式后按当前语言改写显示。
        const line = renderPanelMessage({
          key: 'server.instance.consoleProcessStartFailed',
          params: { reason: err.message },
        });
        this.appendOutput(instance.id, `\n${line}\n`);
        this.archiveProcess(instance.id, managed, 'crashed');
      });

      child.on('exit', (code, signal) => {
        if (this.processes.get(instance.id) !== managed) return;
        const wasStopping = managed.status === 'stopping';
        // 进程自己以退出码 0 结束（未同意 EULA、游戏内执行 stop 等）不算崩溃。
        const status = wasStopping || code === 0 ? 'stopped' : 'crashed';
        // 不是用户要求的停止时，从输出里找可以直接告诉用户怎么办的原因。
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

    // 先确认输入流可用，再进入 stopping，避免校验失败时实例永久卡在 stopping。
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

  private archiveProcess(
    instanceId: string,
    managed: ManagedProcess,
    status: Extract<InstanceStatus, 'stopped' | 'crashed'>,
    startIssue: InstanceStartIssue | null = null,
  ): void {
    managed.status = status;
    this.processes.delete(instanceId);
    // 先存快照再发状态事件：监听方收到事件后立即查询，要能读到这次的诊断结果。
    this.snapshots.set(instanceId, {
      status,
      buffer: [...managed.buffer],
      bufferBytes: managed.bufferBytes,
      startIssue,
    });
    this.emitStatus(instanceId, status);
  }

  private appendOutput(instanceId: string, text: string | Buffer): void {
    const managed = this.processes.get(instanceId);
    if (!managed) return;

    const chunkText = Buffer.isBuffer(text)
      ? text.subarray(0, maxConsoleChunkBytes).toString('utf8')
      : text;
    const output = takeUtf8Prefix(chunkText, maxConsoleChunkBytes);
    const outputBytes = Buffer.byteLength(output, 'utf8');
    if (outputBytes === 0) return;

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

  private emitStatus(instanceId: string, status: InstanceStatus): void {
    this.emit('status', instanceId, status);
  }
}

export const processManager = new ProcessManager();
