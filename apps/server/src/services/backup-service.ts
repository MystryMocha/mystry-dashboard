import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { nanoid } from 'nanoid';
import {
  CORE_TYPE_ENUM,
  type BackupInfo,
  type BackupSource,
  type CoreType,
  type InstanceStatus,
  type PanelMessage,
  type TaskInfo,
} from '@mystry/shared';
import { config } from '../config.js';
import type { InstanceRow } from '../db.js';
import { writeFileAtomic } from '../utils/atomic-write.js';
import {
  assertSafeInstanceRoot,
  defaultInstanceDir,
  getInstanceDir,
  hasValidOwnershipMarker,
  resolveSafePath,
  writeOwnershipMarker,
} from '../utils/path.js';
import { abortError, errorParam, hasErrorCode, PanelError } from '../utils/errors.js';
import {
  isReservedArchivePath,
  readBackupArchive,
  writeBackupArchive,
  type BackupArchiveLimits,
  type BackupManifest,
  type BackupSourceEntry,
} from './backup-archive.js';
import { getInstanceRow, updateInstanceServerFiles } from './instance-service.js';
import { processManager } from './process-manager.js';
import { recordTaskStaging, runBackgroundTask } from './task-service.js';
import {
  prepareTaskStaging,
  removeTaskStagingTree,
  STAGING_MARKER_FILE,
  STAGING_ROOT_DIR,
} from './task-staging-service.js';
import { isUploadTooLargeError, removeUploadTemp, streamToUploadTemp } from './upload-service.js';

/** 备份 ID：UTC 时间 + 6 位随机后缀，同时是文件名主体。 */
const BACKUP_ID_PATTERN = /^\d{8}-\d{6}-[A-Za-z0-9_-]{6}$/;
const ARCHIVE_SUFFIX = '.tar.gz';
const META_SUFFIX = '.json';
const TEMP_PREFIX = '.tmp-';
/** 还原换目录期间写在 .mystry-staging/<taskId>/ 下的标记与旧目录，供崩溃后回滚或收尾。 */
const RESTORE_SWAP_MARKER = '.mystry-restore-swap.json';
const RESTORE_PREVIOUS_DIR = '.mystry-restore-previous';
/** 还原前要求的额外可用空间，留给数据库和日志。 */
const RESTORE_FREE_SPACE_MARGIN_BYTES = 64 * 1024 * 1024;
/**
 * save-all flush 完成后服务端自己输出的消息：1.13 起为 Saved the game，1.12 及更早为 Saved the world。
 * 只与日志前缀之后的整条消息比较，玩家聊天（`<Steve> Saved the game`）不会被当成保存完成。
 */
const SAVE_CONFIRM_MESSAGE = /^(?:Saved the (?:game|world)|All dimensions are saved)\.?$/i;
/** 日志行前缀与消息之间的分隔：Vanilla/Forge `[..] [Server thread/INFO]: `，Paper `[.. INFO]: `。 */
const LOG_MESSAGE_SEPARATOR = ']: ';
const ANSI_ESCAPE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const MAX_PENDING_LINE_CHARS = 4096;
const defaultSaveConfirmTimeoutMs = 60_000;
/** 服务端运行时被 JVM 独占锁住的文件（Windows 上无法读取）；启动时会重新生成，不进入备份。 */
const SKIPPED_FILE_NAMES = new Set(['session.lock']);
const PROGRESS_REPORT_INTERVAL_MS = 250;

type ReportProgress = (progress: number, message: PanelMessage) => void;

/** 正在被还原任务使用的备份，禁止删除。键为 `<实例 ID>/<备份 ID>`。 */
const backupsInUse = new Set<string>();

function getSaveConfirmTimeoutMs(): number {
  const fromEnv = process.env.MYSTRY_TEST_BACKUP_SAVE_TIMEOUT_MS;
  if (!fromEnv) return defaultSaveConfirmTimeoutMs;
  const parsed = Number(fromEnv);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultSaveConfirmTimeoutMs;
}

