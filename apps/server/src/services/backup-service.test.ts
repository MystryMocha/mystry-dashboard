/**
 * Instance backup and restore regression: backup while stopped, backup while running (save-off/flush/save-on), restore overwrite and automatic backup,
 * mutual exclusion during maintenance, upload verification, directory swap recovery after a crash, and scheduled backups: when one is due, deferred, skipped, retried or
 * made up, what retention deletes, how a failure is recorded, and daylight-saving changes.
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

test('a backup or restore task that fails before its worker is called does not leave the instance in maintenance or the backup in use', async () => {
  const { id } = await setup();
  const { getDb } = await import('../db.js');
  const { processManager } = await import('./process-manager.js');
  const { deleteBackup, listBackups, startBackupTask, startRestoreTask } = await import('./backup-service.js');
  const made = await waitForTask(await startBackupTask(id));
  assert.equal(made.status, 'completed', made.error);
  const backupId = made.result!.backupId as string;

  // Stands in for a write error at the moment a task is marked as running, which ends it before its worker is called.
  const failBeforeWorker = async (start: () => Promise<TaskInfo>): Promise<TaskInfo> => {
    getDb().exec(`CREATE TRIGGER refuse_running BEFORE UPDATE ON tasks WHEN NEW.status = 'running'
      BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`);
    try {
      return await waitForTask(await start());
    } finally {
      getDb().exec('DROP TRIGGER refuse_running');
    }
  };

  const backup = await failBeforeWorker(() => startBackupTask(id));
  assert.equal(backup.status, 'failed');
  assert.equal(listBackups(id).length, 1, '前置：这次备份没有运行');
  assert.equal(processManager.getMaintenance(id), null);

  const restore = await failBeforeWorker(() => startRestoreTask(id, backupId, { backupCurrent: false }));
  assert.equal(restore.status, 'failed');
  assert.equal(processManager.getMaintenance(id), null);

  const again = await waitForTask(await startBackupTask(id));
  assert.equal(again.status, 'completed', again.error);
  deleteBackup(id, backupId);
  assert.deepEqual(listBackups(id).map((item) => item.id), [again.result!.backupId]);
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

test('backup upload stages directly in the target backup directory and EXDEV fallback copies asynchronously', async (t) => {
  const { id } = await setup();
  const {
    backupRoot,
    getBackupWithArchive,
    listBackups,
    moveBackupArchiveIntoPlace,
    saveUploadedBackup,
    startBackupTask,
  } = await import('./backup-service.js');
  const { config } = await import('../config.js');
  const created = await waitForTask(await startBackupTask(id));
  assert.equal(created.status, 'completed', created.error);
  const [original] = listBackups(id);
  const bytes = fs.readFileSync(getBackupWithArchive(id, original!.id).archive);

  // Confirm backup upload writes its temp file inside BACKUP_DIR/<instanceId>/ rather than DATA_DIR/uploads/.
  const targetBackupDir = path.join(backupRoot(), id);
  const renamedSources: string[] = [];
  const originalPromiseRename = fs.promises.rename.bind(fs.promises);
  const renameSpy = t.mock.method(fs.promises, 'rename', async (src: fs.PathLike, dest: fs.PathLike) => {
    renamedSources.push(path.resolve(String(src)));
    return originalPromiseRename(src, dest);
  });
  try {
    await saveUploadedBackup(id, Readable.from([bytes]));
  } finally {
    renameSpy.mock.restore();
  }
  assert.equal(renamedSources.length, 1);
  assert.equal(path.dirname(renamedSources[0]!), path.resolve(targetBackupDir));
  assert.match(path.basename(renamedSources[0]!), /^\.tmp-upload-.*\.tar\.gz$/);
  assert.notEqual(path.dirname(renamedSources[0]!), path.resolve(config.uploadDir));

  // Confirm EXDEV fallback uses async fs.promises.copyFile rather than blocking fs.copyFileSync.
  const crossDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-exdev-test-'));
  t.after(() => fs.rmSync(crossDir, { recursive: true, force: true }));
  const srcFile = path.join(crossDir, 'source.tar.gz');
  const dstFile = path.join(crossDir, 'dest.tar.gz');
  fs.writeFileSync(srcFile, bytes);

  let firstRename = true;
  const exdevRename = t.mock.method(fs.promises, 'rename', async (src: fs.PathLike, dest: fs.PathLike) => {
    if (firstRename) {
      firstRename = false;
      throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
    }
    return originalPromiseRename(src, dest);
  });
  const syncCopySpy = t.mock.method(fs, 'copyFileSync', () => {
    assert.fail('moveBackupArchiveIntoPlace must not call synchronous fs.copyFileSync');
  });
  try {
    await moveBackupArchiveIntoPlace(srcFile, dstFile);
  } finally {
    exdevRename.mock.restore();
    syncCopySpy.mock.restore();
  }
  assert.deepEqual(fs.readFileSync(dstFile), bytes);
  assert.equal(fs.existsSync(srcFile), false);
  assert.deepEqual(fs.readdirSync(crossDir), ['dest.tar.gz']);
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

test('startup backup recovery ignores non-instance directories and survives unreadable directories or busy temp files', async () => {
  await setup();
  const { backupRoot, recoverInterruptedBackups } = await import('./backup-service.js');
  const root = backupRoot();

  const lostAndFound = path.join(root, 'lost+found');
  const sysVolInfo = path.join(root, 'System Volume Information');
  const unreadableDir = path.join(root, 'unreadable_inst');
  const healthyDir = path.join(root, 'healthy_inst');
  for (const dir of [lostAndFound, sysVolInfo, unreadableDir, healthyDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const ignoredFileA = path.join(lostAndFound, '.tmp-20261026-000000-aaaaaa.tar.gz');
  const ignoredFileB = path.join(sysVolInfo, '.tmp-20261026-000000-bbbbbb.tar.gz');
  const busyFile = path.join(healthyDir, '.tmp-20261026-000000-busy01.tar.gz');
  const removableFile = path.join(healthyDir, '.tmp-20261026-000000-clean1.tar.gz');
  for (const file of [ignoredFileA, ignoredFileB, busyFile, removableFile]) {
    fs.writeFileSync(file, 'partial');
  }

  const originalReaddirSync = fs.readdirSync;
  const originalRmSync = fs.rmSync;
  fs.readdirSync = ((target: fs.PathLike, options?: unknown) => {
    if (path.resolve(String(target)) === path.resolve(unreadableDir)) {
      const error = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      throw error;
    }
    return originalReaddirSync(target, options as never);
  }) as typeof fs.readdirSync;
  fs.rmSync = ((target: fs.PathLike, options?: fs.RmOptions) => {
    if (path.resolve(String(target)) === path.resolve(busyFile)) {
      const error = Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      throw error;
    }
    return originalRmSync(target, options);
  }) as typeof fs.rmSync;

  let result;
  let ignoredAStillExists = false;
  let ignoredBStillExists = false;
  let removableStillExists = true;
  try {
    result = recoverInterruptedBackups();
    ignoredAStillExists = fs.existsSync(ignoredFileA);
    ignoredBStillExists = fs.existsSync(ignoredFileB);
    removableStillExists = fs.existsSync(removableFile);
  } finally {
    fs.readdirSync = originalReaddirSync;
    fs.rmSync = originalRmSync;
    for (const dir of [lostAndFound, sysVolInfo, unreadableDir, healthyDir]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  assert.equal(ignoredAStillExists, true, 'lost+found must not be scanned or modified');
  assert.equal(ignoredBStillExists, true, 'System Volume Information must not be scanned or modified');
  assert.equal(removableStillExists, false, 'unlocked temp archive in healthy instance dir should be removed');
  assert.equal(result.tempFilesRemoved, 1, 'unlocked temp archive in healthy instance dir should still be cleaned');
  assert.equal(result.cleanupWarnings.length, 2, 'unreadable directory and busy temp file should be reported as warnings');
  assert.ok(result.cleanupWarnings.some((entry) => entry.includes('unreadable_inst')));
  assert.ok(result.cleanupWarnings.some((entry) => entry.includes('busy01')));
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

test('cross-platform Forge/NeoForge restore re-resolves @args: for the current platform instead of copying foreign OS args', async () => {
  const { id, dir } = await setup();
  const { getInstanceRow, updateInstanceServerFiles } = await import('./instance-service.js');
  const { startBackupTask, startRestoreTask, syncInstanceRecordWithManifest } = await import('./backup-service.js');
  const { BACKUP_FORMAT, BACKUP_FORMAT_VERSION } = await import('./backup-archive.js');

  const forgeRelDir = 'libraries/net/minecraftforge/forge/1.20.1-47.2.0';
  const winArgs = `@args:${forgeRelDir}/win_args.txt`;
  const unixArgs = `@args:${forgeRelDir}/unix_args.txt`;
  fs.mkdirSync(path.join(dir, ...forgeRelDir.split('/')), { recursive: true });
  fs.writeFileSync(path.join(dir, ...forgeRelDir.split('/'), 'win_args.txt'), '-cp a;b\n');
  fs.writeFileSync(path.join(dir, ...forgeRelDir.split('/'), 'unix_args.txt'), '-cp a:b\n');

  // Record the opposite platform's args file before backing up to simulate a backup uploaded from another OS.
  const foreignArgs = process.platform === 'win32' ? unixArgs : winArgs;
  const nativeArgs = process.platform === 'win32' ? winArgs : unixArgs;
  updateInstanceServerFiles(id, { jarFile: foreignArgs, coreType: 'forge', mcVersion: '1.20.1' });
  const backupTask = await waitForTask(await startBackupTask(id));
  assert.equal(backupTask.status, 'completed', backupTask.error);

  const restored = await waitForTask(await startRestoreTask(id, backupTask.result!.backupId!, { backupCurrent: false }));
  assert.equal(restored.status, 'completed', restored.error);
  assert.equal(restored.result?.instanceRecordUpdated, true);
  assert.equal(getInstanceRow(id)!.jar_file, nativeArgs, 'restore must switch @args: to the current platform');

  // Also verify both cross-platform directions directly via syncInstanceRecordWithManifest.
  const winManifest: import('./backup-archive.js').BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    instance: { id, name: 'forge', coreType: 'forge', mcVersion: '1.20.1', jarFile: winArgs },
    wasRunning: false,
    directories: [],
    files: [],
  };
  updateInstanceServerFiles(id, { jarFile: 'server.jar', coreType: 'custom', mcVersion: null });
  assert.equal(await syncInstanceRecordWithManifest(id, winManifest, 'linux'), true);
  assert.equal(getInstanceRow(id)!.jar_file, unixArgs);

  const unixManifest: import('./backup-archive.js').BackupManifest = {
    ...winManifest,
    instance: { ...winManifest.instance, jarFile: unixArgs },
  };
  assert.equal(await syncInstanceRecordWithManifest(id, unixManifest, 'win32'), true);
  assert.equal(getInstanceRow(id)!.jar_file, winArgs);
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

// ---------------------------------------------------------------------------
// Scheduled backups. The scheduler reads a clock the cases move by hand, in a named time zone, so the outcome does not
// depend on the time zone of the machine running them.

async function waitForIdleQueue(): Promise<void> {
  const { getTaskActivity } = await import('./task-service.js');
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const { running, queued } = getTaskActivity();
    if (running === 0 && queued === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('任务队列未在预期时间内清空');
}

/** Fills the task queue with tasks that do nothing until released; the returned function lets them finish. */
async function holdQueue(count: number): Promise<() => Promise<void>> {
  const { runBackgroundTask } = await import('./task-service.js');
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  for (let index = 0; index < count; index += 1) {
    await runBackgroundTask('download', { key: 'server.tasks.queued' }, () => gate);
  }
  return async () => {
    open();
    await waitForIdleQueue();
  };
}

