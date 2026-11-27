import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  renderPanelMessage,
  type ExistingServerSourceInfo,
  type ImportExistingServerInput,
  type PanelMessage,
  type ServerFolderCheck,
} from '@mystry/shared';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import {
  OWNERSHIP_MARKER_FILE,
  assertSafeInstanceRoot,
  resolveSafePath,
} from '../utils/path.js';
import { commitStagedInstance } from './instance-service.js';
import { normalizeAndAssertJvmArgs } from './jvm-validation-service.js';
import { detectJvmConfigFile, jvmConfigFileFingerprint } from './jvm-detection-service.js';
import { eulaFileFingerprint, hasAcceptedEula } from './eula-detection.js';
import {
  describeJarLaunchTarget,
  detectJarFile,
  detectServerLaunchTarget,
  isModLoaderScanLimitError,
  resolveImportedCoreType,
  type ModLoaderScanBudget,
} from './server-launch-detect.js';
import { recordTaskStaging, runBackgroundTask } from './task-service.js';
import {
  STAGING_MARKER_FILE,
  prepareTaskStaging,
  removeTaskStagingTree,
  taskStagingDir,
  writeTaskStagingMarker,
} from './task-staging-service.js';
import { createByteCounter } from '../utils/byte-counter.js';
import { errorMessage, hasErrorCode, PanelError, throwIfAborted, toPanelMessage } from '../utils/errors.js';

type SourceScan = {
  entries: number;
  bytes: number;
};

type PrecheckCacheEntry = {
  mtimeMs: number;
  jvmFingerprint: string;
  eulaFingerprint: string;
  info: ExistingServerSourceInfo;
};

const sourcePrecheckCache = new Map<string, PrecheckCacheEntry>();

/** Description shown to the user in the source list: the English text and the message key are both returned, and Web translates by the UI language. */
function sourceError(message: PanelMessage): Pick<ExistingServerSourceInfo, 'error' | 'errorI18n'> {
  return { error: renderPanelMessage(message), errorI18n: message };
}

function modLoaderPrecheckBudget(): ModLoaderScanBudget {
  return {
    maxDepth: config.modLoaderPrecheckMaxDepth,
    maxEntries: config.modLoaderPrecheckMaxEntries,
    deadlineMs: config.modLoaderPrecheckTimeoutMs,
  };
}

function modLoaderFullScanBudget(signal: AbortSignal): ModLoaderScanBudget {
  return {
    maxDepth: config.modLoaderScanMaxDepth,
    maxEntries: config.modLoaderScanMaxEntries,
    deadlineMs: config.modLoaderScanTimeoutMs,
    signal,
  };
}

function assertSourceId(sourceId: string): void {
  if (
    sourceId.length === 0
    || sourceId.length > 255
    || sourceId === '.'
    || sourceId === '..'
    || sourceId.includes('/')
    || sourceId.includes('\\')
    || /[\u0000-\u001f]/.test(sourceId)
  ) {
    throw new PanelError('server.imports.existing.invalidSourceId');
  }
}

/** Only direct subdirectories of DATA_DIR/imports may be resolved; system paths are not accepted. */
export function resolveExistingServerSource(sourceId: string): string {
  assertSourceId(sourceId);
  const importRoot = assertSafeInstanceRoot(config.existingServerImportDir);
  const sourceDir = path.resolve(importRoot, sourceId);
  const relative = path.relative(importRoot, sourceDir);
  if (relative !== sourceId || path.isAbsolute(relative)) {
    throw new PanelError('server.imports.existing.outsideImportDir');
  }
  return assertSafeInstanceRoot(sourceDir);
}

/**
 * Prechecks a server folder: finds the launch file, recognizes the core and version, and reads user_jvm_args.txt.
 * Shared by the imports source and browser-uploaded folders; unexpected errors such as an unreadable folder are thrown as usual, and the caller turns them into a cannot-import description.
 */