/** 判断一行控制台输出是否为服务端自己打印的保存完成消息。 */
export function isSaveConfirmationLine(line: string): boolean {
  const text = line.replace(ANSI_ESCAPE, '').trim();
  const separator = text.indexOf(LOG_MESSAGE_SEPARATOR);
  // 没有日志前缀的裸输出只可能来自服务端进程本身（聊天、/say 都带前缀）。
  const message = separator === -1 ? text : text.slice(separator + LOG_MESSAGE_SEPARATOR.length).trim();
  return SAVE_CONFIRM_MESSAGE.test(message);
}

function archiveLimits(): BackupArchiveLimits {
  // 与本机目录交接共用条目数和总大小配额：两者都是把整份服务端复制进托管目录。
  return { maxEntries: config.maxExistingImportEntries, maxBytes: config.maxExistingImportBytes };
}

function comparable(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(comparable(root), comparable(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** 备份根目录：不得位于实例、交接、上传或任务临时目录内，也不得包含整个数据根。 */
export function backupRoot(): string {
  const root = path.resolve(config.backupDir);
  const managed = [
    config.instancesDir,
    config.existingServerImportDir,
    config.uploadDir,
    path.join(config.dataDir, STAGING_ROOT_DIR),
  ];
  if (managed.some((dir) => isWithin(dir, root)) || isWithin(root, config.dataDir)) {
    throw new PanelError('server.backups.dirInsideManaged');
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

function instanceBackupDir(instanceId: string, create: boolean): string | null {
  // 复用实例 ID 校验，避免把任意字符串拼进路径。
  defaultInstanceDir(instanceId);
  const dir = path.join(backupRoot(), instanceId);
  if (create) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return null;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PanelError('server.backups.dirUnsafe');
  return dir;
}

function assertBackupId(backupId: string): void {
  if (!BACKUP_ID_PATTERN.test(backupId)) {
    throw new PanelError('server.backups.idInvalid', undefined, { statusCode: 400 });
  }
}

function newBackupId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${stamp}-${nanoid(6)}`;
}

function archiveFile(dir: string, backupId: string): string {
  return path.join(dir, `${backupId}${ARCHIVE_SUFFIX}`);
}

function metaFile(dir: string, backupId: string): string {
  return path.join(dir, `${backupId}${META_SUFFIX}`);
}

function toCoreType(value: unknown): CoreType | null {
  return typeof value === 'string' && (CORE_TYPE_ENUM as readonly string[]).includes(value) ? value as CoreType : null;
}

const BACKUP_SOURCES: readonly BackupSource[] = ['manual', 'pre-restore', 'upload'];

/** 读取元数据；内容损坏、字段不符或压缩包缺失时返回 null（列表中不显示）。 */
function readBackupMeta(dir: string, instanceId: string, backupId: string): BackupInfo | null {
  let parsed: Partial<BackupInfo> & { version?: unknown };
  let archiveStat: fs.Stats;
  try {
    parsed = JSON.parse(fs.readFileSync(metaFile(dir, backupId), 'utf8')) as typeof parsed;
    archiveStat = fs.lstatSync(archiveFile(dir, backupId));
  } catch {
    return null;
  }
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink()) return null;
  if (
    parsed.version !== 1
    || parsed.id !== backupId
    || parsed.instanceId !== instanceId
    || typeof parsed.instanceName !== 'string'
    || !BACKUP_SOURCES.includes(parsed.source as BackupSource)
    || typeof parsed.createdAt !== 'string'
    || !Number.isSafeInteger(parsed.fileCount)
    || !Number.isSafeInteger(parsed.contentBytes)
    || typeof parsed.sha256 !== 'string'
  ) {
    return null;
  }
  return {
    id: backupId,
    instanceId,
    instanceName: parsed.instanceName,
    source: parsed.source as BackupSource,
    createdAt: parsed.createdAt,
    sizeBytes: archiveStat.size,
    fileCount: parsed.fileCount!,
    contentBytes: parsed.contentBytes!,
    coreType: toCoreType(parsed.coreType),
    mcVersion: typeof parsed.mcVersion === 'string' ? parsed.mcVersion : null,
    wasRunning: parsed.wasRunning === true,
    sha256: parsed.sha256,
  };
}

function writeBackupMeta(dir: string, info: BackupInfo): void {
  writeFileAtomic(metaFile(dir, info.id), `${JSON.stringify({ version: 1, ...info })}\n`);
}

function requireManagedInstance(instanceId: string): InstanceRow {
  const row = getInstanceRow(instanceId);
  if (!row) throw new PanelError('server.instance.notFound', undefined, { statusCode: 404 });
  if (row.install_path !== null) throw new PanelError('server.backups.legacyInstance');
  return row;
}

export function listBackups(instanceId: string): BackupInfo[] {
  requireManagedInstance(instanceId);
  const dir = instanceBackupDir(instanceId, false);
  if (!dir) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(META_SUFFIX) && !name.startsWith(TEMP_PREFIX))
    .map((name) => name.slice(0, -META_SUFFIX.length))
    .filter((backupId) => BACKUP_ID_PATTERN.test(backupId))
    .map((backupId) => readBackupMeta(dir, instanceId, backupId))
    .filter((info): info is BackupInfo => info !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

/** 已校验的备份记录及其压缩包绝对路径，供下载、还原与删除使用。 */
export function getBackupWithArchive(instanceId: string, backupId: string): { info: BackupInfo; archive: string } {
  requireManagedInstance(instanceId);
  assertBackupId(backupId);
  const dir = instanceBackupDir(instanceId, false);
  const info = dir ? readBackupMeta(dir, instanceId, backupId) : null;
  if (!dir || !info) throw new PanelError('server.backups.notFound', undefined, { statusCode: 404 });
  return { info, archive: archiveFile(dir, backupId) };
}

export function getBackup(instanceId: string, backupId: string): BackupInfo {
  return getBackupWithArchive(instanceId, backupId).info;
}

export function deleteBackup(instanceId: string, backupId: string): void {
  const { archive } = getBackupWithArchive(instanceId, backupId);
  if (backupsInUse.has(`${instanceId}/${backupId}`)) {
    throw new PanelError('server.backups.inUse', undefined, { statusCode: 409 });
  }
  const dir = path.dirname(archive);
  // 先把压缩包改成临时文件名：之后任何一步失败，留下的都是启动时会清理的临时文件。
  const doomed = path.join(dir, `${TEMP_PREFIX}${path.basename(archive)}`);
  fs.renameSync(archive, doomed);
  try {
    fs.rmSync(metaFile(dir, backupId), { force: true });
  } catch (error) {
    fs.renameSync(doomed, archive);
    throw error;
  }
  try {
    fs.rmSync(doomed, { force: true });
  } catch {
    // 文件仍被占用时留给下次启动的 recoverInterruptedBackups() 清理。
  }
}

/** 删除实例时一并删除它的全部备份。 */
export function deleteInstanceBackups(instanceId: string): void {
  // 复用实例 ID 校验，避免把任意字符串拼进路径。
  defaultInstanceDir(instanceId);
  const dir = path.join(backupRoot(), instanceId);
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PanelError('server.backups.dirUnsafe');
  fs.rmSync(dir, { recursive: true, force: true });
}

/** 列出实例目录：跳过面板维护的标记文件；遇到符号链接或目录联接直接拒绝。 */
function scanInstanceDirectory(root: string): BackupSourceEntry[] {
  const limits = archiveLimits();
  const entries: BackupSourceEntry[] = [];
  let totalBytes = 0;
  const pending = [''];
  while (pending.length > 0) {
    const relativeDir = pending.pop()!;
    const absoluteDir = relativeDir ? path.join(root, ...relativeDir.split('/')) : root;
    const children = fs.readdirSync(absoluteDir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subdirectories: string[] = [];
    for (const child of children) {
      const relativePath = relativeDir ? `${relativeDir}/${child.name}` : child.name;
      if (isReservedArchivePath(relativePath)) continue;
      const absolute = path.join(absoluteDir, child.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new PanelError('server.backups.sourceHasLink', { name: relativePath });
      if (stat.isFile() && SKIPPED_FILE_NAMES.has(child.name.toLowerCase())) continue;
      if (stat.isDirectory()) {
        entries.push({ kind: 'dir', path: relativePath, mtimeMs: stat.mtimeMs });
        subdirectories.push(relativePath);
      } else if (stat.isFile()) {
        totalBytes += stat.size;
        entries.push({ kind: 'file', path: relativePath, absolute, size: stat.size, mtimeMs: stat.mtimeMs });
      } else {
        // 套接字、管道等特殊文件无法还原，直接跳过。
        continue;
      }
      if (entries.length > limits.maxEntries) {
        throw new PanelError('server.backups.sourceTooManyEntries', { limit: limits.maxEntries });
      }
      if (totalBytes > limits.maxBytes) {
        throw new PanelError('server.backups.sourceTooLarge', { limit: limits.maxBytes });
      }
    }
    // 逆序入栈，使目录按名称顺序深度优先写入归档。
    for (let index = subdirectories.length - 1; index >= 0; index -= 1) pending.push(subdirectories[index]!);
  }
  return entries;
}

function createProgressReporter(report: ReportProgress, from: number, to: number) {
  let lastAt = 0;
  return (done: number, total: number, key: 'server.backups.progress.archiving' | 'server.backups.progress.extracting') => {
    const now = Date.now();
    if (done < total && now - lastAt < PROGRESS_REPORT_INTERVAL_MS) return;
    lastAt = now;
    const ratio = total > 0 ? Math.min(1, done / total) : 1;
    report(Math.round(from + (to - from) * ratio), { key, params: { done, total } });
  };
}

/**
 * 运行中的服务器：先 save-off 暂停自动保存，再 save-all flush 并等待保存完成提示。
 * 返回的函数恢复自动保存（save-on），可重复调用；失败时已自动恢复。
 */
async function pauseAutosaveAndFlush(instanceId: string, signal: AbortSignal): Promise<() => void> {
  let resumed = false;
  const resume = () => {
    if (resumed) return;
    resumed = true;
    if (processManager.getStatus(instanceId) !== 'running') return;
    try {
      processManager.sendCommand(instanceId, 'save-on');
    } catch {
      // 进程已退出或输入流不可用；重启后服务器默认会开启自动保存。
    }
  };

  const timeoutMs = getSaveConfirmTimeoutMs();
  let pendingLine = '';
  let cleanup = () => {};
  const saved = new Promise<void>((resolve, reject) => {
    const onOutput = (id: string, text: string) => {
      if (id !== instanceId) return;
      // 输出块可能在行中间断开：只判断完整的行，未结束的部分留到下一块。
      const lines = `${pendingLine}${text}`.split(/\r?\n/);
      pendingLine = lines.pop()!.slice(-MAX_PENDING_LINE_CHARS);
      if (lines.some(isSaveConfirmationLine)) {
        cleanup();
        resolve();
      }
    };
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new PanelError('server.backups.saveTimeout', { seconds: Math.round(timeoutMs / 1000) }));
    }, timeoutMs);
    cleanup = () => {
      clearTimeout(timer);
      processManager.off('output', onOutput);
      signal.removeEventListener('abort', onAbort);
    };
    processManager.on('output', onOutput);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  // 先挂监听再发命令，避免错过很快返回的保存提示。
  saved.catch(() => undefined);

  try {
    processManager.sendCommand(instanceId, 'save-off');
    processManager.sendCommand(instanceId, 'save-all flush');
  } catch (error) {
    cleanup();
    resume();
    throw new PanelError('server.backups.commandFailed', { reason: errorParam(error) });
  }
  try {
    await saved;
  } catch (error) {
    resume();
    throw error;
  }
  return resume;
}

/**
 * 把实例目录打包成一份新备份。运行中的服务器会暂停自动保存直到打包结束；
 * 期间服务器启停或崩溃都会取消这次备份。调用方负责持有维护标记。
 */
async function createBackup(
  instanceId: string,
  source: BackupSource,
  signal: AbortSignal,
  report: ReportProgress,
  range: { from: number; to: number },
): Promise<BackupInfo> {
  const row = requireManagedInstance(instanceId);
  const root = getInstanceDir(instanceId);
  const statusAtStart = processManager.getStatus(instanceId);
  if (statusAtStart === 'starting' || statusAtStart === 'stopping') {
    throw new PanelError('server.backups.lifecycleBusy', undefined, { statusCode: 409 });
  }
  const wasRunning = statusAtStart === 'running';

  const stateChanged = new AbortController();
  const combined = AbortSignal.any([signal, stateChanged.signal]);
  const onStatus = (id: string, status: InstanceStatus) => {
    if (id === instanceId && status !== statusAtStart && !stateChanged.signal.aborted) {
      stateChanged.abort(new PanelError('server.backups.serverStateChanged'));
    }
  };
  processManager.on('status', onStatus);

  const dir = instanceBackupDir(instanceId, true)!;
  const backupId = newBackupId();
  const temp = path.join(dir, `${TEMP_PREFIX}${backupId}${ARCHIVE_SUFFIX}`);
  const createdAt = new Date().toISOString();
  let resume: (() => void) | null = null;
  try {
    if (wasRunning) {
      report(range.from, { key: 'server.backups.progress.saving' });
      resume = await pauseAutosaveAndFlush(instanceId, combined);
    }
    report(range.from, { key: 'server.backups.progress.scanning' });
    const entries = scanInstanceDirectory(root);
    const progress = createProgressReporter(report, range.from, range.to);
    const written = await writeBackupArchive({
      output: temp,
      entries,
      header: {
        createdAt,
        instance: {
          id: row.id,
          name: row.name,
          coreType: toCoreType(row.core_type),
          mcVersion: row.mc_version,
          jarFile: row.jar_file,
        },
        wasRunning,
      },
      signal: combined,
      onProgress: (done, total) => progress(done, total, 'server.backups.progress.archiving'),
    });
    resume?.();
    resume = null;
    fs.renameSync(temp, archiveFile(dir, backupId));
    const info: BackupInfo = {
      id: backupId,
      instanceId,
      instanceName: row.name,
      source,
      createdAt,
      sizeBytes: written.sizeBytes,
      fileCount: written.manifest.files.length,
      contentBytes: written.manifest.files.reduce((total, file) => total + file.size, 0),
      coreType: toCoreType(row.core_type),
      mcVersion: row.mc_version,
      wasRunning,
      sha256: written.sha256,
    };
    try {
      writeBackupMeta(dir, info);
    } catch (error) {
      fs.rmSync(archiveFile(dir, backupId), { force: true });
      throw error;
    }
    return info;
  } catch (error) {
    fs.rmSync(temp, { force: true });
    if (combined.aborted) throw abortError(combined);
    throw error;
  } finally {
    processManager.off('status', onStatus);
    resume?.();
  }
}

/** 在实例锁内检查状态并进入维护；失败时不留下维护标记。 */
async function enterMaintenance(
  instanceId: string,
  key: 'server.backups.busyBackingUp' | 'server.backups.busyRestoring',
): Promise<() => void> {
  return processManager.runExclusive(instanceId, async () => {
    const status = processManager.getStatus(instanceId);
    if (key === 'server.backups.busyRestoring' && processManager.isRunning(instanceId)) {
      throw new PanelError('server.backups.restoreRunning', undefined, { statusCode: 409 });
    }
    if (status === 'starting' || status === 'stopping') {
      throw new PanelError('server.backups.lifecycleBusy', undefined, { statusCode: 409 });
    }
    try {
      return processManager.beginMaintenance(instanceId, key);
    } catch (error) {
      // 另一个备份或还原正在进行：统一用 409 返回其消息。
      throw new PanelError(
        processManager.getMaintenance(instanceId) ?? key,
        undefined,
        { statusCode: 409, cause: error },
      );
    }
  });
}

/** 排队一次手动备份；返回任务，完成后 result.backupId 为新备份。 */
export async function startBackupTask(instanceId: string): Promise<TaskInfo> {
  requireManagedInstance(instanceId);
  getInstanceDir(instanceId);
  const release = await enterMaintenance(instanceId, 'server.backups.busyBackingUp');
  try {
    return await runBackgroundTask('backup', { key: 'server.backups.task.backupQueued' }, async (_taskId, signal, report) => {
      try {
        const info = await createBackup(instanceId, 'manual', signal, report, { from: 0, to: 99 });
        return { instanceId, backupId: info.id };
      } finally {
        release();
      }
    }, { timeoutMs: config.backupTaskTimeoutMs });
  } catch (error) {
    release();
    throw error;
  }
}

function assertEnoughSpaceForRestore(contentBytes: number): void {
  let available: number;
  try {
    const stats = fs.statfsSync(config.dataDir);
    available = Number(stats.bavail) * Number(stats.bsize);
  } catch {
    // 平台不支持 statfs 时不阻止还原，空间不足会在解压时报错并清理 staging。
    return;
  }
  const needed = contentBytes + RESTORE_FREE_SPACE_MARGIN_BYTES;
  if (available < needed) {
    throw new PanelError('server.backups.diskSpace', { needed, available });
  }
}

function removeIfEmpty(dir: string): void {
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    /* 忽略 */
  }
}

/**
 * 用已校验的 staging 目录整体替换实例目录。先写换目录标记，再把旧目录移到任务临时目录，
 * 新目录就位后才删除旧目录；第二步失败时立即移回旧目录。必须在实例锁内调用。
 */
function swapInstanceDirectory(taskId: string, instanceId: string, staging: string, marker: string): void {
  const instanceDir = assertSafeInstanceRoot(defaultInstanceDir(instanceId));
  writeOwnershipMarker(instanceId, staging, marker);
  const taskDir = path.dirname(staging);
  const previous = path.join(taskDir, RESTORE_PREVIOUS_DIR);
  const swapMarker = path.join(taskDir, RESTORE_SWAP_MARKER);
  writeFileAtomic(swapMarker, `${JSON.stringify({ version: 1, taskId, instanceId })}\n`);

  fs.renameSync(instanceDir, previous);
  try {
    fs.renameSync(staging, instanceDir);
  } catch (error) {
    try {
      fs.renameSync(previous, instanceDir);
    } catch {
      throw new PanelError('server.backups.rollbackFailed', { path: previous });
    }
    fs.rmSync(swapMarker, { force: true });
    throw new PanelError('server.backups.replaceFailed', { reason: errorParam(error) });
  }
  fs.rmSync(path.join(instanceDir, STAGING_MARKER_FILE), { force: true });
  fs.rmSync(previous, { recursive: true, force: true });
  fs.rmSync(swapMarker, { force: true });
  removeIfEmpty(taskDir);
}

/** jar_file 指向的启动文件（`@args:` 为 Forge 参数文件）；`@modloader` 表示尚未安装，没有可检查的文件。 */
function launchTargetOf(jarFile: string): string | null {
  if (jarFile === '@modloader') return null;
  return jarFile.startsWith('@args:') ? jarFile.slice('@args:'.length) : jarFile;
}

/**
 * 还原后让面板记录的启动文件、核心类型和版本跟随备份清单，避免目录换成旧版本后
 * 仍按新 jar 启动。清单里的启动文件不在还原后的目录中时保持原记录。返回是否有改动。
 */
function syncInstanceRecordWithManifest(instanceId: string, manifest: BackupManifest): boolean {
  const row = getInstanceRow(instanceId);
  const jarFile = manifest.instance.jarFile;
  if (!row || typeof jarFile !== 'string' || jarFile === '') return false;
  const target = launchTargetOf(jarFile);
  if (target === null) return false;
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(resolveSafePath(getInstanceDir(instanceId), target), { throwIfNoEntry: false });
  } catch {
    return false;
  }
  if (!stat?.isFile()) return false;
  const coreType = toCoreType(manifest.instance.coreType) ?? row.core_type;
  const mcVersion = typeof manifest.instance.mcVersion === 'string' ? manifest.instance.mcVersion : null;
  if (jarFile === row.jar_file && coreType === row.core_type && mcVersion === row.mc_version) return false;
  updateInstanceServerFiles(instanceId, { jarFile, coreType, mcVersion });
  return true;
}

async function restoreBackup(
  taskId: string,
  instanceId: string,
  backupId: string,
  backupCurrent: boolean,
  signal: AbortSignal,
  report: ReportProgress,
): Promise<{ instanceRecordUpdated: boolean }> {
  const row = requireManagedInstance(instanceId);
  if (!hasValidOwnershipMarker(row)) throw new PanelError('server.backups.markerInvalid');
  const { info, archive } = getBackupWithArchive(instanceId, backupId);

  let extractFrom = 0;
  if (backupCurrent) {
    report(0, { key: 'server.backups.progress.backingUpCurrent' });
    await createBackup(instanceId, 'pre-restore', signal, report, { from: 0, to: 40 });
    extractFrom = 40;
  }
  assertEnoughSpaceForRestore(info.contentBytes);

  const token = nanoid(32);
  const staging = prepareTaskStaging(taskId, instanceId, token);
  recordTaskStaging(taskId, instanceId, token);
  const progress = createProgressReporter(report, extractFrom, 95);
  try {
    const { manifest } = await readBackupArchive({
      archive,
      limits: archiveLimits(),
      signal,
      destination: staging,
      onProgress: (done) => progress(done, info.fileCount, 'server.backups.progress.extracting'),
    });
    report(96, { key: 'server.backups.progress.replacing' });
    return await processManager.runExclusive(instanceId, async () => {
      if (processManager.isRunning(instanceId)) {
        throw new PanelError('server.backups.restoreRunning', undefined, { statusCode: 409 });
      }
      swapInstanceDirectory(taskId, instanceId, staging, row.ownership_marker!);
      // 文件已经替换成功：同步记录失败不应让整个还原显示为失败，用户仍可在设置里手动改。
      let instanceRecordUpdated = false;
      try {
        instanceRecordUpdated = syncInstanceRecordWithManifest(instanceId, manifest);
      } catch (error) {
        console.warn(`还原已完成，但未能按备份更新实例 ${instanceId} 的启动文件记录`, error);
      }
      return { instanceRecordUpdated };
    });
  } catch (error) {
    if (fs.existsSync(staging)) removeTaskStagingTree(taskId, instanceId);
    throw error;
  }
}

/** 排队还原：服务器必须已停止；默认先备份当前文件。 */
export async function startRestoreTask(
  instanceId: string,
  backupId: string,
  options: { backupCurrent?: boolean } = {},
): Promise<TaskInfo> {
  requireManagedInstance(instanceId);
  getBackup(instanceId, backupId);
  const inUseKey = `${instanceId}/${backupId}`;
  if (backupsInUse.has(inUseKey)) throw new PanelError('server.backups.inUse', undefined, { statusCode: 409 });
  const release = await enterMaintenance(instanceId, 'server.backups.busyRestoring');
  backupsInUse.add(inUseKey);
  const finish = () => {
    release();
    backupsInUse.delete(inUseKey);
  };
  try {
    return await runBackgroundTask('restore', { key: 'server.backups.task.restoreQueued' }, async (taskId, signal, report) => {
      try {
        const restored = await restoreBackup(taskId, instanceId, backupId, options.backupCurrent ?? true, signal, report);
        return { instanceId, backupId, ...restored };
      } finally {
        finish();
      }
    }, { timeoutMs: config.backupTaskTimeoutMs });
  } catch (error) {
    finish();
    throw error;
  }
}

function moveIntoPlace(source: string, target: string): void {
  try {
    fs.renameSync(source, target);
  } catch (error) {
    if (!hasErrorCode(error, 'EXDEV')) throw error;
    // 备份目录在另一块磁盘上：先复制到同目录临时文件，再原子改名。
    const temp = `${path.join(path.dirname(target), TEMP_PREFIX)}${path.basename(target)}`;
    try {
      fs.copyFileSync(source, temp, fs.constants.COPYFILE_EXCL);
      fs.renameSync(temp, target);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }
}

/** 保存上传的备份文件：完整校验通过后才出现在列表中。 */
export async function saveUploadedBackup(instanceId: string, input: Readable): Promise<BackupInfo> {
  requireManagedInstance(instanceId);
  let temp: string;
  try {
    temp = await streamToUploadTemp(input, 'backup', { maxBytes: config.maxBackupUploadBytes });
  } catch (error) {
    if (isUploadTooLargeError(error)) {
      throw new PanelError('server.backups.upload.tooLarge', { limit: config.maxBackupUploadBytes }, { statusCode: 413 });
    }
    throw error;
  }
  try {
    // 校验时顺带算出整个文件的大小与 SHA-256，不再为元数据把文件重读一遍。
    const verified = await readBackupArchive({
      archive: temp,
      limits: archiveLimits(),
      signal: new AbortController().signal,
    });
    const dir = instanceBackupDir(instanceId, true)!;
    const backupId = newBackupId();
    moveIntoPlace(temp, archiveFile(dir, backupId));
    const { manifest } = verified;
    const info: BackupInfo = {
      id: backupId,
      instanceId,
      instanceName: manifest.instance.name,
      source: 'upload',
      createdAt: Number.isNaN(Date.parse(manifest.createdAt)) ? new Date().toISOString() : manifest.createdAt,
      sizeBytes: verified.archiveBytes,
      fileCount: verified.fileCount,
      contentBytes: verified.contentBytes,
      coreType: toCoreType(manifest.instance.coreType),
      mcVersion: typeof manifest.instance.mcVersion === 'string' ? manifest.instance.mcVersion : null,
      wasRunning: manifest.wasRunning,
      sha256: verified.archiveSha256,
    };
    try {
      writeBackupMeta(dir, info);
    } catch (error) {
      fs.rmSync(archiveFile(dir, backupId), { force: true });
      throw error;
    }
    return info;
  } finally {
    if (fs.existsSync(temp)) removeUploadTemp(temp);
  }
}

export type BackupRecovery = {
  restoresRolledBack: number;
  restoresCompleted: number;
  tempFilesRemoved: number;
};

/**
 * 面板启动时（任务恢复之前）处理上次进程留下的还原换目录现场与未写完的备份临时文件：
 * 旧目录已移走而新目录未就位时把旧目录移回；两者都在时说明替换已完成，只做收尾。
 */
export function recoverInterruptedBackups(): BackupRecovery {
  const result: BackupRecovery = { restoresRolledBack: 0, restoresCompleted: 0, tempFilesRemoved: 0 };
  const stagingRoot = path.join(config.dataDir, STAGING_ROOT_DIR);
  if (fs.existsSync(stagingRoot)) {
    for (const taskId of fs.readdirSync(stagingRoot)) {
      const taskDir = path.join(stagingRoot, taskId);
      const swapMarker = path.join(taskDir, RESTORE_SWAP_MARKER);
      if (!fs.existsSync(swapMarker)) continue;
      let instanceId: string;
      try {
        const parsed = JSON.parse(fs.readFileSync(swapMarker, 'utf8')) as { version?: number; taskId?: string; instanceId?: string };
        if (parsed.version !== 1 || parsed.taskId !== taskId || typeof parsed.instanceId !== 'string') continue;
        instanceId = parsed.instanceId;
        defaultInstanceDir(instanceId);
      } catch {
        continue;
      }
      const instanceDir = defaultInstanceDir(instanceId);
      const previous = path.join(taskDir, RESTORE_PREVIOUS_DIR);
      if (fs.existsSync(previous)) {
        if (!fs.existsSync(instanceDir)) {
          fs.renameSync(previous, instanceDir);
          result.restoresRolledBack += 1;
        } else {
          fs.rmSync(path.join(instanceDir, STAGING_MARKER_FILE), { force: true });
          fs.rmSync(previous, { recursive: true, force: true });
          result.restoresCompleted += 1;
        }
      }
      fs.rmSync(swapMarker, { force: true });
    }
  }

  let root: string;
  try {
    root = backupRoot();
  } catch {
    return result;
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(TEMP_PREFIX) && name.endsWith(ARCHIVE_SUFFIX)) {
        fs.rmSync(path.join(dir, name), { force: true });
        result.tempFilesRemoved += 1;
      }
    }
  }
  return result;
}

/** 测试专用：清空内存中的备份占用记录。 */
export function resetBackupRuntimeForTests(): void {
  backupsInUse.clear();
}