async function scheduling(timeZone = 'UTC') {
  const service = await import('./backup-schedule-service.js');
  const { getDb } = await import('../db.js');
  const { listBackups } = await import('./backup-service.js');
  const { processManager } = await import('./process-manager.js');
  // Schedules left enabled by earlier cases would come due on this case's clock as well.
  getDb().exec('DELETE FROM instance_backup_schedules');
  service.attachBackupScheduleLifecycle();
  // `free` is a function when the free space depends on what the run has deleted by the time it is read.
  const state = { now: new Date(0), free: null as number | null | (() => number | null) };
  const readFreeBytes = () => (typeof state.free === 'function' ? state.free() : state.free);
  const create = () => service.createBackupScheduler({ now: () => state.now, timeZone, readFreeBytes });
  let scheduler = create();
  return {
    state,
    margin: service.BACKUP_SCHEDULE_DEFAULTS.freeSpaceMarginBytes,
    enable(id: string, time: string, at: string, keep = 7) {
      state.now = new Date(at);
      return service.saveBackupSchedule(id, { enabled: true, time, keep }, { now: state.now, timeZone });
    },
    /** One check at the given moment, without waiting for what it queued. */
    async check(at: string) {
      state.now = new Date(at);
      await scheduler.check();
    },
    /** One check at the given moment, then waits until the queue is empty again. */
    async checkAt(at: string) {
      state.now = new Date(at);
      await scheduler.check();
      await waitForIdleQueue();
    },
    stop: () => scheduler.stop(),
    /** What a panel restart leaves: the saved schedule, and a scheduler that remembers nothing. */
    restartPanel() {
      scheduler.stop();
      scheduler = create();
    },
    info: (id: string) => service.getBackupSchedule(id),
    scheduled: (id: string) => listBackups(id).filter((backup) => backup.source === 'scheduled'),
    serverRan: (id: string) => processManager.emit('status', id, 'running'),
  };
}