export async function precheckServerFolder(sourceDir: string): Promise<ServerFolderCheck> {
  const withJvmConfig = (check: ServerFolderCheck): ServerFolderCheck => {
    const detectedJvmConfig = detectJvmConfigFile(sourceDir, check.coreType);
    return {
      ...check,
      ...(detectedJvmConfig ? { detectedJvmConfig } : {}),
      ...(hasAcceptedEula(sourceDir) ? { eulaAccepted: true } : {}),
    };
  };

  const rootNames = fs.readdirSync(sourceDir);
  if (rootNames.some((name) => name.toLowerCase() === OWNERSHIP_MARKER_FILE.toLowerCase())) {
    throw new PanelError('server.imports.existing.managedMarker');
  }
  const reservedStaging = rootNames.find((name) => name.toLowerCase() === STAGING_MARKER_FILE.toLowerCase());
  if (reservedStaging) {
    throw new PanelError('server.imports.folder.reservedName', { path: reservedStaging });
  }

  const jarFile = detectJarFile(sourceDir);
  if (jarFile) {
    const described = describeJarLaunchTarget(jarFile);
    return withJvmConfig({
      launchTarget: jarFile,
      coreType: described.coreType,
      ...(described.mcVersion ? { mcVersion: described.mcVersion } : {}),
      ready: true,
    });
  }

  try {
    const launchTarget = await detectServerLaunchTarget(sourceDir, modLoaderPrecheckBudget());
    if (launchTarget) {
      return withJvmConfig({
        launchTarget: launchTarget.value,
        coreType: launchTarget.coreType,
        ...(launchTarget.mcVersion ? { mcVersion: launchTarget.mcVersion } : {}),
        ready: true,
      });
    }
  } catch (error) {
    if (isModLoaderScanLimitError(error)) {
      return withJvmConfig({
        launchTarget: null,
        coreType: 'custom',
        ready: true,
        ...sourceError({ key: 'server.imports.existing.precheckIncomplete' }),
      });
    }
    throw error;
  }

  return withJvmConfig({
    launchTarget: null,
    coreType: 'custom',
    ready: false,
    ...sourceError({ key: 'server.imports.existing.noLaunchTarget' }),
  });
}

/** Turns an unexpected error thrown by the precheck into a "cannot import" result, with the reason returned along with the message key. */
export function failedServerFolderCheck(error: unknown): ServerFolderCheck {
  const errorI18n = toPanelMessage(error);
  return {
    launchTarget: null,
    coreType: 'custom',
    ready: false,
    error: errorMessage(error),
    ...(errorI18n ? { errorI18n } : {}),
  };
}

async function inspectSource(sourceId: string): Promise<ExistingServerSourceInfo> {
  try {
    const sourceDir = resolveExistingServerSource(sourceId);
    const stat = fs.statSync(sourceDir);
    const jvmFingerprint = jvmConfigFileFingerprint(sourceDir);
    const eulaFingerprint = eulaFileFingerprint(sourceDir);
    const cached = sourcePrecheckCache.get(sourceId);
    if (
      cached
      && cached.mtimeMs === stat.mtimeMs
      && cached.jvmFingerprint === jvmFingerprint
      && cached.eulaFingerprint === eulaFingerprint
    ) {
      return cached.info;
    }
    const check = await precheckServerFolder(sourceDir);
    const info: ExistingServerSourceInfo = { id: sourceId, ...check, modifiedAt: stat.mtime.toISOString() };
    sourcePrecheckCache.set(sourceId, { mtimeMs: stat.mtimeMs, jvmFingerprint, eulaFingerprint, info });
    return info;
  } catch (error) {
    return { id: sourceId, ...failedServerFolderCheck(error), modifiedAt: new Date(0).toISOString() };
  }
}

export async function listExistingServerSources(): Promise<ExistingServerSourceInfo[]> {
  const importRoot = assertSafeInstanceRoot(config.existingServerImportDir);
  const entries = fs
    .readdirSync(importRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));

  const sources: ExistingServerSourceInfo[] = [];
  for (const sourceId of entries) {
    sources.push(await inspectSource(sourceId));
  }
  return sources;
}

function checkScanLimits(scan: SourceScan): void {
  if (scan.entries > config.maxExistingImportEntries) {
    throw new PanelError('server.imports.existing.tooManyEntries', { limit: config.maxExistingImportEntries });
  }
  if (scan.bytes > config.maxExistingImportBytes) {
    throw new PanelError('server.imports.existing.tooLarge', { limit: config.maxExistingImportBytes });
  }
}

