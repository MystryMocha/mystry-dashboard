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

/** Backup ID: UTC time + a 6-character random suffix, also the file name stem. */
const BACKUP_ID_PATTERN = /^\d{8}-\d{6}-[A-Za-z0-9_-]{6}$/;
const ARCHIVE_SUFFIX = '.tar.gz';
const META_SUFFIX = '.json';
const TEMP_PREFIX = '.tmp-';
/** The marker and old directory written under .mystry-staging/<taskId>/ during a restore directory swap, for rollback or finishing up after a crash. */
const RESTORE_SWAP_MARKER = '.mystry-restore-swap.json';
const RESTORE_PREVIOUS_DIR = '.mystry-restore-previous';
/** Extra free space required before a restore, reserved for the database and logs. */
const RESTORE_FREE_SPACE_MARGIN_BYTES = 64 * 1024 * 1024;
/**
 * The message the server itself prints once save-all flush completes: Saved the game since 1.13, Saved the world in 1.12 and earlier.
 * Paper 26.3 prints it as `System chat: Saved the game` (other 26.x servers not checked); without accepting that prefix every
 * backup of a running Paper 26.3 server waited out the timeout and was cancelled.
 * Only the whole message after the log prefix is compared, so player chat (`<Steve> Saved the game`) is not taken as save complete.
 */
const SAVE_CONFIRM_MESSAGE = /^(?:System chat: )?(?:Saved the (?:game|world)|All dimensions are saved)\.?$/i;
/** Separator between the log line prefix and the message: Vanilla/Forge `[..] [Server thread/INFO]: `, Paper `[.. INFO]: `. */
const LOG_MESSAGE_SEPARATOR = ']: ';
const ANSI_ESCAPE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const MAX_PENDING_LINE_CHARS = 4096;
const defaultSaveConfirmTimeoutMs = 60_000;
/** Files exclusively locked by the JVM while the server runs (unreadable on Windows); they are regenerated at startup and do not go into backups. */
const SKIPPED_FILE_NAMES = new Set(['session.lock']);
const PROGRESS_REPORT_INTERVAL_MS = 250;

type ReportProgress = (progress: number, message: PanelMessage) => void;

/** Backups in use by a restore task, which must not be deleted. The key is `<instance ID>/<backup ID>`. */
const backupsInUse = new Set<string>();

function getSaveConfirmTimeoutMs(): number {
  const fromEnv = process.env.MYSTRY_TEST_BACKUP_SAVE_TIMEOUT_MS;
  if (!fromEnv) return defaultSaveConfirmTimeoutMs;
  const parsed = Number(fromEnv);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultSaveConfirmTimeoutMs;
}

/** Tells whether a line of console output is the save-complete message printed by the server itself. */
export function isSaveConfirmationLine(line: string): boolean {
  const text = line.replace(ANSI_ESCAPE, '').trim();
  const separator = text.indexOf(LOG_MESSAGE_SEPARATOR);
  // Bare output without a log prefix can only come from the server process itself (chat and /say both carry a prefix).
  const message = separator === -1 ? text : text.slice(separator + LOG_MESSAGE_SEPARATOR.length).trim();
  return SAVE_CONFIRM_MESSAGE.test(message);
}

function archiveLimits(): BackupArchiveLimits {
  // Shares the entry count and total size quotas with the local directory handoff: both copy a whole server into the managed directory.
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

/** Backup root: must not be inside the instance, handoff, upload or task temp directories, nor contain the whole data root. */
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
  // Reuse instance ID validation, so arbitrary strings are not joined into a path.
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

const BACKUP_SOURCES: readonly BackupSource[] = ['manual', 'pre-restore', 'upload', 'scheduled'];

/** Reads the metadata; returns null when the content is corrupted, the fields do not match or the archive is missing (it is not shown in the list). */
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

export function requireManagedInstance(instanceId: string): InstanceRow {
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

/** A verified backup record with the absolute path of its archive, for download, restore and delete. */
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
  // Rename the archive to a temp file name first: whatever step fails afterwards, what is left is a temp file that startup cleans up.
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
    // When the file is still in use, leave it for recoverInterruptedBackups() to clean up on the next start.
  }
}

