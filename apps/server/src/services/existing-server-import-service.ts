import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  renderPanelMessage,
  type ExistingServerSourceInfo,
  type ImportExistingServerInput,
  type PanelMessage,
} from '@mystry/shared';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import {
  OWNERSHIP_MARKER_FILE,
  assertSafeInstanceRoot,
  resolveSafePath,
} from '../utils/path.js';
import { registerPromotedInstance } from './instance-service.js';
import { normalizeAndAssertJvmArgs } from './jvm-validation-service.js';
import { detectJvmConfigFile, jvmConfigFileFingerprint } from './jvm-detection-service.js';
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
  prepareTaskStaging,
  promoteTaskStagingToInstance,
  removeTaskStagingTree,
} from './task-staging-service.js';
import { createByteCounter } from '../utils/byte-counter.js';
import { errorMessage, PanelError, throwIfAborted, toPanelMessage } from '../utils/errors.js';

type SourceScan = {
  entries: number;
  bytes: number;
};

type PrecheckCacheEntry = {
  mtimeMs: number;
  jvmFingerprint: string;
  info: ExistingServerSourceInfo;
};

const sourcePrecheckCache = new Map<string, PrecheckCacheEntry>();

/** 来源列表中显示给用户的说明：英文文本与消息键同时返回，Web 按界面语言翻译。 */
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

/** 只允许解析 DATA_DIR/imports 下的直接子目录，不接受系统路径。 */
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