async function scanSourceDirectory(
  sourceRoot: string,
  signal: AbortSignal,
): Promise<SourceScan> {
  const scan: SourceScan = { entries: 0, bytes: 0 };

  async function walk(relativeDirectory: string): Promise<void> {
    throwIfAborted(signal);
    const current = relativeDirectory
      ? resolveSafePath(sourceRoot, relativeDirectory)
      : assertSafeInstanceRoot(sourceRoot);
    assertSafeInstanceRoot(current);
    const entries = await fs.promises.readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      throwIfAborted(signal);
      if (!relativeDirectory && entry.name.toLowerCase() === OWNERSHIP_MARKER_FILE.toLowerCase()) {
        throw new PanelError('server.imports.existing.markerRefused');
      }
      if (!relativeDirectory && entry.name.toLowerCase() === STAGING_MARKER_FILE.toLowerCase()) {
        throw new PanelError('server.imports.folder.reservedName', { path: entry.name });
      }

      const relative = path.join(relativeDirectory, entry.name);
      const source = resolveSafePath(sourceRoot, relative);
      const stat = await fs.promises.lstat(source);
      if (stat.isSymbolicLink()) {
        throw new PanelError('server.imports.existing.symlink', { path: relative });
      }

      scan.entries += 1;
      if (stat.isDirectory()) {
        assertSafeInstanceRoot(source);
        checkScanLimits(scan);
        await walk(relative);
        continue;
      }
      if (!stat.isFile()) {
        throw new PanelError('server.imports.existing.specialFile', { path: relative });
      }
      scan.bytes += stat.size;
      checkScanLimits(scan);
    }
  }

  await walk('');
  return scan;
}

function assertEnoughDiskSpace(instanceRoot: string, requiredBytes: number): void {
  const stat = fs.statfsSync(instanceRoot);
  const availableBytes = BigInt(stat.bavail) * BigInt(stat.bsize);
  if (BigInt(requiredBytes) > availableBytes) {
    throw new PanelError('server.imports.existing.diskSpace');
  }
}

async function copySourceDirectory(
  sourceRoot: string,
  instanceRoot: string,
  scan: SourceScan,
  signal: AbortSignal,
  report: (progress: number, message: PanelMessage) => void,
): Promise<void> {
  let copiedEntries = 0;
  let copiedBytes = 0;
  let lastProgress = -1;

  function reportCopyProgress(): void {
    const ratio = scan.bytes > 0
      ? copiedBytes / scan.bytes
      : copiedEntries / Math.max(scan.entries, 1);
    const progress = Math.min(90, 20 + Math.floor(ratio * 70));
    if (progress === lastProgress) return;
    lastProgress = progress;
    report(progress, {
      key: 'server.imports.existing.progress.copying',
      params: { copied: copiedEntries, total: scan.entries },
    });
  }

  async function walk(relativeDirectory: string): Promise<void> {
    throwIfAborted(signal);
    const sourceDirectory = relativeDirectory
      ? resolveSafePath(sourceRoot, relativeDirectory)
      : assertSafeInstanceRoot(sourceRoot);
    const entries = await fs.promises.readdir(sourceDirectory, { withFileTypes: true });

    for (const entry of entries) {
      throwIfAborted(signal);
      if (!relativeDirectory && entry.name.toLowerCase() === OWNERSHIP_MARKER_FILE.toLowerCase()) {
        throw new PanelError('server.imports.existing.markerRefused');
      }
      if (!relativeDirectory && entry.name.toLowerCase() === STAGING_MARKER_FILE.toLowerCase()) {
        throw new PanelError('server.imports.folder.reservedName', { path: entry.name });
      }

      const relative = path.join(relativeDirectory, entry.name);
      const source = resolveSafePath(sourceRoot, relative);
      const target = resolveSafePath(instanceRoot, relative);
      const stat = await fs.promises.lstat(source);
      if (stat.isSymbolicLink()) {
        throw new PanelError('server.imports.existing.symlink', { path: relative });
      }

      copiedEntries += 1;
      if (copiedEntries > config.maxExistingImportEntries) {
        throw new PanelError('server.imports.existing.tooManyEntries', { limit: config.maxExistingImportEntries });
      }

      if (stat.isDirectory()) {
        assertSafeInstanceRoot(source);
        // Fixed permissions are used instead of inheriting the source directory's mode, so special permissions on the source side are not carried into the panel-managed directory.
        await fs.promises.mkdir(target, { mode: 0o700 });
        await walk(relative);
        reportCopyProgress();
        continue;
      }
      if (!stat.isFile()) {
        throw new PanelError('server.imports.existing.specialFile', { path: relative });
      }

      let fileBytes = 0;
      const meter = createByteCounter((chunkBytes) => {
        fileBytes += chunkBytes;
        return copiedBytes + fileBytes > config.maxExistingImportBytes
          ? new PanelError('server.imports.existing.tooLarge', { limit: config.maxExistingImportBytes })
          : undefined;
      });
      // Open the source file fd first and then validate with fstat, closing the TOCTOU window where the file is replaced between lstat and the read stream.
      const sourceFd = await fs.promises.open(source, 'r');
      try {
        const fdStat = await sourceFd.stat();
        if (!fdStat.isFile()) {
          throw new PanelError('server.imports.existing.specialFile', { path: relative });
        }
        await pipeline(
          sourceFd.createReadStream(),
          meter,
          fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }),
          { signal },
        );
      } finally {
        await sourceFd.close();
      }
      copiedBytes += fileBytes;
      reportCopyProgress();
    }
  }

  await walk('');
}

