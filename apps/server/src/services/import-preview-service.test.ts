import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-import-preview-test-'));
process.env.MYSTRY_DATA_DIR = dataRoot;
process.env.JWT_SECRET = 'a'.repeat(64);
process.env.SETUP_TOKEN = 'b'.repeat(64);
process.env.LAUNCHER_TOKEN = 'c'.repeat(64);
process.env.MAX_IMPORT_PREVIEWS = '2';

type StoredZipEntry = { name: string; contents: string };

function createStoredZip(entries: readonly StoredZipEntry[]): Buffer {
  const localEntries: Buffer[] = [];
  const centralEntries: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const contents = Buffer.from(entry.contents, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(contents.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(contents.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    localEntries.push(local, name, contents);
    centralEntries.push(central, name);
    localOffset += local.length + name.length + contents.length;
  }
  const centralSize = centralEntries.reduce((total, entry) => total + entry.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localEntries, ...centralEntries, end]);
}

function writePreviewZip(suffix: string): string {
  const uploadDir = path.join(dataRoot, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  const target = path.join(uploadDir, `.tmp-import-preview-${suffix}`);
  fs.writeFileSync(target, createStoredZip([
    { name: 'server.jar', contents: 'server-jar' },
    { name: 'user_jvm_args.txt', contents: '# 参数\n-Xms1G\n-Xmx2G\n' },
  ]));
  return target;
}

test('ZIP import preview enforces the owner, capacity, expiry, restart and confirm lifecycle', async (t) => {
  const { initDb, closeDb } = await import('../db.js');
  const previewService = await import('./import-preview-service.js');
  const taskService = await import('./task-service.js');
  initDb();
  previewService.initializeImportPreviews();
  t.after(async () => {
    previewService.shutdownImportPreviews();
    await taskService.shutdownTasks();
    closeDb();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  await t.test('invisible to non-owners, and cancel deletes the temp ZIP', async () => {
    const zipPath = writePreviewZip('owner.zip');
    const preview = await previewService.createImportPreview({ userId: 'owner', fileName: 'owner.zip', zipPath });
    assert.equal(previewService.getImportPreview(preview.id, 'owner').id, preview.id);
    assert.throws(
      () => previewService.getImportPreview(preview.id, 'other'),
      (error: unknown) => error instanceof previewService.ImportPreviewHttpError && error.statusCode === 404,
    );
    previewService.cancelImportPreview(preview.id, 'owner');
    assert.equal(fs.existsSync(zipPath), false);
  });

  await t.test('a new preview from the same user replaces the old one only after it succeeds', async () => {
    const oldPath = writePreviewZip('old.zip');
    const oldPreview = await previewService.createImportPreview({ userId: 'replace', fileName: 'old.zip', zipPath: oldPath });
    const newPath = writePreviewZip('new.zip');
    const newPreview = await previewService.createImportPreview({ userId: 'replace', fileName: 'new.zip', zipPath: newPath });
    assert.equal(fs.existsSync(oldPath), false);
    assert.throws(
      () => previewService.getImportPreview(oldPreview.id, 'replace'),
      (error: unknown) => error instanceof previewService.ImportPreviewHttpError
        && error.messageKey === 'server.imports.preview.notFound',
    );
    assert.equal(previewService.getImportPreview(newPreview.id, 'replace').fileName, 'new.zip');
    previewService.cancelImportPreview(newPreview.id, 'replace');
  });

  await t.test('beyond the global capacity the new upload is kept for the route to clean up', async () => {
    const first = await previewService.createImportPreview({ userId: 'cap-a', fileName: 'a.zip', zipPath: writePreviewZip('cap-a.zip') });
    const second = await previewService.createImportPreview({ userId: 'cap-b', fileName: 'b.zip', zipPath: writePreviewZip('cap-b.zip') });
    const rejectedPath = writePreviewZip('cap-c.zip');
    await assert.rejects(
      () => previewService.createImportPreview({ userId: 'cap-c', fileName: 'c.zip', zipPath: rejectedPath }),
      (error: unknown) => error instanceof previewService.ImportPreviewHttpError && error.statusCode === 429,
    );
    assert.equal(fs.existsSync(rejectedPath), true);
    fs.rmSync(rejectedPath, { force: true });
    previewService.cancelImportPreview(first.id, 'cap-a');
    previewService.cancelImportPreview(second.id, 'cap-b');
  });

  await t.test('expiry returns 410 and deletes the ZIP', async () => {
    const zipPath = writePreviewZip('expired.zip');
    const preview = await previewService.createImportPreview({
      userId: 'expired',
      fileName: 'expired.zip',
      zipPath,
      now: 1_000,
    });
    assert.throws(
      () => previewService.getImportPreview(preview.id, 'expired', Date.parse(preview.expiresAt) + 1),
      (error: unknown) => error instanceof previewService.ImportPreviewHttpError && error.statusCode === 410,
    );
    assert.equal(fs.existsSync(zipPath), false);
  });

  await t.test('restart initialization cleans up orphan files with the dedicated prefix', () => {
    const orphan = writePreviewZip('orphan.zip');
    const result = previewService.initializeImportPreviews();
    assert.equal(result.purged, 1);
    assert.equal(fs.existsSync(orphan), false);
  });

  await t.test('queued only once after confirming, and a repeated confirm returns 409', async () => {
    const preview = await previewService.createImportPreview({
      userId: 'confirm',
      fileName: 'confirm.zip',
      zipPath: writePreviewZip('confirm.zip'),
    });
    const task = await previewService.confirmImportPreview(preview.id, 'confirm', {
      name: '确认导入',
      coreType: 'custom',
      jvmArgs: '-Xms1G -Xmx2G',
      acceptEula: true,
      javaRuntimeId: null,
    });
    await assert.rejects(
      () => previewService.confirmImportPreview(preview.id, 'confirm', { name: '重复确认' }),
      (error: unknown) => error instanceof previewService.ImportPreviewHttpError && error.statusCode === 409,
    );
    let completed = taskService.getTask(task.id);
    for (let attempt = 0; attempt < 200 && !['completed', 'failed'].includes(completed?.status ?? ''); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      completed = taskService.getTask(task.id);
    }
    assert.equal(completed?.status, 'completed', completed?.error);
  });

  await t.test('a package that agreed in its own eula.txt keeps that agreement without being asked again', async () => {
    const plain = await previewService.createImportPreview({
      userId: 'eula',
      fileName: 'plain.zip',
      zipPath: writePreviewZip('plain.zip'),
    });
    assert.equal(plain.eulaAccepted, undefined);

    const eulaText = '#By changing the setting below to TRUE you are indicating your agreement to our EULA.\n#Sun Nov 22 18:59:15 GMT+08:00 2026\neula=true\n';
    const zipPath = path.join(dataRoot, 'uploads', '.tmp-import-preview-eula.zip');
    fs.writeFileSync(zipPath, createStoredZip([
      { name: 'My Server/server.jar', contents: 'server-jar' },
      { name: 'My Server/eula.txt', contents: eulaText },
    ]));
    const preview = await previewService.createImportPreview({ userId: 'eula', fileName: 'eula.zip', zipPath });
    assert.equal(preview.eulaAccepted, true);

    const task = await previewService.confirmImportPreview(preview.id, 'eula', { name: '自带 EULA', coreType: 'custom' });
    let completed = taskService.getTask(task.id);
    for (let attempt = 0; attempt < 200 && !['completed', 'failed'].includes(completed?.status ?? ''); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      completed = taskService.getTask(task.id);
    }
    assert.equal(completed?.status, 'completed', completed?.error);
    const instanceId = completed?.result?.instanceId as string;
    const { getInstance } = await import('./instance-service.js');
    const { defaultInstanceDir } = await import('../utils/path.js');
    assert.equal(getInstance(instanceId)?.acceptEula, true);
    // Importing does not rewrite the server's own file.
    assert.equal(fs.readFileSync(path.join(defaultInstanceDir(instanceId), 'eula.txt'), 'utf8'), eulaText);
  });

  await t.test('the preview is not consumed when the task queue is full', async () => {
    const preview = await previewService.createImportPreview({
      userId: 'queue-full',
      fileName: 'queue-full.zip',
      zipPath: writePreviewZip('queue-full.zip'),
    });
    const waitForAbort = async (_taskId: string, signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
      const rejectWithReason = () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      if (signal.aborted) rejectWithReason();
      else signal.addEventListener('abort', rejectWithReason, { once: true });
    });
    await taskService.runBackgroundTask('download', { key: 'server.tasks.queued' }, waitForAbort);
    await taskService.runBackgroundTask('download', { key: 'server.tasks.queued' }, waitForAbort);
    await taskService.runBackgroundTask('download', { key: 'server.tasks.queued' }, waitForAbort);
    await assert.rejects(
      () => previewService.confirmImportPreview(preview.id, 'queue-full', { name: '队列满重试' }),
      (error: unknown) => error instanceof taskService.TaskCapacityError,
    );
    assert.equal(previewService.getImportPreview(preview.id, 'queue-full').id, preview.id);
    await taskService.shutdownTasks();
  });
});