async function inspectSource(sourceId: string): Promise<ExistingServerSourceInfo> {
  try {
    const sourceDir = resolveExistingServerSource(sourceId);
    const stat = fs.statSync(sourceDir);
    const jvmFingerprint = jvmConfigFileFingerprint(sourceDir);
    const cached = sourcePrecheckCache.get(sourceId);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.jvmFingerprint === jvmFingerprint) {
      return cached.info;
    }

    const completeInfo = (info: ExistingServerSourceInfo): ExistingServerSourceInfo => {
      const detectedJvmConfig = detectJvmConfigFile(sourceDir, info.coreType);
      const complete = detectedJvmConfig ? { ...info, detectedJvmConfig } : info;
      sourcePrecheckCache.set(sourceId, { mtimeMs: stat.mtimeMs, jvmFingerprint, info: complete });
      return complete;
    };

    if (fs.existsSync(resolveSafePath(sourceDir, OWNERSHIP_MARKER_FILE))) {
      throw new PanelError('server.imports.existing.managedMarker');
    }

    const jarFile = detectJarFile(sourceDir);
    if (jarFile) {
      const described = describeJarLaunchTarget(jarFile);
      const info: ExistingServerSourceInfo = {
        id: sourceId,
        launchTarget: jarFile,
        coreType: described.coreType,
        ...(described.mcVersion ? { mcVersion: described.mcVersion } : {}),
        modifiedAt: stat.mtime.toISOString(),
        ready: true,
      };
      return completeInfo(info);
    }

    try {
      const launchTarget = await detectServerLaunchTarget(sourceDir, modLoaderPrecheckBudget());
      if (launchTarget) {
        const info: ExistingServerSourceInfo = {
          id: sourceId,
          launchTarget: launchTarget.value,
          coreType: launchTarget.coreType,
          ...(launchTarget.mcVersion ? { mcVersion: launchTarget.mcVersion } : {}),
          modifiedAt: stat.mtime.toISOString(),
          ready: true,
        };
        return completeInfo(info);
      }
    } catch (error) {
      if (isModLoaderScanLimitError(error)) {
        const info: ExistingServerSourceInfo = {
          id: sourceId,
          launchTarget: null,
          coreType: 'custom',
          modifiedAt: stat.mtime.toISOString(),
          ready: true,
          ...sourceError({ key: 'server.imports.existing.precheckIncomplete' }),
        };
        return completeInfo(info);
      }
      throw error;
    }

    const info: ExistingServerSourceInfo = {
      id: sourceId,
      launchTarget: null,
      coreType: 'custom',
      modifiedAt: stat.mtime.toISOString(),
      ready: false,
      ...sourceError({ key: 'server.imports.existing.noLaunchTarget' }),
    };
    return completeInfo(info);
  } catch (error) {
    const errorI18n = toPanelMessage(error);
    return {
      id: sourceId,
      launchTarget: null,
      coreType: 'custom',
      modifiedAt: new Date(0).toISOString(),
      ready: false,
      error: errorMessage(error),
      ...(errorI18n ? { errorI18n } : {}),
    };
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
      if (!relativeDirectory && entry.name === OWNERSHIP_MARKER_FILE) {
        throw new PanelError('server.imports.existing.markerRefused');
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
      if (!relativeDirectory && entry.name === OWNERSHIP_MARKER_FILE) {
        throw new PanelError('server.imports.existing.markerRefused');
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
        // 使用固定权限而不是沿用源目录 mode，避免把源端特殊权限带入面板托管目录。
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
      // 先打开源文件 fd 再 fstat 校验，消除 lstat 与读流之间文件被替换的 TOCTOU 窗口。
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

export async function importExistingServerDirectory(input: ImportExistingServerInput) {
  // 在占用任务队列前先拒绝路径型或不存在的 sourceId；任务执行时仍会再次校验。
  resolveExistingServerSource(input.sourceId);
  input = {
    ...input,
    jvmArgs: normalizeAndAssertJvmArgs(input.jvmArgs ?? '-Xms1G -Xmx2G', {
      coreType: input.coreType,
      javaRuntimeId: input.javaRuntimeId,
    }),
  };

  return runBackgroundTask('import', { key: 'server.imports.existing.task.queued' }, async (taskId, signal, report) => {
    let instanceId: string | null = null;
    let stagingToken: string | null = null;
    let completed = false;
    try {
      throwIfAborted(signal);
      const sourceRoot = resolveExistingServerSource(input.sourceId);
      report(5, { key: 'server.imports.existing.progress.validating' });
      const scan = await scanSourceDirectory(sourceRoot, signal);
      const sourceLaunchTarget = await detectServerLaunchTarget(
        sourceRoot,
        modLoaderFullScanBudget(signal),
      );
      if (!sourceLaunchTarget) {
        throw new PanelError('server.imports.existing.missingLaunchTarget');
      }

      throwIfAborted(signal);
      instanceId = nanoid(12);
      stagingToken = nanoid(32);
      recordTaskStaging(taskId, instanceId, stagingToken);
      const stagingRoot = prepareTaskStaging(taskId, instanceId, stagingToken);
      assertEnoughDiskSpace(stagingRoot, scan.bytes);

      report(20, { key: 'server.imports.existing.progress.copyStart' });
      await copySourceDirectory(sourceRoot, stagingRoot, scan, signal, report);

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
      promoteTaskStagingToInstance(taskId, instanceId);
      registerPromotedInstance(instanceId, {
        name: input.name.trim(),
        coreType: resolveImportedCoreType(input.coreType, copiedLaunchTarget.coreType),
        mcVersion: input.mcVersion?.trim() || copiedLaunchTarget.mcVersion || undefined,
        jarFile: copiedLaunchTarget.value,
        jvmArgs: input.jvmArgs,
        acceptEula: input.acceptEula,
        javaRuntimeId: input.javaRuntimeId ?? null,
      });
      completed = true;
      if (input.acceptEula) {
        const instanceRoot = path.join(config.instancesDir, instanceId);
        fs.writeFileSync(resolveSafePath(instanceRoot, 'eula.txt'), 'eula=true\n', 'utf8');
      }

      report(100, { key: 'server.imports.existing.progress.done' });
      return { instanceId };
    } finally {
      if (!completed && instanceId) {
        try {
          removeTaskStagingTree(taskId, instanceId);
        } catch {
          /* 清理失败不覆盖原始错误 */
        }
      }
    }
  });
}