/** Instance settings the import task needs; jvmArgs is already normalized before queuing. */
export type ServerFolderImportInput = Omit<ImportExistingServerInput, 'sourceId' | 'jvmArgs'> & { jvmArgs: string };

/**
 * How a server folder gets into staging:
 * - copy: a source in the imports handoff area is read-only, so files are copied one by one and the original folder is kept.
 * - move: a folder uploaded from the browser into the panel's temp directory belongs to the panel, so it is renamed into staging as a whole without taking up a second copy of the space.
 */
export type ServerFolderTransfer = 'copy' | 'move';

const FOLDER_TASK_TEXT = {
  copy: {
    validating: 'server.imports.existing.progress.validating',
    done: 'server.imports.existing.progress.done',
  },
  move: {
    validating: 'server.imports.folder.progress.validating',
    done: 'server.imports.folder.progress.done',
  },
} as const;

/**
 * Renames the uploaded folder into staging as a whole. The staging marker is written inside the folder before renaming,
 * so if the panel exits after the rename, crash recovery can recognize it by the marker and clean it up. When the temp directory and staging are not on the same drive, fall back to copying file by file.
 */
async function moveFolderIntoStaging(
  sourceRoot: string,
  taskId: string,
  instanceId: string,
  stagingToken: string,
  signal: AbortSignal,
  report: (progress: number, message: PanelMessage) => void,
): Promise<string> {
  const stagingRoot = taskStagingDir(taskId, instanceId);
  writeTaskStagingMarker(sourceRoot, { version: 1, taskId, instanceId, token: stagingToken });
  fs.mkdirSync(path.dirname(stagingRoot), { recursive: true, mode: 0o700 });
  try {
    fs.renameSync(sourceRoot, stagingRoot);
    return stagingRoot;
  } catch (error) {
    if (!hasErrorCode(error, 'EXDEV')) throw error;
  }
  fs.rmSync(path.join(sourceRoot, STAGING_MARKER_FILE), { force: true });
  const scan = await scanSourceDirectory(sourceRoot, signal);
  const copiedRoot = prepareTaskStaging(taskId, instanceId, stagingToken);
  assertEnoughDiskSpace(copiedRoot, scan.bytes);
  await copySourceDirectory(sourceRoot, copiedRoot, scan, signal, report);
  return copiedRoot;
}

/**
 * Imports a server folder as a panel instance: check the launch file → copy or move into staging → confirm the launch file again → move atomically and register.
 * Shared by the imports handoff area and browser-uploaded folders; when the task fails only this task's staging is cleaned up.
 */