/** Deletes all of an instance's backups along with the instance. */
export function deleteInstanceBackups(instanceId: string): void {
  // Reuse instance ID validation, so arbitrary strings are not joined into a path.
  defaultInstanceDir(instanceId);
  const dir = path.join(backupRoot(), instanceId);
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PanelError('server.backups.dirUnsafe');
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Lists the instance directory: skips marker files maintained by the panel; a symlink or directory junction is rejected outright. */
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
        // Special files such as sockets and pipes cannot be restored and are skipped.
        continue;
      }
      if (entries.length > limits.maxEntries) {
        throw new PanelError('server.backups.sourceTooManyEntries', { limit: limits.maxEntries });
      }
      if (totalBytes > limits.maxBytes) {
        throw new PanelError('server.backups.sourceTooLarge', { limit: limits.maxBytes });
      }
    }
    // Pushed in reverse order, so directories are written into the archive depth-first in name order.
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
 * A running server: save-off first to pause autosave, then save-all flush and wait for the save-complete notice.
 * The returned function restores autosave (save-on) and can be called repeatedly; on failure it has already been restored.
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
      // The process has exited or the input stream is unavailable; after a restart the server turns autosave on by default.
    }
  };

  const timeoutMs = getSaveConfirmTimeoutMs();
  let pendingLine = '';
  let cleanup = () => {};
  const saved = new Promise<void>((resolve, reject) => {
    const onOutput = (id: string, text: string) => {
      if (id !== instanceId) return;
      // An output chunk may break in the middle of a line: only complete lines are checked, and the unfinished part is kept for the next chunk.
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
  // Attach the listener before sending the command, so a save notice that returns quickly is not missed.
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
 * Packs the instance directory into a new backup. A running server has autosave paused until packing ends;
 * the server starting, stopping or crashing meanwhile cancels this backup. The caller is responsible for holding the maintenance flag.
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

/**
 * Checks the state and enters maintenance inside the instance lock; no maintenance flag is left behind on failure.
 * The task that follows ends maintenance through its `onSettled`, not at the end of its worker: a task can be over
 * without its worker having been called, and the instance would then refuse to start, back up or be deleted until the
 * panel restarts.
 */
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
      // Another backup or restore is in progress: its message is returned uniformly as a 409.
      throw new PanelError(
        processManager.getMaintenance(instanceId) ?? key,
        undefined,
        { statusCode: 409, cause: error },
      );
    }
  });
}

/** Queues a manual backup; returns the task, and on completion result.backupId is the new backup. */
export async function startBackupTask(instanceId: string): Promise<TaskInfo> {
  requireManagedInstance(instanceId);
  getInstanceDir(instanceId);
  const release = await enterMaintenance(instanceId, 'server.backups.busyBackingUp');
  try {
    return await runBackgroundTask('backup', { key: 'server.backups.task.backupQueued' }, async (_taskId, signal, report) => {
      const info = await createBackup(instanceId, 'manual', signal, report, { from: 0, to: 99 });
      return { instanceId, backupId: info.id };
    }, { timeoutMs: config.backupTaskTimeoutMs, onSettled: release });
  } catch (error) {
    release();
    throw error;
  }
}

export type ScheduledBackupOptions = {
  /**
   * How many scheduled backups to keep, or null when that is no longer known, in which case none is deleted.
   * It is read when older backups are about to be deleted, not when the run is queued: packing a large world takes long
   * enough for the number to be changed meanwhile, and a backup the user has just asked to keep must not be deleted.
   */
  keep: () => number | null;
  /** Free space required on top of the size of the instance's previous backup. */
  freeSpaceMarginBytes: number;
  /** Free bytes on the disk that holds a directory, or null when the platform cannot tell. Replaced in tests. */
  readFreeBytes?: (dir: string) => number | null;
  /** Called with the new backup while the instance is still in maintenance, before older scheduled backups are deleted. */
  onCreated: (info: BackupInfo) => void;
  /** Called with the reason when no backup was made. */
  onFailed: (error: unknown) => void;
};

function freeBytesOn(dir: string): number | null {
  try {
    const stats = fs.statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    // When the platform does not support statfs the backup is not blocked; running out of space then fails while packing, and the temp file is removed.
    return null;
  }
}

/**
 * Nobody is watching a scheduled run, and filling the disk under a running server can damage the world it is saving.
 * The previous backup is the best estimate of the next one's size; with no previous backup there is nothing to estimate from.
 * The space is read where the archive is written: BACKUP_DIR may be on another disk than the data directory.
 */
