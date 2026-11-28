/**
 * File rename and path safety regression.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
      /* The module may not be loaded yet */
    }
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });
  process.env.MYSTRY_DATA_DIR = dataRoot;
  process.env.JWT_SECRET = 'a'.repeat(64);
  process.env.SETUP_TOKEN = 'b'.repeat(64);
  return dataRoot;
}

test('a rename within the same directory should be rejected without overwriting content when the target exists', async (t) => {
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
    (err: unknown) => err instanceof Error && (err as { messageKey?: string }).messageKey === 'server.files.rename.conflict',
    'renamePath 不得静默覆盖已有 b.txt',
  );
  assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'keep-b');
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'source-a');
});

test('a rename conflict should map to HTTP 409 externally', async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { createInstance } = await import('./instance-service.js');
  const { renamePath, FileRenameConflictError } = await import('./file-service.js');
  const { routeErrorStatus } = await import('../http-errors.js');
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
    assert.equal(routeErrorStatus(err), 409);
  }
});

test('the directory listing puts directories first in natural order, and large directories are not re-validated along the whole path per item', async (t) => {
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
  // Only the path segments of the target directory itself are validated, regardless of the number of entries.
  assert.ok(realpath.mock.callCount() < 10, `realpathSync 调用 ${realpath.mock.callCount()} 次`);
});

test('the directory listing does not show the ownership marker in the instance root, and files of the same name in subdirectories are listed as usual', async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { createInstance } = await import('./instance-service.js');
  const { listFiles } = await import('./file-service.js');
  const { defaultInstanceDir, OWNERSHIP_MARKER_FILE } = await import('../utils/path.js');

  initDb();
  const inst = createInstance({ name: 'hide-marker' });
  const root = defaultInstanceDir(inst.id);
  assert.ok(fs.existsSync(path.join(root, OWNERSHIP_MARKER_FILE)), '创建实例应写入所有权标记');
  fs.writeFileSync(path.join(root, 'server.properties'), 'motd=test\n');
  fs.mkdirSync(path.join(root, 'backup'));
  fs.writeFileSync(path.join(root, 'backup', OWNERSHIP_MARKER_FILE), '{}');

  assert.deepEqual(listFiles(inst.id).map((entry) => entry.name), ['backup', 'server.properties']);
  assert.deepEqual(listFiles(inst.id, 'backup').map((entry) => entry.path), [`backup/${OWNERSHIP_MARKER_FILE}`]);
});

test('the directory listing denies access on a symlink or directory junction', async (t) => {
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

  assert.throws(
    () => listFiles(inst.id, 'plugins'),
    (err: unknown) => (err as { messageKey?: string }).messageKey === 'server.files.dirContainsLink',
  );
});

const hasKey = (key: string) => (err: unknown) => (err as { messageKey?: string }).messageKey === key;

test('a path with a colon is refused on Windows, where it names a drive or an alternate data stream, and is an ordinary name elsewhere', async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { createInstance } = await import('./instance-service.js');
  const { listFiles, readTextFile } = await import('./file-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const inst = createInstance({ name: 'colon-paths' });
  const root = defaultInstanceDir(inst.id);
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data', 'level.dat'), 'level');

  if (process.platform === 'win32') {
    // On the root's own drive, `c:data` would otherwise resolve to `<root>\data` and list that folder.
    const sameDrive = `${path.parse(root).root.slice(0, 1).toLowerCase()}:data`;
    assert.throws(() => listFiles(inst.id, sameDrive), hasKey('server.files.path.outside'));
    assert.throws(() => readTextFile(inst.id, 'data/level.dat:hidden'), hasKey('server.files.path.outside'));
    assert.deepEqual(listFiles(inst.id, 'data').map((entry) => entry.name), ['level.dat']);
  } else {
    // A server brought over from another machine may have such a folder at the top level; it stays reachable from the list.
    fs.mkdirSync(path.join(root, 'c:data'));
    fs.writeFileSync(path.join(root, 'c:data', 'level.dat'), 'colon');
    const listed = listFiles(inst.id).find((entry) => entry.name === 'c:data');
    assert.ok(listed);
    assert.equal(listed.path, 'c:data');
    assert.deepEqual(listFiles(inst.id, listed.path).map((entry) => entry.name), ['level.dat']);
    assert.equal(readTextFile(inst.id, 'c:data/level.dat').content, 'colon');
  }
});

