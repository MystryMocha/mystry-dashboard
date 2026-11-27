import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type {
  CreateInstanceInput,
  InstanceInfo,
  InstanceStatus,
  UpdateInstanceInput,
} from '@mystry/shared';
import { LOCAL_NODE_ID } from '@mystry/shared';
import { config } from '../config.js';
import { getDb, type InstanceRow } from '../db.js';
import {
  OWNERSHIP_MARKER_FILE,
  defaultInstanceDir,
  assertSafeDirectoryPath,
  assertSafeInstanceRoot,
  hasValidOwnershipMarker,
  inspectOwnershipMarker,
  removeOwnershipMarker,
  resolveDirFromRow,
  resolveSafePath,
  writeOwnershipMarker,
  nowIso,
} from '../utils/path.js';
import { processManager } from './process-manager.js';
import { nodeExists } from './node-service.js';
import { getJavaRuntime } from './java-runtime-service.js';
import { normalizeAndAssertJvmArgs } from './jvm-validation-service.js';
import {
  STAGING_MARKER_FILE,
  removeEmptyStagingParents,
  taskStagingDir,
} from './task-staging-service.js';
import { errorParam, PanelError } from '../utils/errors.js';

const DEFAULT_JVM_ARGS = '-Xms1G -Xmx2G';

/** Validates a runtime reference: only verified runtimes in the registry may be referenced; null means the java on PATH. */
function assertValidJavaRuntime(javaRuntimeId: string | null | undefined): void {
  if (javaRuntimeId === null || javaRuntimeId === undefined) return;
  const runtime = getJavaRuntime(javaRuntimeId);
  if (!runtime || !runtime.available) {
    throw new PanelError('server.instance.javaRuntimeInvalid');
  }
}

/**
 * Problems that can be told before starting: the bound Java is marked unavailable, or is no longer in the registry.
 * Only the registry is checked and the disk is not touched; cases such as the file being deleted or replaced are still caught by the re-verification before start.
 */
function boundJavaUnavailable(row: InstanceRow): boolean {
  if (row.java_runtime_id === null || row.java_runtime_id === undefined) return false;
  const runtime = getJavaRuntime(row.java_runtime_id);
  return !runtime || !runtime.available;
}

function rowToInfo(row: InstanceRow): InstanceInfo {
  const requiresMigration = row.install_path !== null;
  return {
    id: row.id,
    name: row.name,
    coreType: row.core_type as InstanceInfo['coreType'],
    mcVersion: row.mc_version,
    jarFile: row.jar_file,
    javaPath: 'java',
    jvmArgs: row.jvm_args,
    installPath: row.install_path ?? defaultInstanceDir(row.id),
    requiresMigration,
    status: processManager.getStatus(row.id) as InstanceStatus,
    nodeId: row.node_id,
    javaRuntimeId: row.java_runtime_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acceptEula: Boolean(row.accept_eula),
    // When the chosen Java is unusable every start will fail, so this ranks ahead of the reason left by the previous start.
    startIssue: boundJavaUnavailable(row)
      ? { kind: 'java-unavailable', requiredJava: null }
      : processManager.getStartIssue(row.id),
    ready: processManager.isReady(row.id),
    orphanProcess: processManager.getOrphanProcess(row.id),
  };
}

function cleanupCreatedDirectory(
  id: string,
  dir: string,
  marker: string,
  markerWritten: boolean,
  directoryCreatedByCall: boolean,
): void {
  if (markerWritten) {
    removeOwnershipMarker(id, dir, marker);
  }
  if (!directoryCreatedByCall || !fs.existsSync(dir)) return;
  try {
    assertSafeInstanceRoot(dir);
    if (fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
    }
  } catch {
    // A cleanup failure must not override the original database/filesystem error, nor risk deleting a non-empty directory.
  }
}

export function listInstances(): InstanceInfo[] {
  const rows = getDb()
    .prepare('SELECT * FROM instances ORDER BY created_at DESC')
    .all() as InstanceRow[];
  return rows.map(rowToInfo);
}

export function getInstance(id: string): InstanceInfo | null {
  const row = getDb().prepare('SELECT * FROM instances WHERE id = ?').get(id) as
    | InstanceRow
    | undefined;
  return row ? rowToInfo(row) : null;
}

export function getInstanceRow(id: string): InstanceRow | null {
  const row = getDb().prepare('SELECT * FROM instances WHERE id = ?').get(id) as
    | InstanceRow
    | undefined;
  return row ?? null;
}