function assertEnoughSpaceForScheduledBackup(instanceId: string, options: ScheduledBackupOptions): void {
  const [previous] = listBackups(instanceId);
  if (!previous) return;
  const available = (options.readFreeBytes ?? freeBytesOn)(instanceBackupDir(instanceId, true)!);
  if (available === null) return;
  const needed = previous.sizeBytes + options.freeSpaceMarginBytes;
  if (available < needed) {
    throw new PanelError('server.backups.schedule.diskSpace', { needed, available });
  }
}

/**
 * Deletes this instance's scheduled backups beyond the newest `keep`, oldest first; backups from every other source are
 * never touched. Each one goes through deleteBackup, so a backup in use by a restore is refused and stays.
 * Whatever could not be deleted is still beyond the count after the next scheduled backup, and is tried again then.
 * `newestId` names the backup a run has just made; it counts as the newest whatever its date says.
 */
export function pruneScheduledBackups(
  instanceId: string,
  keep: number,
  newestId?: string,
): { deleted: string[]; kept: string[] } {
  const result: { deleted: string[]; kept: string[] } = { deleted: [], kept: [] };
  // Anything but a positive whole number would make slice() below start from the newest backup.
  if (!Number.isSafeInteger(keep) || keep < 1) return result;
  const scheduled = listBackups(instanceId).filter((backup) => backup.source === 'scheduled');
  // The list is ordered by creation date. After the computer's clock is set back, the backup just made carries an
  // earlier date than the ones already there, and going by date alone it would be the first one deleted.
  const ranked = [
    ...scheduled.filter((backup) => backup.id === newestId),
    ...scheduled.filter((backup) => backup.id !== newestId),
  ];
  for (const backup of ranked.slice(keep).reverse()) {
    try {
      deleteBackup(instanceId, backup.id);
      result.deleted.push(backup.id);
    } catch (error) {
      result.kept.push(backup.id);
      if (!(error instanceof PanelError && error.messageKey === 'server.backups.inUse')) {
        console.warn(`未能删除实例 ${instanceId} 超出保留数量的定时备份 ${backup.id}`, error);
      }
    }
  }
  return result;
}

/**
 * Deletes the scheduled backups beyond the number to keep as it stands now, and returns how many went. Never throws:
 * failing to delete older backups must not turn a backup that exists into a failed task, nor replace the reason a run
 * gives for having made none.
 */
function applyScheduledRetention(instanceId: string, options: ScheduledBackupOptions, newestId?: string): number {
  try {
    const keep = options.keep();
    return keep === null ? 0 : pruneScheduledBackups(instanceId, keep, newestId).deleted.length;
  } catch (error) {
    console.warn(`未能清理实例 ${instanceId} 超出保留数量的定时备份`, error);
    return 0;
  }
}

/**
 * Retention runs after a backup succeeds, which a full disk never lets happen: lowering the number to keep would then
 * free nothing, and every later run would fail the same way. So when space is short, the scheduled backups already
 * beyond that number are deleted first and the space is read again. Backups within the number stay, because no newer
 * one exists yet to take their place.
 */
function makeRoomForScheduledBackup(instanceId: string, options: ScheduledBackupOptions): void {
  try {
    assertEnoughSpaceForScheduledBackup(instanceId, options);
    return;
  } catch (error) {
    const outOfSpace = error instanceof PanelError && error.messageKey === 'server.backups.schedule.diskSpace';
    if (!outOfSpace || applyScheduledRetention(instanceId, options) === 0) throw error;
  }
  assertEnoughSpaceForScheduledBackup(instanceId, options);
}

/**
 * Queues a scheduled backup, then deletes scheduled backups beyond `keep`; when the disk is short of space, those are
 * deleted before packing as well. Throws only when the backup cannot be queued
 * now (the instance is busy, another task is running or waiting, or the task queue is shutting down); every later
 * failure is a failed task whose reason names the instance, since nobody had its page open when it ran.
 */
