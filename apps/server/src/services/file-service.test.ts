/**
 * R0-05 文件重命名与路径安全回归骨架（批次 C 实现无覆盖 rename）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

function prepareTempDataRoot(t: test.TestContext): string {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-file-service-test-'));
  t.after(async () => {
    try {
      const { closeDb } = await import('../db.js');
      closeDb();
    } catch {
      /* 模块可能尚未加载 */
    }
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });
  process.env.MYSTRY_DATA_DIR = dataRoot;
  process.env.JWT_SECRET = 'a'.repeat(64);
  process.env.SETUP_TOKEN = 'b'.repeat(64);
  return dataRoot;
}

test('R0-05: 目标已存在时同目录重命名应拒绝且不覆盖内容', async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { createInstance } = await import('./instance-service.js');
  const { renamePath } = await import('./file-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const inst = createInstance({ name: 'rename-conflict' });
  const root = defaultInstanceDir(inst.id);
  fs.writeFileSync(path.join(root, 'a.txt'), 'source-a');
  fs.writeFileSync(path.join(root, 'b.txt'), 'keep-b');

  assert.throws(
    () => renamePath(inst.id, 'a.txt', 'b.txt'),
    (err: unknown) => err instanceof Error && /已存在|冲突|目标/.test(err.message),
    'R0-05 待批次 C：renamePath 不得静默覆盖已有 b.txt',
  );
  assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'keep-b');
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'source-a');
});

test('R0-05: 重命名冲突应对外映射为 HTTP 409', async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { createInstance } = await import('./instance-service.js');
  const { renamePath, fileServiceErrorHttpStatus, FileRenameConflictError } = await import('./file-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const inst = createInstance({ name: 'rename-http' });
  const root = defaultInstanceDir(inst.id);
  fs.writeFileSync(path.join(root, 'a.txt'), 'a');
  fs.writeFileSync(path.join(root, 'b.txt'), 'b');

  try {
    renamePath(inst.id, 'a.txt', 'b.txt');
    assert.fail('应抛出重命名冲突');
  } catch (err) {
    assert.ok(err instanceof FileRenameConflictError);
    assert.equal(fileServiceErrorHttpStatus(err), 409);
  }
});

test('目录列表目录优先并按自然序排序，大目录不逐项重复校验整条路径', async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { createInstance } = await import('./instance-service.js');
  const { listFiles } = await import('./file-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const inst = createInstance({ name: 'list-files' });
  const root = defaultInstanceDir(inst.id);
  const region = path.join(root, 'world', 'region');
  fs.mkdirSync(path.join(region, 'nested'), { recursive: true });
  for (let index = 1; index <= 300; index += 1) {
    fs.writeFileSync(path.join(region, `r.${index}.mca`), 'x');
  }

  const realpath = t.mock.method(fs, 'realpathSync');
  const entries = listFiles(inst.id, 'world/region');
  assert.equal(entries.length, 301);
  assert.deepEqual(entries.slice(0, 3).map((entry) => entry.name), ['nested', 'r.1.mca', 'r.2.mca']);
  assert.equal(entries[0]?.isDirectory, true);
  assert.equal(entries[1]?.path, 'world/region/r.1.mca');
  assert.equal(entries.at(-1)?.name, 'r.300.mca');
  // 只校验目标目录本身的路径段，与条目数量无关。
  assert.ok(realpath.mock.callCount() < 10, `realpathSync 调用 ${realpath.mock.callCount()} 次`);
});

test('目录列表遇到 symlink/junction 条目时拒绝访问', async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { createInstance } = await import('./instance-service.js');
  const { listFiles } = await import('./file-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const inst = createInstance({ name: 'list-links' });
  const root = defaultInstanceDir(inst.id);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-list-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'plugins'));
  fs.symlinkSync(outside, path.join(root, 'plugins', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');

  assert.throws(() => listFiles(inst.id, 'plugins'), /symlink\/junction/);
});

test('上传覆盖重命名失败时应恢复旧文件且清理临时文件', async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { config } = await import('../config.js');
  const { createInstance } = await import('./instance-service.js');
  const { saveUploadedFile } = await import('./file-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const inst = createInstance({ name: 'upload-rollback' });
  const root = defaultInstanceDir(inst.id);
  const target = path.join(root, 'server.jar');
  fs.writeFileSync(target, 'old-content');
  let renameCalls = 0;

  await assert.rejects(
    () => saveUploadedFile(
      inst.id,
      '',
      'server.jar',
      Readable.from('new-content'),
      {
        renameSync(source, destination) {
          renameCalls += 1;
          if (renameCalls === 2) throw new Error('injected replacement failure');
          fs.renameSync(source, destination);
        },
      },
    ),
    /injected replacement failure/,
  );

  assert.equal(fs.readFileSync(target, 'utf8'), 'old-content');
  assert.equal(
    fs.readdirSync(root).some((entry) => entry.includes('.mystry-upload-backup-')),
    false,
  );
  assert.equal(
    fs.existsSync(config.uploadDir)
      && fs.readdirSync(config.uploadDir).some((entry) => entry.startsWith('.tmp-file-')),
    false,
  );
});

test('上传覆盖成功时应替换内容且不遗留备份文件', async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { config } = await import('../config.js');
  const { createInstance } = await import('./instance-service.js');
  const { saveUploadedFile } = await import('./file-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const inst = createInstance({ name: 'upload-replace' });
  const root = defaultInstanceDir(inst.id);
  const target = path.join(root, 'server.jar');
  fs.writeFileSync(target, 'old-content');

  await saveUploadedFile(inst.id, '', 'server.jar', Readable.from('new-content'));

  assert.equal(fs.readFileSync(target, 'utf8'), 'new-content');
  assert.equal(
    fs.readdirSync(root).some((entry) => entry.includes('.mystry-upload-backup-')),
    false,
  );
  assert.equal(
    fs.existsSync(config.uploadDir)
      && fs.readdirSync(config.uploadDir).some((entry) => entry.startsWith('.tmp-file-')),
    false,
  );
});

test('上传覆盖后备份清理失败仍应返回成功并保留可识别备份', async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { createInstance } = await import('./instance-service.js');
  const { saveUploadedFile } = await import('./file-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const inst = createInstance({ name: 'upload-backup-cleanup' });
  const root = defaultInstanceDir(inst.id);
  const target = path.join(root, 'server.jar');
  fs.writeFileSync(target, 'old-content');
  let backupPath = '';
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => {
    warnings.push(args);
  });

  const saved = await saveUploadedFile(
    inst.id,
    '',
    'server.jar',
    Readable.from('new-content'),
    {
      unlinkSync(filePath) {
        backupPath = String(filePath);
        throw new Error('injected backup cleanup failure');
      },
    },
  );

  assert.equal(saved, 'server.jar');
  assert.equal(fs.readFileSync(target, 'utf8'), 'new-content');
  assert.ok(backupPath.includes('.mystry-upload-backup-'));
  assert.equal(fs.readFileSync(backupPath, 'utf8'), 'old-content');
  assert.match(String(warnings[0]?.[0]), /上传已完成，但无法删除旧文件备份/);
});