test('a scheduled backup is queued when its time of day comes, once a day, and not for a time that had passed when the schedule was saved', async () => {
  const { id } = await setup();
  const { getBackupSchedule } = await import('./backup-schedule-service.js');
  const s = await scheduling();
  assert.deepEqual(
    { ...getBackupSchedule(id), utcOffsetMinutes: 0 },
    { enabled: false, time: '04:00', keep: 7, utcOffsetMinutes: 0, lastBackupAt: null, lastFailure: null },
    '未保存过计划时返回默认值',
  );

  s.enable(id, '04:00', '2026-06-01T10:00:00Z');
  // With no earlier backup there is no size to compare with, so free space does not hold back the first one.
  s.state.free = 0;
  await s.checkAt('2026-06-01T10:01:00Z');
  await s.checkAt('2026-06-02T03:59:00Z');
  assert.equal(s.scheduled(id).length, 0, '保存时已过去的时刻不补，时刻未到不备份');

  await s.checkAt('2026-06-02T04:00:00Z');
  const [backup] = s.scheduled(id);
  assert.ok(backup, '到点应生成自动备份');
  assert.equal(backup.fileCount, 3);
  assert.equal(s.info(id).lastBackupAt, backup.createdAt);
  assert.equal(s.info(id).lastFailure, null);

  s.serverRan(id);
  await s.checkAt('2026-06-02T04:01:00Z');
  await s.checkAt('2026-06-02T23:59:00Z');
  assert.equal(s.scheduled(id).length, 1, '同一天只备份一次');
});

test('a scheduled backup is skipped while the server has not run since the last one, unless that backup is gone', async () => {
  const { id } = await setup();
  const { deleteBackup, listBackups } = await import('./backup-service.js');
  const { listTasks } = await import('./task-service.js');
  const s = await scheduling();
  s.enable(id, '04:00', '2026-06-01T10:00:00Z');
  await s.checkAt('2026-06-02T04:00:00Z');
  assert.equal(s.scheduled(id).length, 1);
  const tasksBefore = listTasks(200).length;

  await s.checkAt('2026-06-03T04:00:00Z');
  assert.equal(s.scheduled(id).length, 1, '服务器未运行过，不再生成相同的备份');
  assert.equal(listTasks(200).length, tasksBefore, '跳过不产生任务记录');

  // The skipped slot is settled: the server running later that day does not bring it back.
  s.serverRan(id);
  await s.checkAt('2026-06-03T10:00:00Z');
  assert.equal(s.scheduled(id).length, 1);
  await s.checkAt('2026-06-04T04:00:00Z');
  assert.equal(s.scheduled(id).length, 2, '服务器运行过，下一个时刻照常备份');

  await s.checkAt('2026-06-05T04:00:00Z');
  assert.equal(s.scheduled(id).length, 2);
  deleteBackup(id, s.scheduled(id)[0]!.id);
  await s.checkAt('2026-06-06T04:00:00Z');
  assert.equal(s.scheduled(id).length, 2, '上一份自动备份已被删除时重新备份');
  assert.equal(listBackups(id).length, 2);
});