type PreparedInstanceInput = { nodeId: string; jvmArgs: string };

/** Input validation shared by creating and registering instances: node, Java runtime and JVM arguments. */
function prepareInstanceInput(input: CreateInstanceInput): PreparedInstanceInput {
  const nodeId = input.nodeId?.trim() || LOCAL_NODE_ID;
  if (!nodeExists(nodeId)) {
    throw new PanelError('server.instance.selectedNodeNotFound');
  }
  if (nodeId !== LOCAL_NODE_ID) {
    throw new PanelError('server.instance.remoteNodeUnsupported');
  }
  assertValidJavaRuntime(input.javaRuntimeId);
  const jvmArgs = normalizeAndAssertJvmArgs(input.jvmArgs ?? DEFAULT_JVM_ARGS, {
    coreType: input.coreType ?? 'custom',
    javaRuntimeId: input.javaRuntimeId,
  });
  return { nodeId, jvmArgs };
}

function insertInstanceRow(
  id: string,
  input: CreateInstanceInput,
  prepared: PreparedInstanceInput,
  ownershipMarker: string,
): void {
  const now = nowIso();
  const result = getDb()
    .prepare(
      `INSERT INTO instances
      (id, name, core_type, mc_version, jar_file, java_path, jvm_args, accept_eula, install_path, ownership_marker, node_id, java_runtime_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.name,
      input.coreType ?? 'custom',
      input.mcVersion ?? null,
      input.jarFile ?? 'server.jar',
      'java',
      prepared.jvmArgs,
      input.acceptEula ? 1 : 0,
      null,
      ownershipMarker,
      prepared.nodeId,
      input.javaRuntimeId ?? null,
      now,
      now,
    );
  if (Number(result.changes) !== 1) {
    throw new PanelError('server.instance.createDbFailed');
  }
}

export function createInstance(input: CreateInstanceInput): InstanceInfo {
  const id = nanoid(12);
  const prepared = prepareInstanceInput(input);
  const dir = defaultInstanceDir(id);
  const ownershipMarker = nanoid(32);
  let markerWritten = false;
  let directoryCreatedByCall = false;

  try {
    const existedBefore = fs.existsSync(dir);
    assertSafeDirectoryPath(dir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    directoryCreatedByCall = !existedBefore;
    assertSafeInstanceRoot(dir);
    if (fs.readdirSync(dir).length > 0) {
      throw new PanelError('server.instance.defaultDirNotEmpty');
    }
    writeOwnershipMarker(id, dir, ownershipMarker);
    markerWritten = true;
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (err) {
    cleanupCreatedDirectory(id, dir, ownershipMarker, markerWritten, directoryCreatedByCall);
    throw new PanelError('server.instance.createDirFailed', { dir, reason: errorParam(err) });
  }

  try {
    insertInstanceRow(id, input, prepared, ownershipMarker);
  } catch (err) {
    cleanupCreatedDirectory(id, dir, ownershipMarker, markerWritten, directoryCreatedByCall);
    throw err;
  }

  return getInstance(id)!;
}

/**
 * Validates input, prepares ownership/EULA files in staging, promotes the staging directory into instances/<id>,
 * and inserts the database row as one synchronous commit step. If the database write fails after rename, the directory
 * is moved back into staging (with the staging marker still intact) so the task's cleanup removes it instead of leaving
 * an orphaned directory under instances/.
 */
export function commitStagedInstance(
  taskId: string,
  instanceId: string,
  input: CreateInstanceInput,
  options: { dataDir?: string; writeEulaIfAccepted?: boolean } = {},
): InstanceInfo {
  const dataDir = options.dataDir ?? config.dataDir;
  const prepared = prepareInstanceInput(input);
  const staging = taskStagingDir(taskId, instanceId, dataDir);
  if (!fs.existsSync(staging)) {
    throw new PanelError('server.imports.staging.lost');
  }
  assertSafeInstanceRoot(staging);

  const entries = fs.readdirSync(staging);
  const hasContent = entries.some((name) => name !== STAGING_MARKER_FILE);
  if (!hasContent) {
    throw new PanelError('server.instance.registerDirEmpty');
  }
  if (entries.some((name) => name.toLowerCase() === OWNERSHIP_MARKER_FILE.toLowerCase())) {
    throw new PanelError('server.imports.existing.markerRefused');
  }

  const instanceDir = defaultInstanceDir(instanceId);
  if (fs.existsSync(instanceDir)) {
    throw new PanelError('server.imports.staging.instanceDirExists');
  }

  fs.accessSync(staging, fs.constants.W_OK);
  if (options.writeEulaIfAccepted && input.acceptEula) {
    fs.writeFileSync(resolveSafePath(staging, 'eula.txt'), 'eula=true\n', 'utf8');
  }

  const ownershipMarker = nanoid(32);
  writeOwnershipMarker(instanceId, staging, ownershipMarker);

  // Once promoted into instances/<id>, database registration follows synchronously without awaiting or checking cancellation.
  // Keep STAGING_MARKER_FILE until the insert succeeds so a rollback back to staging remains identifiable by startup recovery.
  fs.renameSync(staging, instanceDir);
  try {
    insertInstanceRow(instanceId, input, prepared, ownershipMarker);
  } catch (err) {
    try {
      fs.mkdirSync(path.dirname(staging), { recursive: true, mode: 0o700 });
      fs.renameSync(instanceDir, staging);
      removeOwnershipMarker(instanceId, staging, ownershipMarker);
    } catch (rollbackErr) {
      console.error(`实例 ${instanceId} 入库失败后回滚暂存目录失败`, rollbackErr);
      removeOwnershipMarker(instanceId, instanceDir, ownershipMarker);
    }
    throw err;
  }

  const stagingMarkerPath = path.join(instanceDir, STAGING_MARKER_FILE);
  if (fs.existsSync(stagingMarkerPath)) {
    try {
      fs.unlinkSync(stagingMarkerPath);
    } catch {
      /* The instance is already registered; failing to unlink the staging marker must not turn a committed instance into an error. */
    }
  }
  removeEmptyStagingParents(staging, dataDir);
  return getInstance(instanceId)!;
}

export function updateInstance(id: string, input: UpdateInstanceInput): InstanceInfo {
  const existing = getInstanceRow(id);
  if (!existing) throw new PanelError('server.instance.notFound');
  assertValidJavaRuntime(input.javaRuntimeId);
  const normalizedJvmArgs = normalizeAndAssertJvmArgs(input.jvmArgs ?? existing.jvm_args, {
    coreType: existing.core_type as InstanceInfo['coreType'],
    javaRuntimeId: input.javaRuntimeId === undefined
      ? existing.java_runtime_id
      : input.javaRuntimeId,
  });
  // When no JVM arguments are submitted, only validate; the raw text in a legacy instance is not silently rewritten.
  const jvmArgs = input.jvmArgs === undefined ? existing.jvm_args : normalizedJvmArgs;

  // On start, eula=true is written only when accepted. When acceptance is withdrawn the file has to be changed back, or the acceptance written earlier would stay in effect.
  // Only this change is considered: an instance where it was never checked (for example one imported with its own acceptance record) keeps its existing eula.txt untouched.
  // A legacy instance bound to an external directory cannot start before migration and its instance directory cannot be resolved, so only the database is changed, and it can be saved as before.
  if (existing.accept_eula && input.acceptEula === false && existing.install_path === null) {
    // Restoring a backup replaces the whole directory, so files written now would be lost and the database and files would disagree.
    processManager.assertNotInMaintenance(id);
    const dir = assertSafeInstanceRoot(resolveDirFromRow(existing));
    fs.writeFileSync(resolveSafePath(dir, 'eula.txt'), 'eula=false\n', 'utf8');
  }

  const now = nowIso();
  getDb()
    .prepare(
      `UPDATE instances SET
        name = ?,
        jar_file = ?,
        java_path = ?,
        jvm_args = ?,
        accept_eula = ?,
        java_runtime_id = ?,
        updated_at = ?
      WHERE id = ?`,
    )
    .run(
      input.name ?? existing.name,
      input.jarFile ?? existing.jar_file,
      'java',
      jvmArgs,
      input.acceptEula !== undefined ? (input.acceptEula ? 1 : 0) : existing.accept_eula,
      input.javaRuntimeId === undefined ? existing.java_runtime_id : input.javaRuntimeId,
      now,
      id,
    );

  return getInstance(id)!;
}

/**
 * Save entry point for instance settings (PATCH). Withdrawing EULA acceptance changes eula.txt in the instance directory,
 * and in that case the same instance lock as start and the restore directory swap is used, so it does not interleave with them.
 * Other saves take no lock: stopping an instance holds the lock the whole time it waits for the process to exit, and a rename must not have to wait along with it.
 */
export async function updateInstanceSettings(id: string, input: UpdateInstanceInput): Promise<InstanceInfo> {
  if (input.acceptEula === false && getInstanceRow(id)?.accept_eula) {
    return processManager.runExclusive(id, async () => updateInstance(id, input));
  }
  return updateInstance(id, input);
}

/** Syncs the launch file, core type and version recorded by the panel after a backup restore; the caller is responsible for holding the instance lock. */
export function updateInstanceServerFiles(
  id: string,
  input: { jarFile: string; coreType: string; mcVersion: string | null },
): void {
  getDb()
    .prepare('UPDATE instances SET jar_file = ?, core_type = ?, mc_version = ?, updated_at = ? WHERE id = ?')
    .run(input.jarFile, input.coreType, input.mcVersion, nowIso(), id);
}

export async function deleteInstance(id: string): Promise<void> {
  return processManager.runExclusive(id, async () => {
    if (processManager.isRunning(id)) {
      throw new PanelError('server.instance.deleteRunning');
    }
    await processManager.assertNoOrphanProcess(id);
    processManager.assertNotInMaintenance(id);
    const row = getInstanceRow(id);
    if (!row) return;
    if (row.install_path !== null) {
      getDb().prepare('DELETE FROM instances WHERE id = ?').run(id);
      processManager.forget(id);
      return;
    }
    const dir = defaultInstanceDir(row.id);
    const canRemoveDirectory = hasValidOwnershipMarker(row);
    // Keep the order of deleting the directory before the DB row: the security self-test asserts "the database record must be kept when deleting the directory fails".
    if (canRemoveDirectory && fs.existsSync(dir)) {
      assertSafeInstanceRoot(dir);
      // Awaited rather than rmSync: a whole server directory can take seconds to remove, and rmSync would hold every request
      // and all console output for that long. The instance lock stays held until the removal has finished.
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
    const result = getDb().prepare('DELETE FROM instances WHERE id = ?').run(id);
    if (Number(result.changes) !== 1) {
      throw new PanelError('server.instance.deleteDbFailed');
    }
    processManager.forget(id);
  });
}

/** Takes over the default directory for the same instance ID, without reading or operating on the old external directory. */
export async function adoptManagedDirectory(id: string): Promise<InstanceInfo> {
  return processManager.runExclusive(id, () => adoptManagedDirectoryWithinLock(id));
}

async function adoptManagedDirectoryWithinLock(id: string): Promise<InstanceInfo> {
  if (processManager.isRunning(id)) {
    throw new PanelError('server.instance.adoptRunning');
  }
  await processManager.assertNoOrphanProcess(id);
  processManager.assertNotInMaintenance(id);

  const row = getInstanceRow(id);
  if (!row) throw new PanelError('server.instance.notFound');
  if (row.install_path === null) {
    throw new PanelError('server.instance.adoptAlreadyManaged');
  }

  const dir = defaultInstanceDir(id);
  try {
    assertSafeInstanceRoot(dir);
    if (fs.readdirSync(dir).length === 0) {
      throw new PanelError('server.instance.adoptDirEmpty');
    }
  } catch (err) {
    throw new PanelError('server.instance.adoptDirFailed', { reason: errorParam(err) });
  }

  let ownershipMarker: string;
  let markerWrittenByCall = false;
  try {
    const marker = inspectOwnershipMarker(id, dir);
    if (marker.exists) {
      if (marker.marker === null) {
        throw new PanelError('server.instance.adoptMarkerInvalid');
      }
      ownershipMarker = marker.marker;
    } else {
      ownershipMarker = nanoid(32);
      writeOwnershipMarker(id, dir, ownershipMarker);
      markerWrittenByCall = true;
    }

    const result = getDb()
      .prepare(
        `UPDATE instances SET
          java_path = ?,
          install_path = NULL,
          ownership_marker = ?,
          updated_at = ?
        WHERE id = ? AND install_path IS NOT NULL`,
      )
      .run('java', ownershipMarker, nowIso(), id);
    if (Number(result.changes) !== 1) {
      throw new PanelError('server.instance.adoptStateChanged');
    }
  } catch (err) {
    if (markerWrittenByCall) {
      removeOwnershipMarker(id, dir, ownershipMarker!);
    }
    throw err;
  }

  return getInstance(id)!;
}