export async function runServerFolderImport(
  taskId: string,
  signal: AbortSignal,
  report: (progress: number, message: PanelMessage) => void,
  input: ServerFolderImportInput,
  source: { transfer: ServerFolderTransfer; resolveRoot: () => string },
): Promise<{ instanceId: string }> {
  const text = FOLDER_TASK_TEXT[source.transfer];
  let instanceId: string | null = null;
  let completed = false;
  try {
    throwIfAborted(signal);
    const sourceRoot = assertSafeInstanceRoot(source.resolveRoot());
    report(5, { key: text.validating });
    // Scan everything once before copying: links, special files and quotas. Browser-uploaded folders were already checked file by file on receipt and are not scanned again.
    const scan = source.transfer === 'copy' ? await scanSourceDirectory(sourceRoot, signal) : null;
    const sourceLaunchTarget = await detectServerLaunchTarget(
      sourceRoot,
      modLoaderFullScanBudget(signal),
    );
    if (!sourceLaunchTarget) {
      throw new PanelError('server.imports.existing.missingLaunchTarget');
    }

    throwIfAborted(signal);
    instanceId = nanoid(12);
    const stagingToken = nanoid(32);
    recordTaskStaging(taskId, instanceId, stagingToken);
    let stagingRoot: string;
    if (scan) {
      stagingRoot = prepareTaskStaging(taskId, instanceId, stagingToken);
      assertEnoughDiskSpace(stagingRoot, scan.bytes);
      report(20, { key: 'server.imports.existing.progress.copyStart' });
      await copySourceDirectory(sourceRoot, stagingRoot, scan, signal, report);
    } else {
      report(30, { key: 'server.imports.folder.progress.moving' });
      stagingRoot = await moveFolderIntoStaging(sourceRoot, taskId, instanceId, stagingToken, signal, report);
    }

    throwIfAborted(signal);
    report(92, { key: 'server.imports.existing.progress.confirmingLaunch' });
    const copiedLaunchTarget = await detectServerLaunchTarget(
      stagingRoot,
      modLoaderFullScanBudget(signal),
    );
    if (!copiedLaunchTarget) {
      throw new PanelError('server.imports.existing.copiedNoLaunchTarget');
    }

    report(95, { key: 'server.imports.progress.writingInstance' });
    throwIfAborted(signal);
    commitStagedInstance(
      taskId,
      instanceId,
      {
        name: input.name.trim(),
        coreType: resolveImportedCoreType(input.coreType, copiedLaunchTarget.coreType),
        mcVersion: input.mcVersion?.trim() || copiedLaunchTarget.mcVersion || undefined,
        jarFile: copiedLaunchTarget.value,
        jvmArgs: input.jvmArgs,
        acceptEula: input.acceptEula,
        javaRuntimeId: input.javaRuntimeId ?? null,
      },
      { writeEulaIfAccepted: true },
    );
    completed = true;

    report(100, { key: text.done });
    return { instanceId };
  } finally {
    if (!completed && instanceId) {
      try {
        await removeTaskStagingTree(taskId, instanceId);
      } catch {
        /* A cleanup failure does not override the original error */
      }
    }
  }
}

export async function importExistingServerDirectory(input: ImportExistingServerInput) {
  // Reject a path-like or nonexistent sourceId before taking a task queue slot; it is validated again when the task runs.
  resolveExistingServerSource(input.sourceId);
  const { sourceId, ...settings } = input;
  const taskInput: ServerFolderImportInput = {
    ...settings,
    jvmArgs: normalizeAndAssertJvmArgs(input.jvmArgs ?? '-Xms1G -Xmx2G', {
      coreType: input.coreType,
      javaRuntimeId: input.javaRuntimeId,
    }),
  };

  return runBackgroundTask('import', { key: 'server.imports.existing.task.queued' }, (taskId, signal, report) =>
    runServerFolderImport(taskId, signal, report, taskInput, {
      transfer: 'copy',
      resolveRoot: () => resolveExistingServerSource(sourceId),
    }));
}