test('a due backup waits while another task is running or the instance is busy, and scheduled backups are queued one at a time', async (t) => {
  const a = await setup();
  const b = await setup();
  const { processManager } = await import('./process-manager.js');
  const { getTaskActivity } = await import('./task-service.js');
  const s = await scheduling();
  s.enable(a.id, '04:00', '2026-06-01T10:00:00Z');
  s.enable(b.id, '04:00', '2026-06-01T10:00:00Z');
  const total = () => s.scheduled(a.id).length + s.scheduled(b.id).length;

  const release = await holdQueue(1);
  await s.check('2026-06-02T04:00:00Z');
  assert.deepEqual(getTaskActivity(), { running: 1, queued: 0 }, '有其他任务在运行时不排入，即使队列还有空位');
  await release();
  assert.equal(total(), 0);

  const endMaintenance = processManager.beginMaintenance(a.id, 'server.backups.busyRestoring');
  const status = t.mock.method(processManager, 'getStatus', (id: string) => (id === b.id ? 'stopping' : 'stopped'));
  try {
    await s.checkAt('2026-06-02T04:01:00Z');
    assert.equal(total(), 0, '维护中或正在停止的实例不排入');
  } finally {
    status.mock.restore();
    endMaintenance();
  }
  assert.equal(s.info(a.id).lastFailure, null, '推迟不算失败');
  assert.equal(s.info(b.id).lastFailure, null);

  await s.check('2026-06-02T04:02:00Z');
  assert.deepEqual(getTaskActivity(), { running: 1, queued: 0 });
  await s.check('2026-06-02T04:03:00Z');
  assert.deepEqual(getTaskActivity(), { running: 1, queued: 0 }, '已有一个定时备份在运行时，另一个留给下次检查');
  await waitForIdleQueue();
  assert.equal(total(), 1);

  await s.checkAt('2026-06-02T04:04:00Z');
  assert.equal(s.scheduled(a.id).length, 1);
  assert.equal(s.scheduled(b.id).length, 1);
});

test('slots missed while the panel was off are made up once after the next start', async () => {
  const { id } = await setup();
  const s = await scheduling();
  s.enable(id, '04:00', '2026-06-01T10:00:00Z');
  await s.checkAt('2026-06-02T04:00:00Z');
  assert.equal(s.scheduled(id).length, 1);
  s.serverRan(id);

  // Off from the evening of 2 June to the afternoon of 5 June: the slots of 3, 4 and 5 June all went by.
  s.restartPanel();
  await s.checkAt('2026-06-05T15:00:00Z');
  assert.equal(s.scheduled(id).length, 2, '错过的时刻在启动后补一次');
  s.serverRan(id);
  await s.checkAt('2026-06-05T15:01:00Z');
  await s.checkAt('2026-06-05T23:00:00Z');
  assert.equal(s.scheduled(id).length, 2, '错过几天也只补一次');

  await s.checkAt('2026-06-06T04:00:00Z');
  assert.equal(s.scheduled(id).length, 3);
});

test('retention deletes only the oldest scheduled backups of the instance; manual, uploaded and pre-restore backups stay', async () => {
  const { id } = await setup();
  const other = await setup();
  const { getBackupWithArchive, listBackups, saveUploadedBackup, startBackupTask, startRestoreTask } = await import('./backup-service.js');
  const s = await scheduling();
  s.enable(id, '04:00', '2026-06-01T10:00:00Z', 2);
  s.enable(other.id, '04:00', '2026-06-01T10:00:00Z', 2);

  const manual = await waitForTask(await startBackupTask(id));
  assert.equal(manual.status, 'completed', manual.error);
  const restored = await waitForTask(await startRestoreTask(id, manual.result!.backupId!, { backupCurrent: true }));
  assert.equal(restored.status, 'completed', restored.error);

  // Day 1: both instances, one per check. The other server then stays off, so this scheduled backup remains its only one.
  await s.checkAt('2026-06-02T04:00:00Z');
  await s.checkAt('2026-06-02T04:01:00Z');
  assert.equal(s.scheduled(id).length, 1);
  assert.equal(s.scheduled(other.id).length, 1);
  const first = s.scheduled(id)[0]!;
  // A scheduled archive that is uploaded again is an upload, which retention never touches.
  const uploaded = await saveUploadedBackup(id, Readable.from([fs.readFileSync(getBackupWithArchive(id, first.id).archive)]));
  assert.equal(uploaded.source, 'upload');

  const made = [first.id];
  for (const day of ['03', '04', '05']) {
    s.serverRan(id);
    await s.checkAt(`2026-06-${day}T04:00:00Z`);
    const newest = s.scheduled(id)[0]!;
    assert.ok(!made.includes(newest.id), `6 月 ${day} 日应生成新的自动备份`);
    made.push(newest.id);
  }

  assert.deepEqual(s.scheduled(id).map((backup) => backup.id), [made[3], made[2]], '只保留最新的两份自动备份');
  const sources = listBackups(id).map((backup) => backup.source).sort();
  assert.deepEqual(sources, ['manual', 'pre-restore', 'scheduled', 'scheduled', 'upload']);
  assert.equal(s.scheduled(other.id).length, 1, '另一个实例的自动备份不受影响');
});

