import type { Dirent, Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { StatsDiskBreakdown } from '@mystry/shared';
import { hasErrorCode } from '../utils/errors.js';

export const DISK_SCAN_DEFAULTS = {
  intervalMs: 60 * 60_000,
  yieldEvery: 200,
} as const;

export type DeviceIdReader = (targetPath: string) => Promise<number | bigint>;

const defaultDeviceIdReader: DeviceIdReader = async (targetPath) => (await fs.stat(targetPath)).dev;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Walks up from `targetPath` until an existing ancestor is found and returns its device/volume ID.
 * Allows comparing whether an uncreated `BACKUP_DIR` will live on the same volume as `DATA_DIR`.
 */
export async function resolveNearestVolumeId(
  targetPath: string,
  readDeviceId: DeviceIdReader = defaultDeviceIdReader,
): Promise<number | bigint | null> {
  let probe = path.resolve(targetPath);
  while (true) {
    try {
      return await readDeviceId(probe);
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT') && !hasErrorCode(error, 'ENOTDIR')) {
        return null;
      }
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
  }
}

/** Returns true when two paths (or their nearest existing ancestors) reside on the same filesystem/volume. */
export async function arePathsOnSameVolume(
  pathA: string,
  pathB: string,
  readDeviceId: DeviceIdReader = defaultDeviceIdReader,
): Promise<boolean> {
  const [devA, devB] = await Promise.all([
    resolveNearestVolumeId(pathA, readDeviceId),
    resolveNearestVolumeId(pathB, readDeviceId),
  ]);
  return devA !== null && devB !== null && devA === devB;
}

export type MeasureDirectoryOptions = {
  signal?: AbortSignal;
  yieldEvery?: number;
};

/**
 * Sums regular file sizes under `rootPath` without following symlinks or Windows directory junctions.
 * Missing roots return 0; an aborted scan, non-directory root, or symlink root returns null.
 * Individual vanishing or unreadable entries are skipped without aborting the walk, and the loop
 * yields periodically so huge Minecraft worlds never block incoming requests.
 */
export async function measureDirectoryBytes(
  rootPath: string,
  options: MeasureDirectoryOptions = {},
): Promise<number | null> {
  const { signal, yieldEvery = DISK_SCAN_DEFAULTS.yieldEvery } = options;
  if (signal?.aborted) return null;

  let rootStat: Stats;
  try {
    rootStat = await fs.lstat(rootPath);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return 0;
    return null;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null;

  const stack: string[] = [rootPath];
  let totalBytes = 0;
  let processedEntries = 0;

  while (stack.length > 0) {
    if (signal?.aborted) return null;
    const current = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (
        hasErrorCode(error, 'ENOENT')
        || hasErrorCode(error, 'EACCES')
        || hasErrorCode(error, 'EPERM')
        || hasErrorCode(error, 'ENOTDIR')
      ) {
        continue;
      }
      return null;
    }

    for (const entry of entries) {
      if (signal?.aborted) return null;
      processedEntries += 1;
      if (processedEntries % yieldEvery === 0) {
        await yieldToEventLoop();
        if (signal?.aborted) return null;
      }

      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(current, entry.name);
      let stat: Stats;
      try {
        stat = await fs.lstat(entryPath);
      } catch (error) {
        if (
          hasErrorCode(error, 'ENOENT')
          || hasErrorCode(error, 'EACCES')
          || hasErrorCode(error, 'EPERM')
          || hasErrorCode(error, 'ENOTDIR')
        ) {
          continue;
        }
        return null;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        stack.push(entryPath);
      } else if (stat.isFile()) {
        totalBytes += stat.size;
      }
    }
  }

  return signal?.aborted ? null : totalBytes;
}

export type DiskUsageScannerOptions = {
  dataDir: () => string;
  instancesDir: () => string;
  backupDir: () => string;
  intervalMs?: number;
  yieldEvery?: number;
  readDeviceId?: DeviceIdReader;
};

export type DiskUsageScanner = {
  start(): void;
  stop(): void;
  reset(): void;
  refresh(): Promise<StatsDiskBreakdown>;
  getSnapshot(): StatsDiskBreakdown;
};

function initialBreakdown(): StatsDiskBreakdown {
  return {
    instancesBytes: null,
    backupsBytes: null,
    backupsOnSameVolume: false,
  };
}

/**
 * Periodically scans `instances` and `backups` directory sizes in the background and caches the result.
 * Until the first scan completes, byte counts remain null (distinct from 0) so the UI omits the breakdown.
 */
export function createDiskUsageScanner(options: DiskUsageScannerOptions): DiskUsageScanner {
  const intervalMs = options.intervalMs ?? DISK_SCAN_DEFAULTS.intervalMs;
  const yieldEvery = options.yieldEvery ?? DISK_SCAN_DEFAULTS.yieldEvery;
  const readDeviceId = options.readDeviceId ?? defaultDeviceIdReader;

  let cached: StatsDiskBreakdown = initialBreakdown();
  let timer: NodeJS.Timeout | null = null;
  let activeController: AbortController | null = null;
  let pending: Promise<StatsDiskBreakdown> | null = null;
  let stopped = false;
  let generation = 0;

  async function runScan(runGeneration: number, signal: AbortSignal): Promise<StatsDiskBreakdown> {
    const dataDir = options.dataDir();
    const instancesDir = options.instancesDir();
    const backupDir = options.backupDir();

    const backupsOnSameVolume = await arePathsOnSameVolume(dataDir, backupDir, readDeviceId);
    if (stopped || signal.aborted || generation !== runGeneration) return { ...cached };

    const instancesBytes = await measureDirectoryBytes(instancesDir, { signal, yieldEvery });
    if (stopped || signal.aborted || generation !== runGeneration) return { ...cached };

    const backupsBytes = backupsOnSameVolume
      ? await measureDirectoryBytes(backupDir, { signal, yieldEvery })
      : null;
    if (stopped || signal.aborted || generation !== runGeneration) return { ...cached };

    cached = {
      instancesBytes,
      backupsBytes,
      backupsOnSameVolume,
    };
    return { ...cached };
  }

  function refresh(): Promise<StatsDiskBreakdown> {
    if (stopped) return Promise.resolve({ ...cached });
    if (pending) return pending;
    const runGeneration = generation;
    const controller = new AbortController();
    activeController = controller;
    const promise = runScan(runGeneration, controller.signal)
      .catch(() => ({ ...cached }))
      .finally(() => {
        if (activeController === controller) activeController = null;
        if (pending === promise) pending = null;
      });
    pending = promise;
    return promise;
  }

  function stop(): void {
    stopped = true;
    generation += 1;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (activeController) {
      activeController.abort();
      activeController = null;
    }
    pending = null;
  }

  return {
    start() {
      stopped = false;
      if (timer) return;
      void refresh();
      timer = setInterval(() => void refresh(), intervalMs);
      timer.unref();
    },
    stop,
    reset() {
      stop();
      cached = initialBreakdown();
      stopped = false;
    },
    refresh,
    getSnapshot() {
      return { ...cached };
    },
  };
}