test('delete removes a file or a whole directory tree, and refuses the instance root, the ownership marker, missing paths and paths outside the instance', async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { createInstance } = await import('./instance-service.js');
  const { deletePath } = await import('./file-service.js');
  const { defaultInstanceDir, OWNERSHIP_MARKER_FILE } = await import('../utils/path.js');

  initDb();
  const inst = createInstance({ name: 'delete-semantics' });
  const root = defaultInstanceDir(inst.id);
  fs.mkdirSync(path.join(root, 'world', 'region'), { recursive: true });
  fs.writeFileSync(path.join(root, 'world', 'level.dat'), 'level');
  fs.writeFileSync(path.join(root, 'world', 'region', 'r.0.0.mca'), 'region');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'notes');
  fs.writeFileSync(path.join(root, 'server.jar'), 'jar');
  // Read-only entries and empty directories go like any other.
  fs.mkdirSync(path.join(root, 'world', 'datapacks'));
  fs.chmodSync(path.join(root, 'world', 'level.dat'), 0o444);
  if (process.platform === 'win32') execFileSync('attrib', ['+R', path.join(root, 'world', 'region')]);

  await deletePath(inst.id, 'notes.txt');
  assert.equal(fs.existsSync(path.join(root, 'notes.txt')), false);
  await deletePath(inst.id, 'world');
  assert.equal(fs.existsSync(path.join(root, 'world')), false);

  await assert.rejects(deletePath(inst.id, ''), hasKey('server.files.rootImmutable'));
  await assert.rejects(deletePath(inst.id, 'plugins/..'), hasKey('server.files.rootImmutable'));
  await assert.rejects(deletePath(inst.id, OWNERSHIP_MARKER_FILE), hasKey('server.files.markerImmutable'));
  await assert.rejects(deletePath(inst.id, 'missing.txt'), hasKey('server.files.pathNotFound'));
  await assert.rejects(deletePath(inst.id, '../outside.txt'), hasKey('server.files.path.outside'));
  assert.deepEqual(fs.readdirSync(root).sort(), [OWNERSHIP_MARKER_FILE, 'server.jar'].sort());
});