test('retention leaves a scheduled backup that a restore is using', async () => {
  const { id } = await setup();
  const { listBackups, pruneScheduledBackups, startRestoreTask } = await import('./backup-service.js');
  const s = await scheduling();
  s.enable(id, '04:00', '2026-06-01T10:00:00Z');
  for (const day of ['02', '03', '04']) {
    await s.checkAt(`2026-06-${day}T04:00:00Z`);
    s.serverRan(id);
  }
  const [newest, middle, oldest] = s.scheduled(id);
  assert.ok(newest && middle && oldest);

  // A restore and a scheduled backup of one instance exclude each other through the maintenance flag, so the refusal
  // is exercised on the retention step itself, while the restore waits in the queue.
  const release = await holdQueue(1);
  const restore = await startRestoreTask(id, oldest.id, { backupCurrent: false });
  const pruned = pruneScheduledBackups(id, 1);
  assert.deepEqual(pruned, { deleted: [middle.id], kept: [oldest.id] });
  assert.deepEqual(s.scheduled(id).map((backup) => backup.id), [newest.id, oldest.id]);
  await release();
  const restored = await waitForTask(restore);
  assert.equal(restored.status, 'completed', restored.error);

  assert.deepEqual(pruneScheduledBackups(id, 1), { deleted: [oldest.id], kept: [] });
  assert.deepEqual(listBackups(id).map((backup) => backup.id), [newest.id]);
  assert.deepEqual(pruneScheduledBackups(id, 0), { deleted: [], kept: [] }, '无效的保留数量不删除任何备份');
  assert.equal(listBackups(id).length, 1);
});

test('a scheduled backup short of disk space first deletes the scheduled backups beyond the number to keep, and none within it', async () => {
  const { id } = await setup();
  const s = await scheduling();
  s.enable(id, '04:00', '2026-06-01T10:00:00Z', 3);
  for (const day of ['02', '03', '04']) {
    await s.checkAt(`2026-06-${day}T04:00:00Z`);
    s.serverRan(id);
  }
  const [newest, middle, oldest] = s.scheduled(id);
  assert.ok(newest && middle && oldest);
  const needed = newest.sizeBytes + s.margin;
  const ids = () => s.scheduled(id).map((backup) => backup.id);

  s.state.free = needed - 1;
  await s.checkAt('2026-06-05T04:00:00Z');
  assert.deepEqual(ids(), [newest.id, middle.id, oldest.id], '份数未超出时不为腾出空间而删除备份');
  assert.equal(s.info(id).lastFailure?.errorI18n?.key, 'server.backups.schedule.diskSpace');

  // Lowered to two, on a disk that is still too full once the third is gone: the run fails, and the third stays deleted.
  s.enable(id, '04:00', '2026-06-05T12:00:00Z', 2);
  await s.checkAt('2026-06-06T04:00:00Z');
  assert.deepEqual(ids(), [newest.id, middle.id], '空间不足时先删除超出保留份数的定时备份');
  assert.equal(s.info(id).lastFailure?.at, '2026-06-06T04:00:00.000Z');
  assert.equal(s.info(id).lastFailure?.errorI18n?.key, 'server.backups.schedule.diskSpace');

  // Lowered to one, and this time deleting the backup beyond the count frees enough.
  s.enable(id, '04:00', '2026-06-06T12:00:00Z', 1);
  s.state.free = () => (s.scheduled(id).length > 1 ? needed - 1 : needed);
  await s.checkAt('2026-06-07T04:00:00Z');
  const [made, ...others] = s.scheduled(id);
  assert.ok(made, '腾出空间后应生成新的定时备份');
  assert.deepEqual(others, []);
  assert.ok(![newest.id, middle.id, oldest.id].includes(made.id));
  assert.equal(s.info(id).lastFailure, null);
  assert.equal(s.info(id).lastBackupAt, made.createdAt);
});

test('a scheduled backup dated earlier than the ones already there, as after the clock is set back, is kept as the newest', async () => {
  const { id } = await setup();
  const { backupRoot, getBackup } = await import('./backup-service.js');
  const s = await scheduling();
  s.enable(id, '04:00', '2026-06-01T10:00:00Z', 2);
  for (const day of ['02', '03']) {
    await s.checkAt(`2026-06-${day}T04:00:00Z`);
    s.serverRan(id);
  }
  const [later, earlier] = s.scheduled(id);
  assert.ok(later && earlier);
  // A backup is dated by the real clock, which a case cannot set back; dating the two already there ahead of it
  // leaves the same order.
  const redate = (backupId: string, createdAt: string) => {
    const file = path.join(backupRoot(), id, `${backupId}.json`);
    fs.writeFileSync(file, `${JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), createdAt })}\n`);
  };
  redate(later.id, '2099-01-02T00:00:00.000Z');
  redate(earlier.id, '2099-01-01T00:00:00.000Z');

  await s.checkAt('2026-06-04T04:00:00Z');
  const kept = s.scheduled(id);
  assert.equal(kept.length, 2);
  assert.equal(kept[0]!.id, later.id);
  const made = kept[1]!;
  assert.notEqual(made.id, earlier.id, '刚生成的备份不因日期较早而被删除，被删除的是其余备份中最旧的一份');
  assert.equal(s.info(id).lastBackupAt, made.createdAt);
  assert.equal(getBackup(id, made.id).source, 'scheduled');
});

test('older scheduled backups are deleted by the number to keep saved at that moment, not the one in force when the run was queued', async () => {
  const { id } = await setup();
  const { getTaskActivity } = await import('./task-service.js');
  const s = await scheduling();
  s.enable(id, '04:00', '2026-06-01T10:00:00Z', 1);
  await s.checkAt('2026-06-02T04:00:00Z');
  s.serverRan(id);
  const [first] = s.scheduled(id);
  assert.ok(first);

  await s.check('2026-06-03T04:00:00Z');
  assert.deepEqual(getTaskActivity(), { running: 1, queued: 0 });
  // Saved while the files are being packed.
  s.enable(id, '04:00', '2026-06-03T04:00:00Z', 5);
  await waitForIdleQueue();
  assert.equal(s.scheduled(id).length, 2);
  assert.ok(s.scheduled(id).some((backup) => backup.id === first.id), '备份进行中调高保留份数后，原有的备份应保留');
});

