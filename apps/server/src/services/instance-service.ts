import fs from 'node:fs';
import { nanoid } from 'nanoid';
import type {
  CreateInstanceInput,
  InstanceInfo,
  InstanceStatus,
  UpdateInstanceInput,
} from '@mystry/shared';
import { LOCAL_NODE_ID } from '@mystry/shared';
import { getDb, type InstanceRow } from '../db.js';
import {
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
import { errorParam, PanelError } from '../utils/errors.js';

const DEFAULT_JVM_ARGS = '-Xms1G -Xmx2G';

/** 校验运行时引用：只能引用注册表中已验证的运行时，null 表示 PATH 中的 java。 */
function assertValidJavaRuntime(javaRuntimeId: string | null | undefined): void {
  if (javaRuntimeId === null || javaRuntimeId === undefined) return;
  const runtime = getJavaRuntime(javaRuntimeId);
  if (!runtime || !runtime.available) {
    throw new PanelError('server.instance.javaRuntimeInvalid');
  }
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
    startIssue: processManager.getStartIssue(row.id),
    ready: processManager.isReady(row.id),
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
    // 清理失败不能覆盖原始数据库/文件系统错误，也不能冒险删除非空目录。
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

/** 新建和注册实例共用的输入校验：节点、Java 运行时和 JVM 参数。 */
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

/** 将已 promote 到 instances/<id> 的目录注册进数据库（部署/导入任务完成时调用）。 */
export function registerPromotedInstance(id: string, input: CreateInstanceInput): InstanceInfo {
  const prepared = prepareInstanceInput(input);
  const dir = defaultInstanceDir(id);
  if (!fs.existsSync(dir)) {
    throw new PanelError('server.instance.registerDirMissing');
  }
  assertSafeInstanceRoot(dir);
  const entries = fs.readdirSync(dir);
  if (entries.length === 0) {
    throw new PanelError('server.instance.registerDirEmpty');
  }

  const ownershipMarker = nanoid(32);
  writeOwnershipMarker(id, dir, ownershipMarker);
  fs.accessSync(dir, fs.constants.W_OK);

  try {
    insertInstanceRow(id, input, prepared, ownershipMarker);
  } catch (err) {
    removeOwnershipMarker(id, dir, ownershipMarker);
    throw err;
  }

  return getInstance(id)!;
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
  // 未提交 JVM 参数时只做校验，不静默改写旧实例中的原始文本。
  const jvmArgs = input.jvmArgs === undefined ? existing.jvm_args : normalizedJvmArgs;

  // 启动时只在同意时写 eula=true。从同意改成不同意时要把文件改回来，否则之前写进去的同意一直有效。
  // 只看这一次变化：从没勾选过的实例（例如导入时自带同意记录）不碰原有的 eula.txt。
  // 旧版绑定外部目录的实例迁移前不能启动，也解析不到实例目录，只改数据库，和以前一样能保存。
  if (existing.accept_eula && input.acceptEula === false && existing.install_path === null) {
    // 还原备份会整体替换目录，这时写进去的文件会丢，数据库和文件对不上。
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
 * 实例设置的保存入口（PATCH）。取消同意 EULA 时会改实例目录里的 eula.txt，
 * 这时和启动、还原替换目录用同一把实例锁，不会和它们交错。
 * 其他保存不拿锁：停止实例会在等进程退出期间一直占着锁，改个名不能跟着等。
 */
export async function updateInstanceSettings(id: string, input: UpdateInstanceInput): Promise<InstanceInfo> {
  if (input.acceptEula === false && getInstanceRow(id)?.accept_eula) {
    return processManager.runExclusive(id, async () => updateInstance(id, input));
  }
  return updateInstance(id, input);
}

/** 还原备份后同步面板记录的启动文件、核心类型与版本；调用方负责持有实例锁。 */
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
    // 保持先删目录后删 DB 行的顺序：安全自检 R1 断言「目录删除失败时数据库记录必须保留」。
    if (canRemoveDirectory && fs.existsSync(dir)) {
      assertSafeInstanceRoot(dir);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const result = getDb().prepare('DELETE FROM instances WHERE id = ?').run(id);
    if (Number(result.changes) !== 1) {
      throw new PanelError('server.instance.deleteDbFailed');
    }
    processManager.forget(id);
  });
}

/** 接管同一实例 ID 对应的默认目录，不读取或操作旧的外部目录。 */
export async function adoptManagedDirectory(id: string): Promise<InstanceInfo> {
  return processManager.runExclusive(id, async () => adoptManagedDirectoryWithinLock(id));
}

function adoptManagedDirectoryWithinLock(id: string): InstanceInfo {
  if (processManager.isRunning(id)) {
    throw new PanelError('server.instance.adoptRunning');
  }
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