test('deleting a directory removes a symlink or directory junction inside it without touching what it points at', async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { createInstance } = await import('./instance-service.js');
  const { deletePath } = await import('./file-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const inst = createInstance({ name: 'delete-links' });
  const root = defaultInstanceDir(inst.id);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-delete-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  fs.mkdirSync(path.join(root, 'plugins'));
  fs.symlinkSync(outside, path.join(root, 'plugins', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');

  await deletePath(inst.id, 'plugins');

  assert.equal(fs.existsSync(path.join(root, 'plugins')), false);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
});

// Windows cannot create such names, so this runs on Linux only.
test('deleting a directory removes entries whose names are not valid UTF-8', { skip: process.platform !== 'linux' }, async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { createInstance } = await import('./instance-service.js');
  const { deletePath } = await import('./file-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const inst = createInstance({ name: 'delete-byte-names' });
  const plugins = path.join(defaultInstanceDir(inst.id), 'plugins');
  fs.mkdirSync(plugins);
  // "d\xFC" and "f\xE4.txt": Latin-1 bytes, as left by an archive that was packed on a system using another encoding.
  const dir = Buffer.concat([Buffer.from(`${plugins}/`), Buffer.from([0x64, 0xfc])]);
  fs.mkdirSync(dir);
  fs.writeFileSync(Buffer.concat([dir, Buffer.from('/'), Buffer.from([0x66, 0xe4, 0x2e, 0x74, 0x78, 0x74])]), 'x');

  await deletePath(inst.id, 'plugins');

  assert.equal(fs.existsSync(plugins), false);
});

test('a delete stops at the first entry it cannot remove, and nothing more is removed once it has failed', async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { createInstance } = await import('./instance-service.js');
  const { deletePath } = await import('./file-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const inst = createInstance({ name: 'delete-stops' });
  const world = path.join(defaultInstanceDir(inst.id), 'world');
  for (const dir of ['region', 'entities', 'poi']) {
    fs.mkdirSync(path.join(world, dir), { recursive: true });
    for (let index = 0; index < 5; index += 1) fs.writeFileSync(path.join(world, dir, `r.${index}.mca`), 'x');
  }
  const left = () => (fs.readdirSync(world, { recursive: true }) as string[]).sort();
  const filesLeft = () => left().filter((entry) => entry.endsWith('.mca')).length;

  // The seventh file is refused, as one held open by the running server would be. By then one directory is gone and the
  // removal is inside the next, with a third not yet reached; which is which depends on the order the file system lists them in.
  const originalUnlink = fs.promises.unlink.bind(fs.promises);
  let attempts = 0;
  t.mock.method(fs.promises, 'unlink', async (target: fs.PathLike) => {
    attempts += 1;
    if (attempts === 7) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    return originalUnlink(target);
  });

  await assert.rejects(deletePath(inst.id, 'world'), (err: unknown) => (err as { code?: string }).code === 'EBUSY');
  const atFailure = left();
  assert.equal(filesLeft(), 9, '失败前只应删掉 6 个文件');
  assert.equal(atFailure.length, 11, '应剩 2 个目录和 9 个文件');

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(attempts, 7, '失败之后不应再发起任何删除');
  assert.deepEqual(left(), atFailure);
});

test('the event loop keeps turning while a directory tree is being deleted', async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { createInstance } = await import('./instance-service.js');
  const { deletePath } = await import('./file-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const inst = createInstance({ name: 'delete-nonblocking' });
  const region = path.join(defaultInstanceDir(inst.id), 'world', 'region');
  fs.mkdirSync(region, { recursive: true });
  for (let index = 0; index < 200; index += 1) fs.writeFileSync(path.join(region, `r.${index}.mca`), 'x');

  // setImmediate runs once per turn of the event loop: a removal done synchronously inside deletePath would leave this at zero.
  let turns = 0;
  let watching = true;
  const spin = () => {
    turns += 1;
    if (watching) setImmediate(spin);
  };
  setImmediate(spin);
  try {
    await deletePath(inst.id, 'world');
  } finally {
    watching = false;
  }

  assert.equal(fs.existsSync(path.join(defaultInstanceDir(inst.id), 'world')), false);
  assert.ok(turns > 0, '删除期间事件循环应继续运转');
});

test('a failed rename on upload overwrite should restore the old file and clean up the temp file', async (t) => {
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

test('a successful upload overwrite should replace the content and leave no backup file', async (t) => {
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

test('when beforeCommit rejects after the upload is received, nothing is written to the instance directory and the temp file is cleaned up', async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { config } = await import('../config.js');
  const { createInstance } = await import('./instance-service.js');
  const { saveUploadedFile } = await import('./file-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const inst = createInstance({ name: 'upload-before-commit' });
  const root = defaultInstanceDir(inst.id);
  fs.writeFileSync(path.join(root, 'server.jar'), 'old-content');
  let calls = 0;

  await assert.rejects(
    saveUploadedFile(inst.id, '', 'server.jar', Readable.from('new-content'), {
      beforeCommit() {
        calls += 1;
        throw new Error('restore started');
      },
    }),
    /restore started/,
  );

  assert.equal(calls, 1);
  assert.equal(fs.readFileSync(path.join(root, 'server.jar'), 'utf8'), 'old-content');
  assert.equal(
    fs.existsSync(config.uploadDir)
      && fs.readdirSync(config.uploadDir).some((entry) => entry.startsWith('.tmp-file-')),
    false,
  );
});

test('an upload overwrite should still succeed when backup cleanup fails afterwards, keeping an identifiable backup', async (t) => {
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

test('a text read reports a file with a NUL byte in its first 8 KiB as binary, and UTF-8 text with a BOM or Chinese as text', async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { createInstance } = await import('./instance-service.js');
  const { readTextFile } = await import('./file-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const inst = createInstance({ name: 'read-binary' });
  const root = defaultInstanceDir(inst.id);
  // The start of a gzip stream, as level.dat is written by the game.
  fs.writeFileSync(path.join(root, 'level.dat'), Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff]));
  fs.writeFileSync(path.join(root, 'bom.yml'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('motd: 欢迎来到服务器\n')]));
  fs.writeFileSync(path.join(root, 'zh.txt'), '你好，世界');
  // Only the first 8 KiB are searched: a NUL further in does not make the file binary.
  fs.writeFileSync(path.join(root, 'late-nul.txt'), Buffer.concat([Buffer.alloc(8192, 'a'), Buffer.from([0x00])]));
  fs.writeFileSync(path.join(root, 'empty.txt'), '');

  assert.equal(readTextFile(inst.id, 'level.dat').binary, true);
  const bom = readTextFile(inst.id, 'bom.yml');
  assert.equal(bom.binary, false);
  assert.equal(bom.content, '\uFEFFmotd: 欢迎来到服务器\n', 'the BOM is kept, so saving writes it back');
  assert.deepEqual(readTextFile(inst.id, 'zh.txt'), { content: '你好，世界', binary: false });
  assert.equal(readTextFile(inst.id, 'late-nul.txt').binary, false);
  assert.deepEqual(readTextFile(inst.id, 'empty.txt'), { content: '', binary: false });
});

test('saving a text file replaces it in one step: a failed save keeps the old content and leaves no temp file behind', async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { createInstance } = await import('./instance-service.js');
  const { readTextFile, writeTextFile } = await import('./file-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const inst = createInstance({ name: 'text-save' });
  const root = defaultInstanceDir(inst.id);
  const target = path.join(root, 'config', 'paper.yml');
  const listing = () => fs.readdirSync(path.dirname(target));

  // A new file, in a directory that does not exist yet.
  writeTextFile(inst.id, 'config/paper.yml', 'motd: 你好\n');
  assert.equal(fs.readFileSync(target, 'utf8'), 'motd: 你好\n');
  assert.deepEqual(listing(), ['paper.yml']);

  // An existing file is replaced by a rename of a temp file written beside it.
  const renamed: string[][] = [];
  writeTextFile(inst.id, 'config/paper.yml', 'motd: second\n', {
    renameSync(source, destination) {
      renamed.push([path.dirname(String(source)), String(destination)]);
      assert.match(path.basename(String(source)), /^\.paper\.yml\.mystry-save\.[0-9a-f]{16}\.tmp$/);
      assert.equal(fs.readFileSync(source, 'utf8'), 'motd: second\n');
      assert.equal(fs.readFileSync(target, 'utf8'), 'motd: 你好\n', 'the old file is whole until the rename');
      fs.renameSync(source, destination);
    },
  });
  assert.deepEqual(renamed, [[path.dirname(target), target]]);
  assert.deepEqual(readTextFile(inst.id, 'config/paper.yml'), { content: 'motd: second\n', binary: false });
  assert.deepEqual(listing(), ['paper.yml']);

  // The disk fills up, or anything else goes wrong: the old content stays and the save is reported as failed.
  assert.throws(
    () => writeTextFile(inst.id, 'config/paper.yml', 'motd: third\n', {
      renameSync() {
        throw Object.assign(new Error('injected: no space left'), { code: 'ENOSPC' });
      },
    }),
    /injected: no space left/,
  );
  assert.equal(fs.readFileSync(target, 'utf8'), 'motd: second\n');
  assert.deepEqual(listing(), ['paper.yml']);

  // The file cannot be renamed over (held open by another program on Windows): it is written in place instead, as before.
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    writeTextFile(inst.id, 'config/paper.yml', `motd: ${code}\n`, {
      renameSync() {
        throw Object.assign(new Error(`injected: ${code}`), { code });
      },
    });
    assert.equal(fs.readFileSync(target, 'utf8'), `motd: ${code}\n`);
    assert.deepEqual(listing(), ['paper.yml']);
  }

  // Saving empty content empties the file.
  writeTextFile(inst.id, 'config/paper.yml', '');
  assert.equal(fs.statSync(target).size, 0);
});

test('a save that must not replace anything creates a new file, and leaves a file or folder that is already there alone', async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { createInstance } = await import('./instance-service.js');
  const { writeTextFile } = await import('./file-service.js');
  const { routeErrorStatus } = await import('../http-errors.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const inst = createInstance({ name: 'text-create' });
  const root = defaultInstanceDir(inst.id);
  fs.writeFileSync(path.join(root, 'server.properties'), 'motd=keep\n');
  fs.mkdirSync(path.join(root, 'plugins'));
  const exists = (err: unknown) => {
    assert.equal((err as { messageKey?: string }).messageKey, 'server.files.alreadyExists');
    assert.equal(routeErrorStatus(err), 409);
    return true;
  };

  assert.throws(() => writeTextFile(inst.id, 'server.properties', '', { onConflict: 'fail' }), exists);
  assert.equal(fs.readFileSync(path.join(root, 'server.properties'), 'utf8'), 'motd=keep\n');
  // A folder of that name gets the same answer, not the one for a path that is not a regular file.
  assert.throws(() => writeTextFile(inst.id, 'plugins', '', { onConflict: 'fail' }), exists);
  assert.ok(fs.statSync(path.join(root, 'plugins')).isDirectory());
  if (process.platform === 'win32') {
    // The file system ignores letter case here, so a name that differs only in case is the same file.
    assert.throws(() => writeTextFile(inst.id, 'Server.Properties', '', { onConflict: 'fail' }), exists);
    assert.equal(fs.readFileSync(path.join(root, 'server.properties'), 'utf8'), 'motd=keep\n');
  }

  writeTextFile(inst.id, 'notes.txt', '', { onConflict: 'fail' });
  assert.equal(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8'), '');
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.includes('mystry-save')), []);
  // Without it a save still replaces the file, as before.
  writeTextFile(inst.id, 'server.properties', 'motd=new\n', { onConflict: 'overwrite' });
  assert.equal(fs.readFileSync(path.join(root, 'server.properties'), 'utf8'), 'motd=new\n');
});

test('creating a text file leaves a name claimed after the existence check alone', async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { createInstance } = await import('./instance-service.js');
  const { writeTextFile } = await import('./file-service.js');
  const { routeErrorStatus } = await import('../http-errors.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const inst = createInstance({ name: 'text-create-race' });
  const root = defaultInstanceDir(inst.id);
  const existsSync = fs.existsSync;
  const cases = [
    { name: 'empty.txt', content: '', isDirectory: false },
    { name: 'initial.txt', content: 'initial text', isDirectory: false },
    { name: 'empty-folder', content: '', isDirectory: true },
    { name: 'initial-folder', content: 'initial text', isDirectory: true },
  ];
  for (const { name, content, isDirectory } of cases) {
    await t.test(name, (t) => {
      const target = path.join(root, name);
      t.mock.method(fs, 'existsSync', (candidate: fs.PathLike) => {
        const exists = existsSync(candidate);
        if (candidate === target && !exists) {
          if (isDirectory) fs.mkdirSync(target);
          else fs.writeFileSync(target, 'other writer', { flag: 'wx' });
        }
        return exists;
      });

      assert.throws(() => writeTextFile(inst.id, name, content, { onConflict: 'fail' }), (err: unknown) => {
        assert.equal(routeErrorStatus(err), 409);
        return true;
      });
      if (isDirectory) assert.deepEqual(fs.readdirSync(target), []);
      else assert.equal(fs.readFileSync(target, 'utf8'), 'other writer');
      assert.deepEqual(fs.readdirSync(root).filter((entry) => entry.includes('mystry-save')), []);
    });
  }
});

test('creating a nonempty text file uses an exclusive write when the volume refuses hard links', async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { createInstance } = await import('./instance-service.js');
  const { writeTextFile } = await import('./file-service.js');
  const { routeErrorStatus } = await import('../http-errors.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const inst = createInstance({ name: 'text-create-no-links' });
  const root = defaultInstanceDir(inst.id);
  const claimed = path.join(root, 'claimed.txt');
  const link = t.mock.method(fs, 'linkSync', (_source: fs.PathLike, target: fs.PathLike) => {
    if (target === claimed) fs.writeFileSync(claimed, 'other writer', { flag: 'wx' });
    throw Object.assign(new Error('hard links unavailable'), { code: process.platform === 'win32' ? 'EISDIR' : 'EPERM' });
  });

  writeTextFile(inst.id, 'created.txt', 'complete text', { onConflict: 'fail' });
  assert.equal(fs.readFileSync(path.join(root, 'created.txt'), 'utf8'), 'complete text');
  assert.throws(() => writeTextFile(inst.id, 'claimed.txt', 'new text', { onConflict: 'fail' }), (err: unknown) => {
    assert.equal(routeErrorStatus(err), 409);
    return true;
  });
  assert.equal(fs.readFileSync(claimed, 'utf8'), 'other writer');
  assert.equal(link.mock.callCount(), 2);
  assert.deepEqual(fs.readdirSync(root).filter((entry) => entry.includes('mystry-save')), []);
});

test('a failed exclusive write leaves a concurrent replacement at the same path', async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { createInstance } = await import('./instance-service.js');
  const { writeTextFile } = await import('./file-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const inst = createInstance({ name: 'text-create-replaced' });
  const root = defaultInstanceDir(inst.id);
  const sync = fs.fsyncSync;
  const close = fs.closeSync;
  for (const [name, content] of [['empty.yml', ''], ['partial.yml', 'enabled: true\n']]) {
    await t.test(name, (t) => {
      const target = path.join(root, name);
      const replacement = path.join(root, 'replacement.yml');
      fs.writeFileSync(replacement, 'new content from another writer');
      t.mock.method(fs, 'linkSync', () => {
        throw Object.assign(new Error('hard links unavailable'), { code: 'ENOTSUP' });
      });
      let failedFd: number | undefined;
      t.mock.method(fs, 'fsyncSync', (fd: number) => {
        if (!fs.existsSync(target)) {
          sync(fd);
          return;
        }
        failedFd = fd;
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      });
      t.mock.method(fs, 'closeSync', (fd: number) => {
        close(fd);
        if (fd !== failedFd) return;
        failedFd = undefined;
        // Windows can refuse a rename over the open file. Replace it after close, before the failure handler runs.
        fs.renameSync(replacement, target);
      });

      assert.throws(() => writeTextFile(inst.id, name, content, { onConflict: 'fail' }), { code: 'ENOSPC' });
      assert.equal(fs.readFileSync(target, 'utf8'), 'new content from another writer');
    });
  }
});

test('a failed exclusive write leaves the file for inspection before retry', async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { createInstance } = await import('./instance-service.js');
  const { writeTextFile } = await import('./file-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const inst = createInstance({ name: 'text-create-write-fails' });
  const root = defaultInstanceDir(inst.id);
  const partial = path.join(root, 'partial.yml');
  const empty = path.join(root, 'empty.yml');
  const diskFull = () => Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
  const link = t.mock.method(fs, 'linkSync', () => {
    throw Object.assign(new Error('hard links unavailable'), { code: process.platform === 'win32' ? 'EISDIR' : 'EPERM' });
  });
  const fsyncSync = fs.fsyncSync;
  // Fails only for the write into the target itself: the temp file of the hard-link attempt is synced before the link is tried.
  const sync = t.mock.method(fs, 'fsyncSync', (fd: number) => {
    if (link.mock.callCount() > 0 || failEverySync) throw diskFull();
    fsyncSync(fd);
  });
  let failEverySync = false;

  assert.throws(() => writeTextFile(inst.id, 'partial.yml', 'enabled: true\n', { onConflict: 'fail' }), { code: 'ENOSPC' });
  assert.equal(fs.readFileSync(partial, 'utf8'), 'enabled: true\n');

  failEverySync = true;
  assert.throws(() => writeTextFile(inst.id, 'empty.yml', '', { onConflict: 'fail' }), { code: 'ENOSPC' });
  assert.equal(fs.readFileSync(empty, 'utf8'), '');

  sync.mock.restore();
  assert.throws(() => writeTextFile(inst.id, 'partial.yml', 'enabled: false\n', { onConflict: 'fail' }), {
    messageKey: 'server.files.alreadyExists',
  });
  assert.equal(fs.readFileSync(partial, 'utf8'), 'enabled: true\n');
  fs.unlinkSync(partial);
  writeTextFile(inst.id, 'partial.yml', 'enabled: true\n', { onConflict: 'fail' });
  assert.equal(fs.readFileSync(partial, 'utf8'), 'enabled: true\n');
  assert.deepEqual(fs.readdirSync(root).filter((entry) => entry.includes('mystry-save')), []);
});

test('saving a text file keeps its permission bits, and a file marked read-only is still refused', async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { createInstance } = await import('./instance-service.js');
  const { writeTextFile } = await import('./file-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const inst = createInstance({ name: 'text-save-mode' });
  const root = defaultInstanceDir(inst.id);

  // Windows has no permission bits beyond read-only.
  if (process.platform !== 'win32') {
    const script = path.join(root, 'start.sh');
    fs.writeFileSync(script, '#!/bin/sh\n');
    fs.chmodSync(script, 0o754);
    writeTextFile(inst.id, 'start.sh', '#!/bin/sh\nexec java -jar server.jar\n');
    assert.equal(fs.statSync(script).mode & 0o7777, 0o754);
    assert.equal(fs.readFileSync(script, 'utf8'), '#!/bin/sh\nexec java -jar server.jar\n');
  }

  const locked = path.join(root, 'locked.properties');
  fs.writeFileSync(locked, 'keep=1\n');
  fs.chmodSync(locked, 0o444);
  try {
    // root may write to any file, so there is nothing to refuse.
    if (process.getuid?.() !== 0) {
      assert.throws(
        () => writeTextFile(inst.id, 'locked.properties', 'keep=2\n'),
        (err: unknown) => ['EACCES', 'EPERM'].includes(String((err as { code?: unknown }).code)),
      );
      assert.equal(fs.readFileSync(locked, 'utf8'), 'keep=1\n');
      assert.deepEqual(fs.readdirSync(root).filter((entry) => entry.endsWith('.tmp')), []);
    }
  } finally {
    // A read-only file would keep Windows from removing the data directory after the test.
    fs.chmodSync(locked, 0o644);
  }
});

test('creating an entry refuses a name the system cannot handle, while entries that are already there stay usable', async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { config } = await import('../config.js');
  const { createInstance } = await import('./instance-service.js');
  const { deletePath, mkdirPath, renamePath, saveUploadedFile, writeTextFile } = await import('./file-service.js');
  const { defaultInstanceDir, OWNERSHIP_MARKER_FILE } = await import('../utils/path.js');

  initDb();
  const inst = createInstance({ name: 'entry-names' });
  const root = defaultInstanceDir(inst.id);
  const entries = () => fs.readdirSync(root).filter((name) => name !== OWNERSHIP_MARKER_FILE).sort();
  const hasKey = (key: string) => (err: unknown) => (err as { messageKey?: string }).messageKey === key;
  fs.writeFileSync(path.join(root, 'a.txt'), 'a');

  // A control character is refused on every system, by each entry point that can create something.
  const bad = 'bad\u0001name';
  const invalidCharacter = hasKey('server.files.name.invalidCharacter');
  assert.throws(() => mkdirPath(inst.id, bad), invalidCharacter);
  assert.throws(() => mkdirPath(inst.id, `plugins/${bad}/data`), invalidCharacter, 'a new folder is not created up to the bad name');
  assert.throws(() => writeTextFile(inst.id, `${bad}.yml`, 'x'), invalidCharacter);
  assert.throws(() => writeTextFile(inst.id, `${bad}/config.yml`, 'x'), invalidCharacter);
  assert.throws(() => renamePath(inst.id, 'a.txt', `${bad}.txt`), invalidCharacter);
  await assert.rejects(saveUploadedFile(inst.id, '', `${bad}.jar`, Readable.from('jar')), invalidCharacter);
  await assert.rejects(saveUploadedFile(inst.id, `mods/${bad}`, 'mod.jar', Readable.from('jar')), invalidCharacter);
  assert.deepEqual(entries(), ['a.txt']);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'a');
  // The upload was refused before anything of it was received.
  assert.equal(fs.existsSync(config.uploadDir) && fs.readdirSync(config.uploadDir).some((entry) => entry.startsWith('.tmp-file-')), false);

  if (process.platform === 'win32') {
    for (const [name, key] of [
      ['con', 'server.files.name.reserved'],
      ['nul.txt', 'server.files.name.reserved'],
      ['trailing.', 'server.files.name.trailingDotOrSpace'],
      ['what?.txt', 'server.files.name.invalidCharacter'],
    ] as const) {
      assert.throws(() => mkdirPath(inst.id, name), hasKey(key), `mkdir ${name}`);
      assert.throws(() => renamePath(inst.id, 'a.txt', name), hasKey(key), `rename to ${name}`);
      assert.throws(() => writeTextFile(inst.id, `configs/${name}`, 'x'), hasKey(key), `write ${name}`);
    }
    assert.deepEqual(entries(), ['a.txt']);
  } else {
    // Legal here, and a server brought over from another machine may contain them.
    mkdirPath(inst.id, 'con');
    writeTextFile(inst.id, 'con/trailing.', 'x');
    renamePath(inst.id, 'a.txt', 'what?.txt');
    assert.deepEqual(entries(), ['con', 'what?.txt']);

    // An entry whose name would be refused today can still be saved, used as a parent, renamed and deleted.
    const odd = 'odd\u0001name.txt';
    fs.writeFileSync(path.join(root, odd), 'old');
    fs.mkdirSync(path.join(root, 'odd\u0001dir'));
    writeTextFile(inst.id, odd, 'new');
    assert.equal(fs.readFileSync(path.join(root, odd), 'utf8'), 'new');
    writeTextFile(inst.id, 'odd\u0001dir/inside.yml', 'x');
    renamePath(inst.id, odd, 'fixed.txt');
    await deletePath(inst.id, 'odd\u0001dir');
    assert.deepEqual(entries(), ['con', 'fixed.txt', 'what?.txt']);
  }
});

test('a temp file left by a save that was cut short is not listed, and the next save in the directory removes it', async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { createInstance } = await import('./instance-service.js');
  const { listFiles, writeTextFile } = await import('./file-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const inst = createInstance({ name: 'text-save-leftover' });
  const dir = path.join(defaultInstanceDir(inst.id), 'config');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'paper.yml'), 'motd: old\n');
  const leftover = '.paper.yml.mystry-save.0123456789abcdef.tmp';
  fs.writeFileSync(path.join(dir, leftover), 'motd: ha');
  // Not the panel's: other files that merely look temporary are shown and kept.
  const others = ['.paper.yml.4242.0123456789abcdef.tmp', 'world.mystry-save.0123456789abcdef.tmp', '.notes.tmp'];
  for (const name of others) fs.writeFileSync(path.join(dir, name), 'keep');
  fs.mkdirSync(path.join(dir, '.dir.mystry-save.0123456789abcdef.tmp'));

  const listed = listFiles(inst.id, 'config').map((entry) => entry.name);
  assert.equal(listed.includes(leftover), false);
  assert.deepEqual(listed.sort(), ['.dir.mystry-save.0123456789abcdef.tmp', 'paper.yml', ...others].sort());

  writeTextFile(inst.id, 'config/spigot.yml', 'x\n');
  assert.equal(fs.existsSync(path.join(dir, leftover)), false);
  assert.deepEqual(
    fs.readdirSync(dir).sort(),
    ['.dir.mystry-save.0123456789abcdef.tmp', 'paper.yml', 'spigot.yml', ...others].sort(),
  );
  assert.equal(fs.readFileSync(path.join(dir, 'paper.yml'), 'utf8'), 'motd: old\n');
});