test('a scheduled backup that fails is a failed task naming the instance, and its reason is kept until the next one succeeds', async () => {
  const { id } = await setup();
  const { getInstanceRow } = await import('./instance-service.js');
  const { listBackups, startBackupTask } = await import('./backup-service.js');
  const { listTasks } = await import('./task-service.js');
  const name = getInstanceRow(id)!.name;
  const s = await scheduling();
  const manual = await waitForTask(await startBackupTask(id));
  assert.equal(manual.status, 'completed', manual.error);
  const previousSize = listBackups(id)[0]!.sizeBytes;
  s.enable(id, '04:00', '2026-06-01T10:00:00Z');
  const failedTasks = () => listTasks(200).filter((task) => (
    task.errorI18n?.key === 'server.backups.schedule.runFailed' && task.errorI18n.params?.name === name
  ));

  s.state.free = previousSize + s.margin - 1;
  await s.checkAt('2026-06-02T04:00:00Z');
  assert.equal(s.scheduled(id).length, 0);
  const [failed] = failedTasks();
  assert.ok(failed, '失败应在任务中心留下记录');
  assert.equal(failed.type, 'backup');
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.errorI18n?.params?.reason, {
    key: 'server.backups.schedule.diskSpace',
    params: { needed: previousSize + s.margin, available: previousSize + s.margin - 1 },
  });
  const failure = s.info(id).lastFailure;
  assert.equal(failure?.at, '2026-06-02T04:00:00.000Z');
  assert.equal(failure?.errorI18n?.key, 'server.backups.schedule.diskSpace');
  assert.match(failure?.error ?? '', /^Not enough disk space\./);
  assert.equal(s.info(id).lastBackupAt, null);

  await s.checkAt('2026-06-02T04:01:00Z');
  assert.equal(failedTasks().length, 1, '失败后当天不再重试');

  s.state.free = previousSize + s.margin;
  await s.checkAt('2026-06-03T04:00:00Z');
  assert.equal(s.scheduled(id).length, 1);
  assert.equal(s.info(id).lastFailure, null, '下一次成功后清除失败原因');
  assert.equal(s.info(id).lastBackupAt, s.scheduled(id)[0]!.createdAt);
});

test('a scheduled backup cut short by the server starting, stopping or crashing is tried again at the next check, three times a day at most', async () => {
  const { id } = await setup();
  const { getInstanceRow } = await import('./instance-service.js');
  const { listTasks } = await import('./task-service.js');
  const name = getInstanceRow(id)!.name;
  const s = await scheduling();
  s.enable(id, '04:00', '2026-06-01T10:00:00Z');
  const failedRuns = () => listTasks(200).filter((task) => (
    task.errorI18n?.key === 'server.backups.schedule.runFailed' && task.errorI18n.params?.name === name
  )).length;
  /** One check whose backup is cut short: the server starts while its files are being packed. */
  const interruptedCheck = async (at: string) => {
    await s.check(at);
    s.serverRan(id);
    await waitForIdleQueue();
  };

  await interruptedCheck('2026-06-02T04:00:00Z');
  await interruptedCheck('2026-06-02T04:01:00Z');
  assert.equal(failedRuns(), 2, '每次被打断都在任务中心留下一条失败任务');
  assert.equal(s.info(id).lastFailure, null, '被打断的前两次不记为失败');
  await s.checkAt('2026-06-02T04:02:00Z');
  assert.equal(s.scheduled(id).length, 1, '下次检查时重试');
  assert.equal(s.info(id).lastFailure, null);

  // A new day starts counting again: two interruptions still leave a third attempt.
  s.serverRan(id);
  await interruptedCheck('2026-06-03T04:00:00Z');
  await interruptedCheck('2026-06-03T04:01:00Z');
  assert.equal(s.info(id).lastFailure, null);
  await interruptedCheck('2026-06-03T04:02:00Z');
  const failure = s.info(id).lastFailure;
  assert.equal(failure?.at, '2026-06-03T04:02:00.000Z');
  assert.equal(failure?.errorI18n?.key, 'server.backups.serverStateChanged');
  assert.equal(failedRuns(), 5);

  await s.checkAt('2026-06-03T04:03:00Z');
  assert.equal(failedRuns(), 5, '第三次被打断后当天不再重试');
  assert.equal(s.scheduled(id).length, 1);

  await s.checkAt('2026-06-04T04:00:00Z');
  assert.equal(s.scheduled(id).length, 2);
  assert.equal(s.info(id).lastFailure, null);
});

test('a scheduled backup cut short after the scheduler stopped is not recorded as failed and is made up after the next start', async () => {
  const { id } = await setup();
  const { getTaskActivity, resetTaskRuntimeForTests, shutdownTasks } = await import('./task-service.js');
  const s = await scheduling();
  s.enable(id, '04:00', '2026-06-01T10:00:00Z');

  await s.check('2026-06-02T04:00:00Z');
  assert.deepEqual(getTaskActivity(), { running: 1, queued: 0 });
  // The panel begins to shut down: the scheduler stops first, and the task queue then aborts the run.
  s.stop();
  try {
    await shutdownTasks();
  } finally {
    // The queue would otherwise refuse the tasks of every later case.
    resetTaskRuntimeForTests();
  }
  assert.equal(s.scheduled(id).length, 0);
  assert.equal(s.info(id).lastFailure, null);
  await s.checkAt('2026-06-02T04:01:00Z');
  assert.equal(s.scheduled(id).length, 0, '停止后的调度器不再排入备份');

  s.restartPanel();
  await s.checkAt('2026-06-02T09:00:00Z');
  assert.equal(s.scheduled(id).length, 1);
});

