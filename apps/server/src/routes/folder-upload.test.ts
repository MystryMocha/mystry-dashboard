/**
 * Browser folder upload endpoint regression: authentication, quotas, relative path validation, batched receiving, precheck, confirming the import (the whole folder is moved into the instance directory),
 * cancel, and cleaning up leftover temp directories at startup.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { FolderUploadInfo, TaskInfo } from '@mystry/shared';

process.env.JWT_SECRET = 'a'.repeat(64);
process.env.SETUP_TOKEN = 'b'.repeat(64);
process.env.LAUNCHER_TOKEN = 'c'.repeat(64);
process.env.MAX_EXISTING_IMPORT_ENTRIES = '20';
process.env.MAX_EXISTING_IMPORT_BYTES = String(1024 * 1024);

type Part = { path: string; content: string | Buffer } | { rawField: string; value: string } | { rawFile: string; content: string };

/** Builds multipart the way browser FormData does: a path field comes before each file. */
function multipart(parts: Part[]) {
  const boundary = 'mystry-folder-upload-test-boundary';
  const chunks: Buffer[] = [];
  const field = (name: string, value: string) => {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  };
  const file = (content: string | Buffer) => {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="blob"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    chunks.push(Buffer.isBuffer(content) ? content : Buffer.from(content));
    chunks.push(Buffer.from('\r\n'));
  };
  for (const part of parts) {
    if ('rawField' in part) field(part.rawField, part.value);
    else if ('rawFile' in part) file(part.content);
    else {
      field('path', part.path);
      file(part.content);
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { contentType: `multipart/form-data; boundary=${boundary}`, payload: Buffer.concat(chunks) };
}

test('browser folder upload endpoints', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-folder-upload-test-'));
  process.env.MYSTRY_DATA_DIR = dataRoot;
  // An upload temp directory left by the previous process: it should be cleaned up at startup.
  // The directory is created with the permissions the panel itself uses (700): on Linux the default 755 would be rejected by the data directory permission check at startup.
  const orphan = path.join(dataRoot, 'uploads', '.tmp-folder-upload-orphan');
  fs.mkdirSync(path.join(orphan, 'world'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(orphan, 'world', 'level.dat'), 'old');

  const { buildApp } = await import('../index.js');
  const { getTask } = await import('../services/task-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');
  const { normalizeUploadRelativePath } = await import('../services/folder-upload-service.js');
  const app = await buildApp({ skipDataLock: true });
  t.after(async () => {
    await app.close();
    const { closeDb } = await import('../db.js');
    closeDb();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  assert.equal(fs.existsSync(orphan), false, '启动时清理上次遗留的上传临时目录');

  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { 'x-setup-token': 'b'.repeat(64) },
    payload: { username: 'admin12', password: 'password1234' },
  });
  assert.equal(setup.statusCode, 200);
  const authorization = { authorization: `Bearer ${setup.json<{ token: string }>().token}` };
  const uploadDirs = () => fs.readdirSync(path.join(dataRoot, 'uploads')).filter((name) => name.startsWith('.tmp-folder-upload-'));

  const create = (body: Record<string, unknown>) => app.inject({
    method: 'POST', url: '/api/import/folder-uploads', headers: authorization, payload: body,
  });
  const sendBatch = (id: string, parts: Part[]) => {
    const body = multipart(parts);
    return app.inject({
      method: 'POST',
      url: `/api/import/folder-uploads/${id}/files`,
      headers: { ...authorization, 'content-type': body.contentType },
      payload: body.payload,
    });
  };
  const get = (id: string) => app.inject({ method: 'GET', url: `/api/import/folder-uploads/${id}`, headers: authorization });

  await t.test('an upload cannot start without signing in', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/import/folder-uploads', payload: { folderName: 'x', fileCount: 1, totalBytes: 1 },
    });
    assert.equal(response.statusCode, 401);
  });

  await t.test('parameters and quotas are checked when an upload starts', async () => {
    assert.equal((await create({ folderName: 'x', fileCount: 0, totalBytes: 1 })).statusCode, 400);
    assert.equal((await create({ folderName: 'a/b', fileCount: 1, totalBytes: 1 })).statusCode, 400);
    assert.equal((await create({ folderName: 'x', fileCount: 1, totalBytes: 1, path: 'C:/' })).statusCode, 400);
    const tooMany = await create({ folderName: 'x', fileCount: 21, totalBytes: 1 });
    assert.equal(tooMany.statusCode, 413);
    assert.equal(tooMany.json<{ code: string }>().code, 'server.imports.folder.tooManyFiles');
    const tooLarge = await create({ folderName: 'x', fileCount: 1, totalBytes: 1024 * 1024 + 1 });
    assert.equal(tooLarge.statusCode, 413);
    assert.equal(tooLarge.json<{ code: string }>().code, 'server.imports.folder.tooLarge');
    assert.deepEqual(uploadDirs(), []);
  });

  await t.test('relative paths are accepted only in the ordinary form', () => {
    assert.equal(normalizeUploadRelativePath('world/region/r.0.0.mca'), 'world/region/r.0.0.mca');
    for (const bad of ['', '/etc/passwd', '../evil.txt', 'a/../b', 'a//b', 'a/./b', 'a\\b', 'a\u0000b', 'x/'.repeat(70) + 'y']) {
      assert.throws(() => normalizeUploadRelativePath(bad), (error: { messageKey?: string }) => error.messageKey === 'server.imports.folder.invalidPath', bad);
    }
    for (const reserved of ['.mystry-instance.json', '.MYSTRY-STAGING-MARKER.json']) {
      assert.throws(() => normalizeUploadRelativePath(reserved), (error: { messageKey?: string }) => error.messageKey === 'server.imports.folder.reservedName');
    }
    // Only reserved names in the root collide with panel files; the same name inside a subdirectory does not matter.
    assert.equal(normalizeUploadRelativePath('config/.mystry-instance.json'), 'config/.mystry-instance.json');
    if (process.platform === 'win32') {
      for (const bad of ['con.txt', 'world/aux', 'a:b', 'trailing.', 'space ']) {
        assert.throws(() => normalizeUploadRelativePath(bad), bad);
      }
    }
  });

  await t.test('batched upload, precheck, and after confirming the whole folder becomes an instance', async () => {
    const files = {
      'server.jar': 'fake jar',
      'user_jvm_args.txt': '-Xms2G -Xmx4G\n',
      'world/level.dat': 'level',
    };
    const totalBytes = Object.values(files).reduce((sum, content) => sum + Buffer.byteLength(content), 0);
    const created = await create({ folderName: 'my server', fileCount: 3, totalBytes });
    assert.equal(created.statusCode, 200, created.body);
    const upload = created.json<FolderUploadInfo>();
    assert.equal(upload.state, 'uploading');
    assert.equal(upload.folderName, 'my server');

    const first = await sendBatch(upload.id, [
      { path: 'server.jar', content: files['server.jar'] },
      { path: 'user_jvm_args.txt', content: files['user_jvm_args.txt'] },
    ]);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json<FolderUploadInfo>().receivedFiles, 2);

    const early = await app.inject({ method: 'POST', url: `/api/import/folder-uploads/${upload.id}/complete`, headers: authorization });
    assert.equal(early.statusCode, 409);
    assert.equal(early.json<{ code: string }>().code, 'server.imports.folder.incomplete');

    const second = await sendBatch(upload.id, [{ path: 'world/level.dat', content: files['world/level.dat'] }]);
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json<FolderUploadInfo>().receivedBytes, totalBytes);

    const completed = await app.inject({ method: 'POST', url: `/api/import/folder-uploads/${upload.id}/complete`, headers: authorization });
    assert.equal(completed.statusCode, 200, completed.body);
    const ready = completed.json<FolderUploadInfo>();
    assert.equal(ready.state, 'ready');
    assert.equal(ready.check?.ready, true);
    assert.equal(ready.check?.launchTarget, 'server.jar');
    assert.equal(ready.check?.detectedJvmConfig?.canonicalArgs?.includes('-Xmx4G'), true);
    assert.equal((await get(upload.id)).json<FolderUploadInfo>().state, 'ready');

    const confirmed = await app.inject({
      method: 'POST',
      url: `/api/import/folder-uploads/${upload.id}/confirm`,
      headers: authorization,
      payload: { name: '  上传的服务器  ', jvmArgs: '-Xms1G -Xmx2G', acceptEula: true },
    });
    assert.equal(confirmed.statusCode, 200, confirmed.body);
    let task = confirmed.json<TaskInfo>();
    for (let attempt = 0; attempt < 500 && task.status !== 'completed' && task.status !== 'failed'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      task = getTask(task.id)!;
    }
    assert.equal(task.status, 'completed', task.error);
    const instanceId = task.result?.instanceId as string;
    const instanceDir = defaultInstanceDir(instanceId);
    assert.equal(fs.readFileSync(path.join(instanceDir, 'server.jar'), 'utf8'), 'fake jar');
    assert.equal(fs.readFileSync(path.join(instanceDir, 'world', 'level.dat'), 'utf8'), 'level');
    assert.equal(fs.readFileSync(path.join(instanceDir, 'eula.txt'), 'utf8'), 'eula=true\n');
    assert.equal(fs.existsSync(path.join(instanceDir, '.mystry-staging-marker.json')), false);
    assert.deepEqual(uploadDirs(), [], '搬进实例后不留上传临时目录');
    assert.equal(fs.existsSync(path.join(dataRoot, '.mystry-staging', task.id)), false);

    const instance = await app.inject({ method: 'GET', url: `/api/instances/${instanceId}`, headers: authorization });
    assert.equal(instance.statusCode, 200);
    assert.equal(instance.json<{ name: string; jarFile: string }>().name, '上传的服务器');
    assert.equal(instance.json<{ jarFile: string }>().jarFile, 'server.jar');

    // The session has been handed to the task: confirming or querying again both return 404.
    assert.equal((await get(upload.id)).statusCode, 404);
  });

  await t.test('the whole upload is voided on a bad path, a duplicate, a missing path or exceeding what was declared', async () => {
    const cases: Array<{ parts: Part[]; code: string }> = [
      { parts: [{ path: '../evil.txt', content: 'x' }], code: 'server.imports.folder.invalidPath' },
      { parts: [{ path: '.mystry-instance.json', content: 'x' }], code: 'server.imports.folder.reservedName' },
      { parts: [{ path: 'a.txt', content: 'x' }, { path: 'a.txt', content: 'y' }], code: 'server.imports.folder.duplicatePath' },
      { parts: [{ path: 'a', content: 'x' }, { path: 'a/b.txt', content: 'y' }], code: 'server.imports.folder.duplicatePath' },
      { parts: [{ rawFile: 'blob', content: 'x' }], code: 'server.imports.folder.missingPath' },
      { parts: [{ rawField: 'other', value: 'a.txt' }, { rawFile: 'blob', content: 'x' }], code: 'server.imports.folder.missingPath' },
      { parts: [{ path: 'big.bin', content: 'x'.repeat(11) }], code: 'server.imports.folder.moreThanDeclared' },
      { parts: [{ path: 'a.txt', content: 'x' }, { path: 'b.txt', content: 'x' }, { path: 'c.txt', content: 'x' }], code: 'server.imports.folder.moreThanDeclared' },
    ];
    for (const { parts, code } of cases) {
      const created = await create({ folderName: 'bad', fileCount: 2, totalBytes: 10 });
      assert.equal(created.statusCode, 200, created.body);
      const { id } = created.json<FolderUploadInfo>();
      const response = await sendBatch(id, parts);
      assert.equal(response.statusCode, 400, `${code}: ${response.body}`);
      assert.equal(response.json<{ code: string }>().code, code);
      assert.equal((await get(id)).statusCode, 404, `${code} 后会话作废`);
      assert.deepEqual(uploadDirs(), [], `${code} 后删掉临时目录`);
    }
    assert.equal(fs.existsSync(path.join(dataRoot, 'evil.txt')), false);
    assert.equal(fs.existsSync(path.join(dataRoot, 'uploads', 'evil.txt')), false);
  });

  await t.test('a folder without a launch file can be prechecked but not confirmed', async () => {
    const created = await create({ folderName: 'no-jar', fileCount: 1, totalBytes: 5 });
    const { id } = created.json<FolderUploadInfo>();
    assert.equal((await sendBatch(id, [{ path: 'world/level.dat', content: 'level' }])).statusCode, 200);
    const completed = await app.inject({ method: 'POST', url: `/api/import/folder-uploads/${id}/complete`, headers: authorization });
    assert.equal(completed.statusCode, 200);
    assert.equal(completed.json<FolderUploadInfo>().check?.ready, false);
    assert.equal(completed.json<FolderUploadInfo>().check?.errorI18n?.key, 'server.imports.existing.noLaunchTarget');
    const confirmed = await app.inject({
      method: 'POST', url: `/api/import/folder-uploads/${id}/confirm`, headers: authorization, payload: { name: 'x' },
    });
    assert.equal(confirmed.statusCode, 409);
    assert.equal(confirmed.json<{ code: string }>().code, 'server.imports.folder.notReady');
  });

  await t.test('cancel deletes the temp directory; a newly started upload replaces the old one', async () => {
    const first = (await create({ folderName: 'one', fileCount: 1, totalBytes: 1 })).json<FolderUploadInfo>();
    assert.equal(uploadDirs().length, 1);
    const second = (await create({ folderName: 'two', fileCount: 1, totalBytes: 1 })).json<FolderUploadInfo>();
    assert.equal((await get(first.id)).statusCode, 404, '同一用户的新上传替换旧的');
    assert.equal(uploadDirs().length, 1);
    const cancelled = await app.inject({ method: 'DELETE', url: `/api/import/folder-uploads/${second.id}`, headers: authorization });
    assert.equal(cancelled.statusCode, 200);
    assert.equal((await get(second.id)).statusCode, 404);
    assert.deepEqual(uploadDirs(), []);
  });
});