test('a file the running server has open is saved in place, so the server keeps writing to the file that is shown', { skip: process.platform !== 'linux' }, async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { createInstance } = await import('./instance-service.js');
  const { writeTextFile } = await import('./file-service.js');
  const { isFileOpenInProcess } = await import('../utils/open-files.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const inst = createInstance({ name: 'text-save-open' });
  const root = defaultInstanceDir(inst.id);
  fs.mkdirSync(path.join(root, 'logs'));
  const log = path.join(root, 'logs', 'latest.log');
  fs.writeFileSync(log, '[10:00:00] Starting\n[10:00:05] Done\n');
  fs.writeFileSync(path.join(root, 'server.properties'), 'motd=old\n');
  const noRename = () => assert.fail('a file held open must not be replaced by a rename');

  // This test process stands in for the server: it holds the log open for appending, as a server does.
  const fd = fs.openSync(log, 'a');
  try {
    assert.equal(isFileOpenInProcess(process.pid, log), true);
    assert.equal(isFileOpenInProcess(process.pid, path.join(root, 'server.properties')), false);
    const inode = fs.statSync(log).ino;

    writeTextFile(inst.id, 'logs/latest.log', '[10:00:05] Done\n', { serverPids: [process.pid], renameSync: noRename });
    fs.writeSync(fd, '[10:00:09] Saved the game\n');
    assert.equal(fs.readFileSync(log, 'utf8'), '[10:00:05] Done\n[10:00:09] Saved the game\n');
    assert.equal(fs.statSync(log).ino, inode);

    // A file the server does not have open is still replaced by a rename, whether or not a server is running.
    let renames = 0;
    const countRename: typeof fs.renameSync = (source, destination) => {
      renames += 1;
      fs.renameSync(source, destination);
    };
    writeTextFile(inst.id, 'server.properties', 'motd=new\n', { serverPids: [process.pid], renameSync: countRename });
    assert.equal(renames, 1);
    assert.equal(fs.readFileSync(path.join(root, 'server.properties'), 'utf8'), 'motd=new\n');
  } finally {
    fs.closeSync(fd);
  }
  assert.equal(isFileOpenInProcess(process.pid, log), false);
  // A process that does not exist has nothing open.
  assert.equal(isFileOpenInProcess(2 ** 30, log), false);
});