test('a scheduled backup that fails for a reason of its own after the scheduler stopped is still recorded as failed', async () => {
  const { id } = await setup();
  const s = await scheduling();
  s.enable(id, '04:00', '2026-06-01T10:00:00Z');
  await s.checkAt('2026-06-02T04:00:00Z');
  assert.equal(s.scheduled(id).length, 1);
  s.serverRan(id);

  // The panel begins to shut down just as the next run reads the free space, and the disk turns out to be full.
  s.state.free = () => {
    s.stop();
    return 0;
  };
  await s.checkAt('2026-06-03T04:00:00Z');
  assert.equal(s.scheduled(id).length, 1);
  assert.equal(s.info(id).lastFailure?.errorI18n?.key, 'server.backups.schedule.diskSpace');
});

test('a due backup waits for a server that is starting instead of being skipped as unchanged', async (t) => {
  const { id } = await setup();
  const { processManager } = await import('./process-manager.js');
  const s = await scheduling();
  s.enable(id, '04:00', '2026-06-01T10:00:00Z');
  await s.checkAt('2026-06-02T04:00:00Z');
  assert.equal(s.scheduled(id).length, 1);

  // Start was clicked a moment before the time of day: the server does not count as having run yet.
  const status = t.mock.method(processManager, 'getStatus', () => 'starting');
  try {
    await s.checkAt('2026-06-03T04:00:00Z');
  } finally {
    status.mock.restore();
  }
  assert.equal(s.scheduled(id).length, 1);

  s.serverRan(id);
  await s.checkAt('2026-06-03T04:01:00Z');
  assert.equal(s.scheduled(id).length, 2, '服务器启动完成后，当天照常备份');
});

test('a scheduled backup is not skipped after files were changed through the panel while the server stayed stopped', async () => {
  const { id } = await setup();
  const { noteInstanceFilesChanged } = await import('./backup-schedule-service.js');
  const { deleteInstancePath } = await import('../routes/files.js');
  const s = await scheduling();
  s.enable(id, '04:00', '2026-06-01T10:00:00Z');
  await s.checkAt('2026-06-02T04:00:00Z');
  await s.checkAt('2026-06-03T04:00:00Z');
  assert.equal(s.scheduled(id).length, 1);

  noteInstanceFilesChanged(id);
  await s.checkAt('2026-06-04T04:00:00Z');
  assert.equal(s.scheduled(id).length, 2, '改过文件后照常备份');
  await s.checkAt('2026-06-05T04:00:00Z');
  assert.equal(s.scheduled(id).length, 2, '备份之后没有新的改动，重新开始跳过');

  await deleteInstancePath(id, 'world/level.dat');
  await s.checkAt('2026-06-06T04:00:00Z');
  assert.equal(s.scheduled(id).length, 3);
  assert.equal(s.scheduled(id)[0]!.fileCount, 2, '新备份里没有被删掉的文件');

  // A delete that fails may have removed part of a folder, so it counts as a change too.
  await assert.rejects(deleteInstancePath(id, 'world/missing.dat'));
  await s.checkAt('2026-06-07T04:00:00Z');
  assert.equal(s.scheduled(id).length, 4);
});

test('a file changed through the panel while a stopped server is being backed up keeps the next day due', async () => {
  const { id } = await setup();
  const { noteInstanceFilesChanged } = await import('./backup-schedule-service.js');
  const s = await scheduling();
  s.enable(id, '04:00', '2026-06-01T10:00:00Z');
  await s.checkAt('2026-06-02T04:00:00Z');
  assert.equal(s.scheduled(id).length, 1);

  // The run reads the free space after it was queued and before it packs, once an earlier backup exists; a change
  // noted there stands for one made while the files were being packed, which the archive may not hold.
  noteInstanceFilesChanged(id);
  s.state.free = () => {
    noteInstanceFilesChanged(id);
    return Number.MAX_SAFE_INTEGER;
  };
  await s.checkAt('2026-06-03T04:00:00Z');
  assert.equal(s.scheduled(id).length, 2);

  s.state.free = null;
  await s.checkAt('2026-06-04T04:00:00Z');
  assert.equal(s.scheduled(id).length, 3);
  // Nothing changed during that run, so the day after is skipped again.
  await s.checkAt('2026-06-05T04:00:00Z');
  assert.equal(s.scheduled(id).length, 3);
});

test('a settled date ahead of the clock does not hold back the schedule once the clock is corrected', async () => {
  const { id } = await setup();
  const s = await scheduling();
  s.enable(id, '04:00', '2026-06-01T10:00:00Z');
  // The clock was wrong by a month when this backup ran.
  await s.checkAt('2026-07-02T04:00:00Z');
  assert.equal(s.scheduled(id).length, 1);

  s.serverRan(id);
  await s.checkAt('2026-06-03T12:00:00Z');
  assert.equal(s.scheduled(id).length, 1);
  await s.checkAt('2026-06-04T04:00:00Z');
  assert.equal(s.scheduled(id).length, 2);
});

