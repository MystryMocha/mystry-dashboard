import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { writeFileAtomic } from '../utils/atomic-write.js';

export const STAGING_ROOT_DIR = '.mystry-staging';
export const STAGING_MARKER_FILE = '.mystry-staging-marker.json';

export type TaskStagingMarker = {
  version: 1;
  taskId: string;
  instanceId: string;
  token: string;
};

export function taskStagingDir(taskId: string, instanceId: string, dataDir = config.dataDir): string {
  return path.join(dataDir, STAGING_ROOT_DIR, taskId, instanceId);
}

export function writeTaskStagingMarker(dir: string, marker: TaskStagingMarker): void {
  writeFileAtomic(path.join(dir, STAGING_MARKER_FILE), `${JSON.stringify(marker)}\n`);
}

export function readTaskStagingMarker(dir: string): TaskStagingMarker | null {
  const markerPath = path.join(dir, STAGING_MARKER_FILE);
  if (!fs.existsSync(markerPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as TaskStagingMarker;
    if (
      parsed.version !== 1
      || typeof parsed.taskId !== 'string'
      || typeof parsed.instanceId !== 'string'
      || typeof parsed.token !== 'string'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function prepareTaskStaging(
  taskId: string,
  instanceId: string,
  token: string,
  dataDir = config.dataDir,
): string {
  const dir = taskStagingDir(taskId, instanceId, dataDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeTaskStagingMarker(dir, { version: 1, taskId, instanceId, token });
  return dir;
}

export function stagingMarkerMatches(dir: string, marker: TaskStagingMarker): boolean {
  const onDisk = readTaskStagingMarker(dir);
  return (
    onDisk !== null
    && onDisk.taskId === marker.taskId
    && onDisk.instanceId === marker.instanceId
    && onDisk.token === marker.token
  );
}

export function removeEmptyStagingParents(dir: string, dataDir = config.dataDir): void {
  const stagingRoot = path.join(dataDir, STAGING_ROOT_DIR);
  let current = path.dirname(dir);
  while (current.startsWith(stagingRoot) && current !== stagingRoot) {
    try {
      if (fs.readdirSync(current).length === 0) {
        fs.rmdirSync(current);
        current = path.dirname(current);
        continue;
      }
    } catch {
      /* Ignore */
    }
    break;
  }
}

/**
 * Cleanup after a task fails while the panel is serving requests. A half-finished server can hold tens of thousands of files,
 * so the removal is awaited rather than done with rmSync, which would hold every request and all console output until it finished.
 */
export async function removeTaskStagingTree(
  taskId: string,
  instanceId: string,
  dataDir = config.dataDir,
): Promise<boolean> {
  const dir = taskStagingDir(taskId, instanceId, dataDir);
  if (!fs.existsSync(dir)) return false;
  await fs.promises.rm(dir, { recursive: true, force: true });
  removeEmptyStagingParents(dir, dataDir);
  return true;
}

/** Startup recovery only: the panel is not listening yet, so there is nothing to hold up, and recovery runs as one synchronous pass. */
export function removeTaskStagingTreeSync(
  taskId: string,
  instanceId: string,
  dataDir = config.dataDir,
): boolean {
  const dir = taskStagingDir(taskId, instanceId, dataDir);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  removeEmptyStagingParents(dir, dataDir);
  return true;
}
