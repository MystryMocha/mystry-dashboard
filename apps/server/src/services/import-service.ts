import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type { CoreType } from '@mystry/shared';
import { config } from '../config.js';
import { registerPromotedInstance } from './instance-service.js';
import { detectServerLaunchTarget, resolveImportedCoreType } from './server-launch-detect.js';
import {
  assertSafeInstanceRoot,
  resolveSafePath,
} from '../utils/path.js';
import { recordTaskStaging, runBackgroundTask } from './task-service.js';
import {
  prepareTaskStaging,
  promoteTaskStagingToInstance,
  removeTaskStagingTree,
  stagingMarkerMatches,
  STAGING_MARKER_FILE,
  type TaskStagingMarker,
} from './task-staging-service.js';
import { assertUploadPath, removeUploadTemp } from './upload-service.js';
import { normalizeAndAssertJvmArgs } from './jvm-validation-service.js';
import { safeExtract } from './zip-service.js';
import { PanelError, throwIfAborted } from '../utils/errors.js';

/** If there is only a single directory level after extraction, moves its content up into the instance root. */
function flattenSingleRoot(
  dir: string,
  signal: AbortSignal,
  stagingMarker: TaskStagingMarker,
): void {
  throwIfAborted(signal);
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const hasExpectedStagingMarker = stagingMarkerMatches(dir, stagingMarker);
  const contentEntries = entries.filter(
    (entry) => entry.name !== STAGING_MARKER_FILE || !hasExpectedStagingMarker,
  );
  if (contentEntries.length !== 1 || !contentEntries[0]!.isDirectory()) return;
  const nested = path.join(dir, contentEntries[0]!.name);
  const nestedEntries = fs.readdirSync(nested);
  for (const name of nestedEntries) {
    throwIfAborted(signal);
    const source = path.join(nested, name);
    const target = path.join(dir, name);
    if (fs.existsSync(target)) throw new PanelError('server.imports.zip.duplicateRootPath', { name });
    fs.renameSync(source, target);
  }
  fs.rmSync(nested, { recursive: true, force: true });
}

export async function importZipPackage(options: {
  name: string;
  zipPath: string;
  coreType?: CoreType;
  mcVersion?: string;
  jvmArgs?: string;
  acceptEula?: boolean;
  javaRuntimeId?: string | null;
  preserveUploadOnEnqueueFailure?: boolean;
}) {
  const zipPath = assertUploadPath(options.zipPath);
  options = {
    ...options,
    jvmArgs: normalizeAndAssertJvmArgs(options.jvmArgs ?? '-Xms1G -Xmx2G', {
      coreType: options.coreType,
      javaRuntimeId: options.javaRuntimeId,
    }),
  };
  try {
    return await runBackgroundTask('import', { key: 'server.imports.zip.task.queued' }, async (taskId, signal, report) => {
      let instanceId: string | null = null;
      let stagingToken: string | null = null;
      let completed = false;
      try {
        throwIfAborted(signal);
        instanceId = nanoid(12);
        stagingToken = nanoid(32);
        const stagingMarker: TaskStagingMarker = {
          version: 1,
          taskId,
          instanceId,
          token: stagingToken,
        };
        recordTaskStaging(taskId, instanceId, stagingToken);
        const staging = prepareTaskStaging(taskId, instanceId, stagingToken);
        throwIfAborted(signal);
        report(20, { key: 'server.imports.zip.progress.extracting' });
        await safeExtract(zipPath, staging, signal);
        flattenSingleRoot(staging, signal, stagingMarker);

        throwIfAborted(signal);
        report(70, { key: 'server.imports.zip.progress.validating' });
        const launchTarget = await detectServerLaunchTarget(staging, {
          maxDepth: config.modLoaderScanMaxDepth,
          maxEntries: config.modLoaderScanMaxEntries,
          deadlineMs: config.modLoaderScanTimeoutMs,
          signal,
        });
        if (!launchTarget) {
          throw new PanelError('server.imports.zip.noLaunchTarget');
        }

        throwIfAborted(signal);
        report(85, { key: 'server.imports.progress.writingInstance' });
        promoteTaskStagingToInstance(taskId, instanceId);
        // After promote the directory is already in instances/<id>; it must no longer be aborted by timeout/shutdown, and registration must continue.
        const dir = path.join(config.instancesDir, instanceId);
        assertSafeInstanceRoot(dir);

        report(90, { key: 'server.imports.progress.registering' });
        registerPromotedInstance(instanceId, {
          name: options.name,
          coreType: resolveImportedCoreType(options.coreType, launchTarget.coreType),
          mcVersion: options.mcVersion?.trim() || launchTarget.mcVersion || undefined,
          jarFile: launchTarget.value,
          jvmArgs: options.jvmArgs,
          acceptEula: options.acceptEula,
          javaRuntimeId: options.javaRuntimeId ?? null,
        });
        completed = true;

        if (options.acceptEula) {
          fs.writeFileSync(resolveSafePath(dir, 'eula.txt'), 'eula=true\n', 'utf8');
        }

        report(100, { key: 'server.imports.zip.progress.done' });
        return { instanceId };
      } finally {
        if (!completed && instanceId && stagingToken) {
          try {
            removeTaskStagingTree(taskId, instanceId);
          } catch {
            /* A cleanup failure does not override the original error */
          }
        }
        if (fs.existsSync(zipPath)) {
          try {
            removeUploadTemp(zipPath);
          } catch {
            /* A cleanup failure does not override the original error */
          }
        }
      }
    });
  } catch (err) {
    // When the task does not enter the queue (queue full / panel shutting down) the task callback never runs, so the uploaded temp file is cleaned up here as a fallback.
    if (!options.preserveUploadOnEnqueueFailure && fs.existsSync(zipPath)) {
      try {
        removeUploadTemp(zipPath);
      } catch {
        /* A cleanup failure does not override the original error */
      }
    }
    throw err;
  }
}