test('a time of day that a daylight-saving change skips or repeats comes due exactly once that day', async () => {
  const { latestSlot, wallClockAt } = await import('./backup-schedule-service.js');
  /** Every minute from `from` to `to`: the moments at which a new daily slot comes due. */
  function dueMoments(timeZone: string, time: string, from: string, to: string): string[] {
    const due: string[] = [];
    let settled = latestSlot(wallClockAt(new Date(from), timeZone), time);
    for (let instant = Date.parse(from); instant <= Date.parse(to); instant += 60_000) {
      const slot = latestSlot(wallClockAt(new Date(instant), timeZone), time);
      if (slot > settled) {
        due.push(new Date(instant).toISOString().slice(0, 16));
        settled = slot;
      }
    }
    return due;
  }

  // New York, 8 March 2026: 02:00 to 03:00 does not exist. 02:30 comes due as the clock reaches 03:00.
  assert.deepEqual(
    dueMoments('America/New_York', '02:30', '2026-03-06T12:00:00Z', '2026-03-09T12:00:00Z'),
    ['2026-03-07T07:30', '2026-03-08T07:00', '2026-03-09T06:30'],
  );
  // New York, 1 November 2026: 01:00 to 02:00 happens twice. 01:30 comes due the first time only.
  assert.deepEqual(
    dueMoments('America/New_York', '01:30', '2026-10-30T12:00:00Z', '2026-11-02T12:00:00Z'),
    ['2026-10-31T05:30', '2026-11-01T05:30', '2026-11-02T06:30'],
  );
  // Lord Howe Island shifts by half an hour: 02:00 to 02:30 is skipped on 4 October, 01:30 to 02:00 repeats on 5 April.
  assert.deepEqual(
    dueMoments('Australia/Lord_Howe', '02:15', '2026-10-02T00:00:00Z', '2026-10-05T00:00:00Z'),
    ['2026-10-02T15:45', '2026-10-03T15:30', '2026-10-04T15:15'],
  );
  assert.deepEqual(
    dueMoments('Australia/Lord_Howe', '01:45', '2026-04-03T00:00:00Z', '2026-04-06T00:00:00Z'),
    ['2026-04-03T14:45', '2026-04-04T14:45', '2026-04-05T15:15'],
  );
  // Midnight is the start of the day it names, not the end of the one before.
  assert.equal(latestSlot(wallClockAt(new Date('2026-06-02T00:00:00Z'), 'UTC'), '00:00'), '2026-06-02');
  assert.equal(latestSlot(wallClockAt(new Date('2026-06-01T23:59:00Z'), 'UTC'), '00:00'), '2026-06-01');
  assert.equal(latestSlot(wallClockAt(new Date('2026-03-01T03:00:00Z'), 'UTC'), '04:00'), '2026-02-28');
});

test('the scheduler makes one backup on the day the clock repeats the scheduled time, and one on the day it skips it', async () => {
  const { id } = await setup();
  const s = await scheduling('America/New_York');

  s.enable(id, '01:30', '2026-10-31T12:00:00Z');
  await s.checkAt('2026-11-01T05:29:00Z');
  assert.equal(s.scheduled(id).length, 0);
  await s.checkAt('2026-11-01T05:30:00Z');
  assert.equal(s.scheduled(id).length, 1, '第一次到 01:30 时备份');
  // Had the server not run, the second 01:30 would be skipped anyway and prove nothing.
  s.serverRan(id);
  await s.checkAt('2026-11-01T06:00:00Z');
  await s.checkAt('2026-11-01T06:30:00Z');
  await s.checkAt('2026-11-01T07:00:00Z');
  assert.equal(s.scheduled(id).length, 1, '时钟拨回后再次到 01:30 时不重复备份');
  await s.checkAt('2026-11-02T06:30:00Z');
  assert.equal(s.scheduled(id).length, 2);

  s.serverRan(id);
  s.enable(id, '02:30', '2027-03-13T12:00:00Z');
  await s.checkAt('2027-03-14T06:59:00Z');
  assert.equal(s.scheduled(id).length, 2);
  await s.checkAt('2027-03-14T07:00:00Z');
  assert.equal(s.scheduled(id).length, 3, '02:30 不存在的那天，在时钟跳到 03:00 时备份');
  s.serverRan(id);
  await s.checkAt('2027-03-14T12:00:00Z');
  assert.equal(s.scheduled(id).length, 3);
});

test('with nothing injected but the clock, the scheduler reads the time zone and the free disk space of this machine', async () => {
  const { id } = await setup();
  const { createBackupScheduler, saveBackupSchedule } = await import('./backup-schedule-service.js');
  const { listBackups, startBackupTask } = await import('./backup-service.js');
  // Starts from an empty table, like the other cases; the scheduler used here is this case's own.
  await scheduling();
  // An earlier backup makes the free-space check run for real, against the disk that holds the test data.
  const manual = await waitForTask(await startBackupTask(id));
  assert.equal(manual.status, 'completed', manual.error);

  let now = new Date('2026-06-01T10:00:00Z');
  const scheduler = createBackupScheduler({ now: () => now });
  saveBackupSchedule(id, { enabled: true, time: '04:00', keep: 7 }, { now });
  scheduler.start();
  try {
    await scheduler.check();
    await waitForIdleQueue();
    assert.equal(listBackups(id).length, 1, '保存时不立即备份');
    // Whatever the time zone, 04:00 has come round by 25 hours later, and slots that went by together make one backup.
    now = new Date('2026-06-02T11:00:00Z');
    await scheduler.check();
    await waitForIdleQueue();
  } finally {
    scheduler.stop();
  }
  const scheduled = listBackups(id).filter((backup) => backup.source === 'scheduled');
  assert.equal(scheduled.length, 1);
});