export async function startScheduledBackupTask(instanceId: string, options: ScheduledBackupOptions): Promise<TaskInfo> {
  const name = getInstanceRow(instanceId)?.name ?? instanceId;
  const release = await enterMaintenance(instanceId, 'server.backups.busyBackingUp');
  try {
    return await runBackgroundTask('backup', { key: 'server.backups.task.scheduledQueued', params: { name } }, async (_taskId, signal, report) => {
      let info: BackupInfo;
      try {
        makeRoomForScheduledBackup(instanceId, options);
        info = await createBackup(instanceId, 'scheduled', signal, report, { from: 0, to: 99 });
      } catch (error) {
        options.onFailed(error);
        throw new PanelError('server.backups.schedule.runFailed', { name, reason: errorParam(error) }, { cause: error });
      }
      options.onCreated(info);
      applyScheduledRetention(instanceId, options, info.id);
      return { instanceId, backupId: info.id };
    }, { timeoutMs: config.backupTaskTimeoutMs, onlyWhenIdle: true, onSettled: release });
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
    // When the platform does not support statfs the restore is not blocked; running out of space fails during extraction and the staging is cleaned up.
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
    /* Ignore */
  }
}

/**
 * Replaces the instance directory as a whole with the verified staging directory. The swap marker is written first, then the old directory is moved into the task temp directory,
 * and the old directory is deleted only after the new one is in place; if the second step fails, the old directory is moved back immediately. Must be called inside the instance lock.
 */
async function swapInstanceDirectory(taskId: string, instanceId: string, staging: string, marker: string): Promise<void> {
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
  // The old directory is a whole server, so its removal is awaited rather than done with rmSync, which would hold every request
  // and all console output until it finished. The caller keeps the instance lock and the maintenance flag meanwhile. The swap
  // marker is still removed last: if the panel exits during the removal, the next start finishes it.
  await fs.promises.rm(previous, { recursive: true, force: true });
  fs.rmSync(swapMarker, { force: true });
  removeIfEmpty(taskDir);
}

/** The launch file jar_file points at (`@args:` is a Forge args file); `@modloader` means not installed yet, so there is no file to check. */
function launchTargetOf(jarFile: string): string | null {
  if (jarFile === '@modloader') return null;
  return jarFile.startsWith('@args:') ? jarFile.slice('@args:'.length) : jarFile;
}

/**
 * After a restore, makes the launch file, core type and version recorded by the panel follow the backup manifest, so the directory is not switched to an old version
 * while still launching with the new jar. When the manifest's launch file is not in the restored directory, the existing record is kept. Returns whether anything changed.
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
      await swapInstanceDirectory(taskId, instanceId, staging, row.ownership_marker!);
      // The files were already replaced successfully: a failure to sync the record should not make the whole restore show as failed, and the user can still change it manually in settings.
      let instanceRecordUpdated = false;
      try {
        instanceRecordUpdated = syncInstanceRecordWithManifest(instanceId, manifest);
      } catch (error) {
        console.warn(`还原已完成，但未能按备份更新实例 ${instanceId} 的启动文件记录`, error);
      }
      return { instanceRecordUpdated };
    });
  } catch (error) {
    if (fs.existsSync(staging)) await removeTaskStagingTree(taskId, instanceId);
    throw error;
  }
}

/** Queues a restore: the server must be stopped; the current files are backed up first by default. */
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
      const restored = await restoreBackup(taskId, instanceId, backupId, options.backupCurrent ?? true, signal, report);
      return { instanceId, backupId, ...restored };
    }, { timeoutMs: config.backupTaskTimeoutMs, onSettled: finish });
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
    // The backup directory is on another disk: copy to a temp file in the same directory first, then rename atomically.
    const temp = `${path.join(path.dirname(target), TEMP_PREFIX)}${path.basename(target)}`;
    try {
      fs.copyFileSync(source, temp, fs.constants.COPYFILE_EXCL);
      fs.renameSync(temp, target);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }
}

/** Saves an uploaded backup file: it appears in the list only after full verification passes. */
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
    // The whole file's size and SHA-256 are computed along the way during verification, so the file is not re-read for the metadata.
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
 * At panel startup (before task recovery), handles the restore directory swap state and unfinished backup temp files left by the previous process:
 * when the old directory was moved away and the new one is not in place, the old one is moved back; when both exist the replacement had completed, so only finishing up is done.
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

/** Tests only: clears the in-memory record of backups in use. */
export function resetBackupRuntimeForTests(): void {
  backupsInUse.clear();
}
