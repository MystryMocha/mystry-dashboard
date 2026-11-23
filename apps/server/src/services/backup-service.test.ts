/**
 * Instance backup and restore regression: backup while stopped, backup while running (save-off/flush/save-on), restore overwrite and automatic backup,
 * mutual exclusion during maintenance, upload verification, and directory swap recovery after a crash.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import type { TaskInfo } from '@mystry/shared';

process.env.JWT_SECRET = 'a'.repeat(64);
process.env.SETUP_TOKEN = 'b'.repeat(64);
process.env.LAUNCHER_TOKEN = 'c'.repeat(64);
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-backup-service-test-'));
process.env.MYSTRY_DATA_DIR = dataRoot;
delete process.env.BACKUP_DIR;

test.after(async () => {
  try {
    const { processManager } = await import('./process-manager.js');
    await processManager.stopAll();
    const { closeDb } = await import('../db.js');
    closeDb();
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

const hasKey = (key: string) => (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { messageKey?: string }).messageKey === key;

let dbReady = false;

async function setup() {
  // Every initDb call opens a new connection and the old one is not closed; on Windows that keeps panel.db held and makes cleanup fail.
  if (!dbReady) {
    const { initDb } = await import('../db.js');
    initDb();
    dbReady = true;
  }
  const { createInstance } = await import('./instance-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');
  const info = createInstance({ name: `backup-${Math.random().toString(36).slice(2, 8)}` });
  const dir = defaultInstanceDir(info.id);
  fs.writeFileSync(path.join(dir, 'server.jar'), 'stub-jar');
  fs.mkdirSync(path.join(dir, 'world', 'region'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'level-v1');
  fs.writeFileSync(path.join(dir, 'world', 'region', 'r.0.0.mca'), Buffer.alloc(4096, 1));
  // A file locked by the JVM while running: it should not go into the backup (fileCount is still 3).
  fs.writeFileSync(path.join(dir, 'world', 'session.lock'), '☃');
  return { id: info.id, dir };
}

async function waitForTask(task: TaskInfo): Promise<TaskInfo> {
  const { getTask } = await import('./task-service.js');
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const current = getTask(task.id);
    if (current && (current.status === 'completed' || current.status === 'failed')) return current;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`任务 ${task.id} 未在预期时间内结束`);
}

test('restore after a stopped-server backup: overwrites files, deletes added files, keeps the ownership marker and backs up the current files automatically', async () => {
  const { id, dir } = await setup();
  const { listBackups, startBackupTask, startRestoreTask } = await import('./backup-service.js');
  const { OWNERSHIP_MARKER_FILE } = await import('../utils/path.js');

  const backupTask = await waitForTask(await startBackupTask(id));
  assert.equal(backupTask.status, 'completed', backupTask.error);
  const backupId = backupTask.result?.backupId;
  assert.equal(typeof backupId, 'string');
  const [backup] = listBackups(id);
  assert.equal(backup?.id, backupId);
  assert.equal(backup?.source, 'manual');
  assert.equal(backup?.fileCount, 3);
  assert.equal(backup?.wasRunning, false);

  const marker = fs.readFileSync(path.join(dir, OWNERSHIP_MARKER_FILE), 'utf8');
  fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'level-v2');
  fs.writeFileSync(path.join(dir, 'added-later.txt'), 'new');

  const restoreTask = await waitForTask(await startRestoreTask(id, backupId!, { backupCurrent: true }));
  assert.equal(restoreTask.status, 'completed', restoreTask.error);
  assert.equal(restoreTask.result?.instanceRecordUpdated, false);
  assert.equal(fs.readFileSync(path.join(dir, 'world', 'level.dat'), 'utf8'), 'level-v1');
  assert.equal(fs.existsSync(path.join(dir, 'added-later.txt')), false);
  assert.equal(fs.existsSync(path.join(dir, 'world', 'session.lock')), false);
  assert.equal(fs.readFileSync(path.join(dir, OWNERSHIP_MARKER_FILE), 'utf8'), marker);
  assert.deepEqual(fs.readdirSync(path.join(dataRoot, '.mystry-staging')).length, 0);

  const backups = listBackups(id);
  assert.equal(backups.length, 2);
  const preRestore = backups.find((item) => item.source === 'pre-restore');
  assert.ok(preRestore, '应自动生成还原前备份');

  // The pre-restore backup should contain the content from before it was overwritten.
  const undo = await waitForTask(await startRestoreTask(id, preRestore.id, { backupCurrent: false }));
  assert.equal(undo.status, 'completed', undo.error);
  assert.equal(fs.readFileSync(path.join(dir, 'world', 'level.dat'), 'utf8'), 'level-v2');
  assert.equal(fs.readFileSync(path.join(dir, 'added-later.txt'), 'utf8'), 'new');
});

test('start, instance deletion and another backup or restore are refused while a backup or restore is in progress', async () => {
  const { id } = await setup();
  const { processManager } = await import('./process-manager.js');
  const { deleteInstance, getInstanceRow } = await import('./instance-service.js');
  const { listBackups, startBackupTask, startRestoreTask } = await import('./backup-service.js');
  const done = await waitForTask(await startBackupTask(id));
  const [backup] = listBackups(id);
  assert.equal(done.status, 'completed', done.error);

  const release = processManager.beginMaintenance(id, 'server.backups.busyRestoring');
  try {
    await assert.rejects(processManager.start(getInstanceRow(id)!), hasKey('server.backups.busyRestoring'));
    await assert.rejects(deleteInstance(id), hasKey('server.backups.busyRestoring'));
    await assert.rejects(startRestoreTask(id, backup!.id), hasKey('server.backups.busyRestoring'));
    await assert.rejects(startBackupTask(id), hasKey('server.backups.busyRestoring'));
  } finally {
    release();
  }
  assert.equal(processManager.getMaintenance(id), null);
});

test('a file delete is refused for the whole of a restore, and is not blocked by a backup', async () => {
  const { id, dir } = await setup();
  const { processManager } = await import('./process-manager.js');
  const { deleteInstancePath } = await import('../routes/files.js');

  const endRestore = processManager.beginMaintenance(id, 'server.backups.busyRestoring');
  try {
    await assert.rejects(
      deleteInstancePath(id, 'world'),
      (error: unknown) => hasKey('server.backups.busyRestoring')(error) && (error as { statusCode?: number }).statusCode === 409,
    );
  } finally {
    endRestore();
  }
  assert.equal(fs.readFileSync(path.join(dir, 'world', 'level.dat'), 'utf8'), 'level-v1');

  const endBackup = processManager.beginMaintenance(id, 'server.backups.busyBackingUp');
  try {
    await deleteInstancePath(id, 'world/session.lock');
  } finally {
    endBackup();
  }
  assert.equal(fs.existsSync(path.join(dir, 'world', 'session.lock')), false);
});

test('a file delete still removing entries holds the instance lock: the restore swaps the directory only afterwards and the restored files stay intact', async (t) => {
  const { id, dir } = await setup();
  const { processManager } = await import('./process-manager.js');
  const { startBackupTask, startRestoreTask } = await import('./backup-service.js');
  const { deleteInstancePath } = await import('../routes/files.js');
  const backup = await waitForTask(await startBackupTask(id));
  assert.equal(backup.status, 'completed', backup.error);
  const world = path.join(dir, 'world');
  fs.writeFileSync(path.join(world, 'level.dat'), 'level-v2');

  // Hold the removal of world/ at its first step, before it has removed anything, standing in for a large tree that is
  // still being removed when the restore request arrives. Without the lock the swap would go through meanwhile, and the
  // removal would then carry on at the same path inside the directory that was just restored.
  const originalRmdir = fs.promises.rmdir.bind(fs.promises);
  let releaseRemoval!: () => void;
  const removalHeld = new Promise<void>((resolve) => {
    releaseRemoval = resolve;
  });
  let removalWasHeld = false;
  let markRemovalReached!: () => void;
  const removalReached = new Promise<void>((resolve) => {
    markRemovalReached = resolve;
  });
  t.mock.method(fs.promises, 'rmdir', async (target: fs.PathLike, options?: fs.RmDirOptions) => {
    if (!removalWasHeld && path.resolve(String(target)) === world) {
      removalWasHeld = true;
      markRemovalReached();
      await removalHeld;
    }
    return originalRmdir(target, options);
  });

  const deleting = deleteInstancePath(id, 'world');
  let restoring: Promise<TaskInfo>;
  try {
    // Raced with the delete itself so the test fails rather than waits forever if the removal never reaches the hold.
    await Promise.race([removalReached, deleting]);
    assert.equal(removalWasHeld, true, '删除应停在被拦住的那一步');
    restoring = startRestoreTask(id, backup.result!.backupId as string, { backupCurrent: false });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(processManager.getMaintenance(id), null, '删除持锁期间，还原不得进入维护');
    assert.equal(fs.readFileSync(path.join(world, 'level.dat'), 'utf8'), 'level-v2', '删除持锁期间，实例目录不得被替换');
  } finally {
    releaseRemoval();
  }
  await deleting;

  const restored = await waitForTask(await restoring);
  assert.equal(restored.status, 'completed', restored.error);
  assert.equal(fs.readFileSync(path.join(world, 'level.dat'), 'utf8'), 'level-v1');
  assert.ok(fs.existsSync(path.join(world, 'region', 'r.0.0.mca')), '还原出的目录不得被此前的删除波及');
});

test('a file delete that was waiting for the instance lock is refused once a restore has entered maintenance ahead of it', async () => {
  const { id, dir } = await setup();
  const { processManager } = await import('./process-manager.js');
  const { startBackupTask, startRestoreTask } = await import('./backup-service.js');
  const { deleteInstancePath } = await import('../routes/files.js');
  const backup = await waitForTask(await startBackupTask(id));
  assert.equal(backup.status, 'completed', backup.error);
  fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'level-v2');

  // Another operation on the instance holds the lock; the restore queues behind it first, then the delete.
  let releaseHolder!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseHolder = resolve;
  });
  const holder = processManager.runExclusive(id, () => held);
  let restoring: Promise<TaskInfo>;
  let deleteOutcome: Promise<unknown>;
  try {
    restoring = startRestoreTask(id, backup.result!.backupId as string, { backupCurrent: false });
    // The restore has not entered maintenance yet, so the delete passes the check made before waiting for the lock.
    assert.equal(processManager.getMaintenance(id), null);
    deleteOutcome = deleteInstancePath(id, 'world').then(() => null, (error: unknown) => error);
  } finally {
    releaseHolder();
  }
  await holder;

  const refused = await deleteOutcome;
  assert.ok(hasKey('server.backups.busyRestoring')(refused), `删除应在进锁后被拒绝，实际：${String(refused)}`);
  assert.equal((refused as { statusCode?: number }).statusCode, 409);
  const restored = await waitForTask(await restoring);
  assert.equal(restored.status, 'completed', restored.error);
  assert.equal(fs.readFileSync(path.join(dir, 'world', 'level.dat'), 'utf8'), 'level-v1');
  assert.ok(fs.existsSync(path.join(dir, 'world', 'region', 'r.0.0.mca')));
});

test('a running server first pauses autosave and flushes to disk, and autosave resumes after packing; restore is refused while running', { skip: process.platform === 'win32' }, async (t) => {
  const { id, dir } = await setup();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-fake-java-'));
  const log = path.join(bin, 'commands.log');
  // Fake java: echoes startup info, prints the save-complete notice on save-all flush, and exits on stop.
  fs.writeFileSync(
    path.join(bin, 'java'),
    [
      '#!/bin/sh',
      'echo "Done (0.1s)! For help, type help"',
      'while IFS= read -r line; do',
      `  echo "$line" >> '${log}'`,
      '  case "$line" in',
      // Print a forged chat line first, then the real save log: only the latter counts as save complete.
      '    "save-all flush") echo "[00:00:00] [Server thread/INFO]: <Steve> Saved the game"; echo "[00:00:01] [Server thread/INFO]: Saved the game" ;;',
      '    stop) exit 0 ;;',
      '  esac',
      'done',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
  const { processManager } = await import('./process-manager.js');
  const { getInstanceRow } = await import('./instance-service.js');
  const { listBackups, startBackupTask, startRestoreTask } = await import('./backup-service.js');
  t.after(async () => {
    await processManager.stop(id, true).catch(() => undefined);
    process.env.PATH = originalPath;
    fs.rmSync(bin, { recursive: true, force: true });
  });

  await processManager.start(getInstanceRow(id)!);
  for (let attempt = 0; attempt < 200 && processManager.getStatus(id) !== 'running'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(processManager.getStatus(id), 'running');

  const task = await waitForTask(await startBackupTask(id));
  assert.equal(task.status, 'completed', task.error);
  const [backup] = listBackups(id);
  assert.equal(backup?.wasRunning, true);
  for (let attempt = 0; attempt < 200 && !fs.readFileSync(log, 'utf8').includes('save-on'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['save-off', 'save-all flush', 'save-on']);
  assert.ok(fs.existsSync(path.join(dir, 'server.properties')));

  await assert.rejects(startRestoreTask(id, backup!.id), hasKey('server.backups.restoreRunning'));
});

test('an uploaded backup enters the list only after verification passes, and corrupted files are rejected', async () => {
  const { id } = await setup();
  const { getBackupWithArchive, listBackups, saveUploadedBackup, startBackupTask } = await import('./backup-service.js');
  const created = await waitForTask(await startBackupTask(id));
  assert.equal(created.status, 'completed', created.error);
  const [original] = listBackups(id);
  const bytes = fs.readFileSync(getBackupWithArchive(id, original!.id).archive);

  const uploaded = await saveUploadedBackup(id, Readable.from([bytes]));
  assert.equal(uploaded.source, 'upload');
  assert.equal(uploaded.sha256, original!.sha256);
  assert.equal(uploaded.sizeBytes, bytes.length);
  assert.equal(listBackups(id).length, 2);

  await assert.rejects(
    saveUploadedBackup(id, Readable.from([bytes.subarray(0, 100)])),
    hasKey('server.backups.archive.corrupted'),
  );
  assert.equal(listBackups(id).length, 2);
});

test('startup recovery after an interrupted directory swap: the old directory is moved back when not in place, and unfinished backup temp files are cleaned up', async () => {
  const { id, dir } = await setup();
  const { backupRoot, recoverInterruptedBackups } = await import('./backup-service.js');
  const taskDir = path.join(dataRoot, '.mystry-staging', 'crashed-task');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, '.mystry-restore-swap.json'),
    JSON.stringify({ version: 1, taskId: 'crashed-task', instanceId: id }),
  );
  fs.renameSync(dir, path.join(taskDir, '.mystry-restore-previous'));
  const tempDir = path.join(backupRoot(), id);
  fs.mkdirSync(tempDir, { recursive: true });
  fs.writeFileSync(path.join(tempDir, '.tmp-20261026-000000-abcdef.tar.gz'), 'partial');

  const result = recoverInterruptedBackups();
  assert.equal(result.restoresRolledBack, 1);
  assert.equal(result.tempFilesRemoved, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'world', 'level.dat'), 'utf8'), 'level-v1');
  assert.equal(fs.existsSync(path.join(taskDir, '.mystry-restore-swap.json')), false);
});

test('save-complete detection: recognizes server logs of each version, not player chat', async () => {
  const { isSaveConfirmationLine } = await import('./backup-service.js');
  const accepted = [
    '[12:00:00] [Server thread/INFO]: Saved the game',
    '[12:00:00] [Server thread/INFO]: Saved the world',
    '[12:00:00 INFO]: Saved the game',
    '[12:00:00] [Server thread/INFO] [minecraft/MinecraftServer]: Saved the game',
    '\x1b[36m[12:00:00 INFO]: \x1b[0mSaved the game\x1b[m',
    '[12:00:00] [Server thread/INFO]: All dimensions are saved',
    'Saved the game',
    '[19:08:28] [Server thread/INFO]: System chat: Saved the game',
    '[19:08:28 INFO]: System chat: Saved the game',
  ];
  const rejected = [
    '[12:00:00] [Server thread/INFO]: <Steve> Saved the game',
    '[19:08:28] [Server thread/INFO]: System chat: Saving the game (this may take a moment!)',
    '[19:08:28] [Server thread/INFO]: System chat: [Steve] Saved the game',
    '[19:08:28] [Server thread/INFO]: System chat: <Steve> Saved the game',
    '[12:00:00] [Server thread/INFO]: <Steve> ]: Saved the game',
    '[12:00:00 INFO]: [Server] Saved the game',
    '[12:00:00 INFO]: * Steve Saved the game',
    '[12:00:00] [Server thread/INFO]: Saving the game (this may take a moment!)',
    '[12:00:00] [Server thread/INFO]: Automatic saving is now disabled',
  ];
  for (const line of accepted) assert.equal(isSaveConfirmationLine(line), true, line);
  for (const line of rejected) assert.equal(isSaveConfirmationLine(line), false, line);
});

test('after a restore the launch file, core type and version in the instance record follow the backup', async () => {
  const { id, dir } = await setup();
  const { getInstanceRow, updateInstanceServerFiles } = await import('./instance-service.js');
  const { startBackupTask, startRestoreTask } = await import('./backup-service.js');
  const before = getInstanceRow(id)!;
  const done = await waitForTask(await startBackupTask(id));
  assert.equal(done.status, 'completed', done.error);

  // Simulates upgrading the server after the backup: the jar was replaced and the record changed with it.
  fs.rmSync(path.join(dir, 'server.jar'));
  fs.writeFileSync(path.join(dir, 'server-1.21.jar'), 'new-jar');
  updateInstanceServerFiles(id, { jarFile: 'server-1.21.jar', coreType: 'paper', mcVersion: '1.21' });

  const restored = await waitForTask(await startRestoreTask(id, done.result!.backupId!, { backupCurrent: false }));
  assert.equal(restored.status, 'completed', restored.error);
  assert.equal(restored.result?.instanceRecordUpdated, true);
  const after = getInstanceRow(id)!;
  assert.equal(after.jar_file, before.jar_file);
  assert.equal(after.core_type, before.core_type);
  assert.equal(after.mc_version, before.mc_version);
  assert.ok(fs.existsSync(path.join(dir, after.jar_file)));
});

test('the instance record is kept when the launch file in the manifest is not in the backup', async () => {
  const { id, dir } = await setup();
  const { getInstanceRow, updateInstanceServerFiles } = await import('./instance-service.js');
  const { startBackupTask, startRestoreTask } = await import('./backup-service.js');
  // At backup time the record points at a jar that does not exist: after restore the record should not be changed to it.
  updateInstanceServerFiles(id, { jarFile: 'missing.jar', coreType: 'custom', mcVersion: null });
  const done = await waitForTask(await startBackupTask(id));
  assert.equal(done.status, 'completed', done.error);
  fs.writeFileSync(path.join(dir, 'server-1.21.jar'), 'new-jar');
  updateInstanceServerFiles(id, { jarFile: 'server-1.21.jar', coreType: 'paper', mcVersion: '1.21' });

  const restored = await waitForTask(await startRestoreTask(id, done.result!.backupId!, { backupCurrent: false }));
  assert.equal(restored.status, 'completed', restored.error);
  assert.equal(restored.result?.instanceRecordUpdated, false);
  assert.equal(getInstanceRow(id)!.jar_file, 'server-1.21.jar');
});

test('deleting a backup leaves no files; deleting the instance backup directory removes all backups', async () => {
  const { id } = await setup();
  const { backupRoot, deleteBackup, deleteInstanceBackups, listBackups, startBackupTask } = await import('./backup-service.js');
  const first = await waitForTask(await startBackupTask(id));
  const second = await waitForTask(await startBackupTask(id));
  assert.equal(first.status, 'completed', first.error);
  assert.equal(second.status, 'completed', second.error);
  const dir = path.join(backupRoot(), id);

  deleteBackup(id, first.result!.backupId!);
  assert.deepEqual(listBackups(id).map((item) => item.id), [second.result!.backupId]);
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.includes(first.result!.backupId!)),
    [],
    '压缩包、元数据和改名后的临时文件都应删除',
  );

  deleteInstanceBackups(id);
  assert.equal(fs.existsSync(dir), false);
  // Deleting once more (the directory no longer exists) does not throw.
  deleteInstanceBackups(id);
});

test('BACKUP_DIR cannot be placed inside the instance or upload directories', async () => {
  const { backupRoot } = await import('./backup-service.js');
  const { config } = await import('../config.js');
  const original = process.env.BACKUP_DIR;
  try {
    process.env.BACKUP_DIR = path.join(config.instancesDir, 'backups');
    assert.throws(() => backupRoot(), hasKey('server.backups.dirInsideManaged'));
    process.env.BACKUP_DIR = path.join(config.uploadDir, 'backups');
    assert.throws(() => backupRoot(), hasKey('server.backups.dirInsideManaged'));
  } finally {
    if (original === undefined) delete process.env.BACKUP_DIR;
    else process.env.BACKUP_DIR = original;
  }
});
