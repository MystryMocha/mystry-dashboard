/**
 * Backup endpoint regression: authentication, create, list, ticket download, upload, restore parameter validation, delete, and rejecting file changes during a restore.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { BackupInfo, BackupListResult, FileDownloadTicketResult, TaskInfo } from '@mystry/shared';

process.env.JWT_SECRET = 'a'.repeat(64);
process.env.SETUP_TOKEN = 'b'.repeat(64);
process.env.LAUNCHER_TOKEN = 'c'.repeat(64);

function multipart(filename: string, contents: Buffer) {
  const boundary = 'mystry-backup-route-test-boundary';
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/gzip\r\n\r\n`),
      contents,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

test('备份接口完整流程', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-backup-routes-test-'));
  process.env.MYSTRY_DATA_DIR = dataRoot;
  const { buildApp } = await import('../index.js');
  const { getTask } = await import('../services/task-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');
  const { processManager } = await import('../services/process-manager.js');
  const app = await buildApp({ skipDataLock: true });
  t.after(async () => {
    await app.close();
    const { closeDb } = await import('../db.js');
    closeDb();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { 'x-setup-token': 'b'.repeat(64) },
    payload: { username: 'admin12', password: 'password1234' },
  });
  assert.equal(setup.statusCode, 200);
  const authorization = { authorization: `Bearer ${setup.json<{ token: string }>().token}` };

  const created = await app.inject({ method: 'POST', url: '/api/instances', headers: authorization, payload: { name: 'backup-routes' } });
  assert.equal(created.statusCode, 200);
  const id = created.json<{ id: string }>().id;
  fs.writeFileSync(path.join(defaultInstanceDir(id), 'server.properties'), 'motd=routes\n');

  const unauthenticated = await app.inject({ method: 'GET', url: `/api/instances/${id}/backups` });
  assert.equal(unauthenticated.statusCode, 401);
  const unknownInstance = await app.inject({ method: 'GET', url: '/api/instances/doesnotexist/backups', headers: authorization });
  assert.equal(unknownInstance.statusCode, 404);

  const started = await app.inject({ method: 'POST', url: `/api/instances/${id}/backups`, headers: authorization });
  assert.equal(started.statusCode, 200);
  let task = started.json<TaskInfo>();
  assert.equal(task.type, 'backup');
  for (let attempt = 0; attempt < 500 && task.status !== 'completed' && task.status !== 'failed'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    task = getTask(task.id)!;
  }
  assert.equal(task.status, 'completed', task.error);

  const list = await app.inject({ method: 'GET', url: `/api/instances/${id}/backups`, headers: authorization });
  const [backup] = list.json<BackupListResult>().backups;
  assert.ok(backup);
  assert.equal(backup.id, task.result?.backupId);

  // Download: a ticket can only be used for the backup it was issued for, and only once.
  const ticketResponse = await app.inject({
    method: 'POST',
    url: `/api/instances/${id}/backups/${backup.id}/download-ticket`,
    headers: authorization,
  });
  assert.equal(ticketResponse.statusCode, 200);
  const { ticket } = ticketResponse.json<FileDownloadTicketResult>();
  const download = await app.inject({
    method: 'GET',
    url: `/api/instances/${id}/backups/${backup.id}/download?ticket=${encodeURIComponent(ticket)}`,
  });
  assert.equal(download.statusCode, 200);
  assert.match(String(download.headers['content-disposition']), /backup-routes-.+\.tar\.gz/);
  assert.equal(download.rawPayload.length, backup.sizeBytes);
  const replay = await app.inject({
    method: 'GET',
    url: `/api/instances/${id}/backups/${backup.id}/download?ticket=${encodeURIComponent(ticket)}`,
  });
  assert.equal(replay.statusCode, 401);
  const noTicket = await app.inject({ method: 'GET', url: `/api/instances/${id}/backups/${backup.id}/download` });
  assert.equal(noTicket.statusCode, 401);

  const uploadBody = multipart('copy.tar.gz', download.rawPayload);
  const uploaded = await app.inject({
    method: 'POST',
    url: `/api/instances/${id}/backups/upload`,
    headers: { ...authorization, 'content-type': uploadBody.contentType },
    payload: uploadBody.payload,
  });
  assert.equal(uploaded.statusCode, 200, uploaded.body);
  assert.equal(uploaded.json<BackupInfo>().source, 'upload');
  const brokenBody = multipart('broken.tar.gz', Buffer.from('broken'));
  const broken = await app.inject({
    method: 'POST',
    url: `/api/instances/${id}/backups/upload`,
    headers: { ...authorization, 'content-type': brokenBody.contentType },
    payload: brokenBody.payload,
  });
  assert.equal(broken.statusCode, 400);
  assert.equal(broken.json<{ code: string }>().code, 'server.backups.archive.corrupted');

  const badRestore = await app.inject({
    method: 'POST',
    url: `/api/instances/${id}/backups/${backup.id}/restore`,
    headers: authorization,
    payload: { backupCurrent: true, overwrite: 'yes' },
  });
  assert.equal(badRestore.statusCode, 400);
  const badId = await app.inject({
    method: 'POST',
    url: `/api/instances/${id}/backups/..%2F..%2Fetc/restore`,
    headers: authorization,
    payload: { backupCurrent: false },
  });
  assert.equal(badId.statusCode, 400);

  const release = processManager.beginMaintenance(id, 'server.backups.busyRestoring');
  try {
    const write = await app.inject({
      method: 'PUT',
      url: `/api/instances/${id}/files/content`,
      headers: authorization,
      payload: { path: 'server.properties', content: 'motd=changed\n' },
    });
    assert.equal(write.statusCode, 409);
    const start = await app.inject({ method: 'POST', url: `/api/instances/${id}/start`, headers: authorization });
    assert.equal(start.statusCode, 409);
  } finally {
    release();
  }

  const removed = await app.inject({ method: 'DELETE', url: `/api/instances/${id}/backups/${backup.id}`, headers: authorization });
  assert.equal(removed.statusCode, 204);
  const missing = await app.inject({ method: 'DELETE', url: `/api/instances/${id}/backups/${backup.id}`, headers: authorization });
  assert.equal(missing.statusCode, 404);

  // Deleting an instance: the backup directory is deleted with it by default, and kept when keepBackups=1.
  const { backupRoot } = await import('../services/backup-service.js');
  async function instanceWithBackup(name: string): Promise<string> {
    const response = await app.inject({ method: 'POST', url: '/api/instances', headers: authorization, payload: { name } });
    const instanceId = response.json<{ id: string }>().id;
    let backupTask = (await app.inject({ method: 'POST', url: `/api/instances/${instanceId}/backups`, headers: authorization })).json<TaskInfo>();
    for (let attempt = 0; attempt < 500 && backupTask.status !== 'completed' && backupTask.status !== 'failed'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      backupTask = getTask(backupTask.id)!;
    }
    assert.equal(backupTask.status, 'completed', backupTask.error);
    return instanceId;
  }
  const dropped = await instanceWithBackup('drop-backups');
  assert.ok(fs.existsSync(path.join(backupRoot(), dropped)));
  const deleteDropped = await app.inject({ method: 'DELETE', url: `/api/instances/${dropped}`, headers: authorization });
  assert.equal(deleteDropped.statusCode, 200, deleteDropped.body);
  assert.equal(fs.existsSync(path.join(backupRoot(), dropped)), false);

  const kept = await instanceWithBackup('keep-backups');
  const deleteKept = await app.inject({ method: 'DELETE', url: `/api/instances/${kept}?keepBackups=1`, headers: authorization });
  assert.equal(deleteKept.statusCode, 200, deleteKept.body);
  assert.equal(fs.readdirSync(path.join(backupRoot(), kept)).some((name) => name.endsWith('.tar.gz')), true);
});
