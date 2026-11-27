import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import test from 'node:test';
import { renderPanelMessage, type PanelMessage } from '@mystry/shared';

process.env.JWT_SECRET = 'a'.repeat(64);
process.env.SETUP_TOKEN = 'b'.repeat(64);
process.env.LAUNCHER_TOKEN = 'c'.repeat(64);

type ZipTestEntry = {
  name: string;
  rawName?: Buffer;
  contents: string;
  compression?: 0 | 8;
  flags?: number;
  localExtra?: Buffer;
  centralExtra?: Buffer;
};

function createZip(entries: readonly ZipTestEntry[]): Buffer {
  const localEntries: Buffer[] = [];
  const centralEntries: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = entry.rawName ?? Buffer.from(entry.name, 'utf8');
    const contents = Buffer.from(entry.contents, 'utf8');
    const compression = entry.compression ?? 0;
    const flags = entry.flags ?? 0;
    const compressed = compression === 8 ? deflateRawSync(contents) : contents;
    const localExtra = entry.localExtra ?? Buffer.alloc(0);
    const centralExtra = entry.centralExtra ?? Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(compression, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(localExtra.length, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(compression, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(centralExtra.length, 30);
    central.writeUInt32LE(localOffset, 42);

    localEntries.push(local, name, localExtra, compressed);
    centralEntries.push(central, name, centralExtra);
    localOffset += local.length + name.length + localExtra.length + compressed.length;
  }

  const centralSize = centralEntries.reduce((total, entry) => total + entry.length, 0);
  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
  endOfCentralDirectory.writeUInt16LE(entries.length, 8);
  endOfCentralDirectory.writeUInt16LE(entries.length, 10);
  endOfCentralDirectory.writeUInt32LE(centralSize, 12);
  endOfCentralDirectory.writeUInt32LE(localOffset, 16);

  return Buffer.concat([...localEntries, ...centralEntries, endOfCentralDirectory]);
}

test('a ZIP with a single outer directory should still be flattened and imported when the staging marker exists', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-import-service-test-'));
  process.env.MYSTRY_DATA_DIR = dataRoot;
  t.after(async () => {
    try {
      const { closeDb } = await import('../db.js');
      closeDb();
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  const { initDb } = await import('../db.js');
  const { importZipPackage } = await import('./import-service.js');
  const { getTask } = await import('./task-service.js');
  const { STAGING_MARKER_FILE } = await import('./task-staging-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');
  initDb();

  const zipPath = path.join(dataRoot, 'uploads', '.tmp-import-wrapper.zip');
  fs.writeFileSync(zipPath, createZip([
    { name: 'wrapper/server.jar', contents: 'server-jar-content' },
  ]));

  const queuedTask = await importZipPackage({
    name: '带外层目录的导入包',
    zipPath,
  });
  let completedTask = getTask(queuedTask.id);
  for (
    let attempt = 0;
    attempt < 200 && completedTask?.status !== 'completed' && completedTask?.status !== 'failed';
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    completedTask = getTask(queuedTask.id);
  }

  assert.equal(completedTask?.status, 'completed', completedTask?.error);
  const instanceId = completedTask?.result?.instanceId;
  if (typeof instanceId !== 'string') {
    assert.fail('导入任务未返回实例 ID');
  }
  const instanceDir = defaultInstanceDir(instanceId);
  assert.equal(fs.readFileSync(path.join(instanceDir, 'server.jar'), 'utf8'), 'server-jar-content');
  assert.equal(fs.existsSync(path.join(instanceDir, 'wrapper')), false);
  assert.equal(fs.existsSync(path.join(instanceDir, STAGING_MARKER_FILE)), false);
  assert.equal(fs.existsSync(zipPath), false);
});

test('ZIP preview and extraction keep entry reading, size validation and cancel boundaries', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-zip-boundaries-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { inspectZipJvmConfig, safeExtract } = await import('./zip-service.js');
  const { PanelError } = await import('../utils/errors.js');
  const hasMessageKey = (key: string) => (error: unknown) => error instanceof PanelError && error.messageKey === key;
  const jvmArgs = '-Xms1G\n-Xmx2G\n';
  let sequence = 0;
  const fixture = (zip: Buffer) => {
    const zipPath = path.join(root, `${sequence++}.zip`);
    fs.writeFileSync(zipPath, zip);
    return { zipPath, destDir: `${zipPath}-extracted` };
  };
  const centralOffset = (zip: Buffer) => zip.readUInt32LE(zip.length - 22 + 16);

  for (const compression of [0, 8] as const) {
    await t.test(`compression method ${compression} correctly skips the local extra field and reads an empty file`, async () => {
      const { zipPath, destDir } = fixture(createZip([
        { name: 'user_jvm_args.txt', contents: jvmArgs, compression, localExtra: Buffer.from([0xfe, 0xca, 0, 0]) },
        { name: 'empty.txt', contents: '', compression },
      ]));
      assert.equal((await inspectZipJvmConfig(zipPath))?.canonicalArgs, '-Xms1G -Xmx2G');
      await safeExtract(zipPath, destDir);
      assert.equal(fs.readFileSync(path.join(destDir, 'user_jvm_args.txt'), 'utf8'), jvmArgs);
      assert.equal(fs.statSync(path.join(destDir, 'empty.txt')).size, 0);
    });
  }

  // preview: the English text of the preview diagnostic (diagnostic items have text only); extractKey: the message key thrown during extraction.
  const entryName = { name: 'user_jvm_args.txt' };
  const corruptions: Array<{ name: string; mutate: (zip: Buffer) => void; preview: PanelMessage; extractKey: string }> = [
    {
      name: '本地文件头损坏',
      mutate: (zip) => { zip.writeUInt32LE(0, 0); },
      preview: { key: 'server.files.zip.localHeaderInvalid', params: entryName },
      extractKey: 'server.files.zip.localHeaderInvalid',
    },
    {
      name: '条目数据越界',
      mutate: (zip) => { zip.writeUInt16LE(0xffff, 28); },
      preview: { key: 'server.files.zip.entryDataOutOfRange', params: entryName },
      extractKey: 'server.files.zip.entryDataOutOfRange',
    },
    {
      name: '压缩方式不支持',
      mutate: (zip) => { zip.writeUInt16LE(99, centralOffset(zip) + 10); },
      preview: { key: 'server.files.zip.jvmArgsUnsupportedCompression', params: { method: 99 } },
      extractKey: 'server.files.zip.unsupportedCompression',
    },
    {
      name: '解压大小不匹配',
      mutate: (zip) => { zip.writeUInt32LE(Buffer.byteLength(jvmArgs) + 1, centralOffset(zip) + 24); },
      preview: { key: 'server.files.zip.jvmArgsSizeMismatch' },
      extractKey: 'server.files.zip.entrySizeMismatch',
    },
  ];
  for (const { name, mutate, preview: expectedPreview, extractKey } of corruptions) {
    await t.test(`on ${name} the preview returns a diagnostic and extraction cleans up the half-finished output`, async () => {
      const zip = createZip([{ name: 'user_jvm_args.txt', contents: jvmArgs }]);
      mutate(zip);
      const { zipPath, destDir } = fixture(zip);
      const preview = await inspectZipJvmConfig(zipPath);
      assert.equal(preview?.canonicalArgs, null);
      assert.equal(preview?.issues[0]?.code, 'ZIP_ARGFILE_ERROR');
      assert.equal(preview?.issues[0]?.message, renderPanelMessage(expectedPreview));
      await assert.rejects(() => safeExtract(zipPath, destDir), hasMessageKey(extractKey));
      assert.equal(fs.existsSync(destDir), false);
      assert.equal(fs.existsSync(zipPath), true);
    });
  }

  await t.test('the JVM preview still enforces the 64 KiB streaming limit against a forged uncompressed size', async () => {
    const zip = createZip([{ name: 'user_jvm_args.txt', contents: 'x'.repeat(65_537), compression: 8 }]);
    zip.writeUInt32LE(1, centralOffset(zip) + 24);
    const { zipPath } = fixture(zip);
    const preview = await inspectZipJvmConfig(zipPath);
    assert.equal(preview?.canonicalArgs, null);
    assert.equal(preview?.issues[0]?.message, renderPanelMessage({ key: 'server.files.zip.jvmArgsTooLarge' }));
  });

  await t.test('a cancel before starting keeps the timeout reason and cleans up the extraction directory', async () => {
    const { zipPath, destDir } = fixture(createZip([{ name: 'server.jar', contents: 'jar' }]));
    const controller = new AbortController();
    controller.abort(new PanelError('server.tasks.timeout'));
    await assert.rejects(() => safeExtract(zipPath, destDir, controller.signal), hasMessageKey('server.tasks.timeout'));
    assert.equal(fs.existsSync(destDir), false);
    assert.equal(fs.existsSync(zipPath), true);
  });

  await t.test('a cancel while reading closes the stream and deletes the half-finished output already written', async (t) => {
    const { zipPath, destDir } = fixture(createZip([{ name: 'server.jar', contents: 'x'.repeat(256 * 1024) }]));
    const controller = new AbortController();
    const createReadStream = fs.createReadStream;
    let source: fs.ReadStream | undefined;
    t.mock.method(fs, 'createReadStream', (...args: Parameters<typeof createReadStream>) => {
      source = createReadStream(...args);
      source.once('data', () => controller.abort(new PanelError('server.tasks.cancelled')));
      return source;
    });
    await assert.rejects(() => safeExtract(zipPath, destDir, controller.signal), hasMessageKey('server.tasks.cancelled'));
    assert.equal(source?.destroyed, true);
    assert.equal(fs.existsSync(destDir), false);
    assert.equal(fs.existsSync(zipPath), true);
  });
});

test('a forged staging marker inside the ZIP outer directory should be rejected', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-import-service-test-'));
  process.env.MYSTRY_DATA_DIR = dataRoot;
  t.after(async () => {
    try {
      const { closeDb } = await import('../db.js');
      closeDb();
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  const { initDb } = await import('../db.js');
  const { importZipPackage } = await import('./import-service.js');
  const { getTask } = await import('./task-service.js');
  const { STAGING_MARKER_FILE } = await import('./task-staging-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');
  initDb();

  const zipPath = path.join(dataRoot, 'uploads', '.tmp-import-forged-marker.zip');
  fs.writeFileSync(zipPath, createZip([
    { name: 'wrapper/server.jar', contents: 'server-jar-content' },
    { name: `wrapper/${STAGING_MARKER_FILE}`, contents: '{"version":1,"token":"forged"}' },
  ]));

  const queuedTask = await importZipPackage({
    name: '伪造标记的导入包',
    zipPath,
  });
  let completedTask = getTask(queuedTask.id);
  for (
    let attempt = 0;
    attempt < 200 && completedTask?.status !== 'completed' && completedTask?.status !== 'failed';
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    completedTask = getTask(queuedTask.id);
  }

  assert.equal(completedTask?.status, 'failed');
  assert.deepEqual(completedTask?.errorI18n, {
    key: 'server.imports.zip.duplicateRootPath',
    params: { name: STAGING_MARKER_FILE },
  });
  const instanceId = completedTask?.result?.instanceId;
  if (typeof instanceId === 'string') {
    assert.equal(fs.existsSync(defaultInstanceDir(instanceId)), false);
  }
  assert.equal(fs.existsSync(zipPath), false);
});

test('ZIP archives with a panel ownership marker are rejected before promoting without leaving orphan directories', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-import-service-test-'));
  process.env.MYSTRY_DATA_DIR = dataRoot;
  t.after(async () => {
    try {
      const { closeDb } = await import('../db.js');
      closeDb();
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  const { initDb } = await import('../db.js');
  const { importZipPackage } = await import('./import-service.js');
  const { getTask, resetTaskRuntimeForTests } = await import('./task-service.js');
  const { OWNERSHIP_MARKER_FILE } = await import('../utils/path.js');
  initDb();
  resetTaskRuntimeForTests();

  for (const [label, entries] of [
    ['root', [
      { name: 'server.jar', contents: 'server-jar-content' },
      { name: OWNERSHIP_MARKER_FILE, contents: '{"version":1,"instanceId":"old","marker":"abc"}' },
    ]],
    ['wrapper', [
      { name: 'wrapper/server.jar', contents: 'server-jar-content' },
      { name: `wrapper/${OWNERSHIP_MARKER_FILE}`, contents: '{"version":1,"instanceId":"old","marker":"abc"}' },
    ]],
  ] as const) {
    const zipPath = path.join(dataRoot, 'uploads', `.tmp-import-reserved-${label}.zip`);
    fs.writeFileSync(zipPath, createZip(entries));
    const queuedTask = await importZipPackage({ name: `marker-${label}`, zipPath });
    let completedTask = getTask(queuedTask.id);
    for (let attempt = 0; attempt < 200 && completedTask?.status !== 'completed' && completedTask?.status !== 'failed'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      completedTask = getTask(queuedTask.id);
    }
    assert.equal(completedTask?.status, 'failed', label);
    assert.equal(completedTask?.errorI18n?.key, 'server.files.zip.reservedName', label);
    assert.deepEqual(fs.readdirSync(path.join(dataRoot, 'instances')), [], `${label} must not leave orphan instance directories`);
    assert.deepEqual(fs.readdirSync(path.join(dataRoot, '.mystry-staging')), [], `${label} must clean staging`);
    assert.equal(fs.existsSync(zipPath), false, `${label} must clean uploaded zip`);
  }
});

test('commit failure during validation or DB insert rolls back and leaves no orphan instance directory', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-import-commit-rollback-'));
  process.env.MYSTRY_DATA_DIR = dataRoot;
  t.after(async () => {
    try {
      const { closeDb } = await import('../db.js');
      closeDb();
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  const { initDb, getDb } = await import('../db.js');
  const { importZipPackage } = await import('./import-service.js');
  const { getTask, resetTaskRuntimeForTests } = await import('./task-service.js');
  initDb();
  resetTaskRuntimeForTests();

  const waitTask = async (id: string) => {
    let task = getTask(id);
    for (let attempt = 0; attempt < 200 && task?.status !== 'completed' && task?.status !== 'failed'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      task = getTask(id);
    }
    return task;
  };

  // Failure during pre-rename validation (unavailable Java runtime ID).
  const badJavaZip = path.join(dataRoot, 'uploads', '.tmp-import-bad-java.zip');
  fs.writeFileSync(badJavaZip, createZip([{ name: 'server.jar', contents: 'jar' }]));
  const badJavaTask = await waitTask((await importZipPackage({
    name: 'bad-java',
    zipPath: badJavaZip,
    javaRuntimeId: 'nonexistent-runtime',
  })).id);
  assert.equal(badJavaTask?.status, 'failed');
  assert.equal(badJavaTask?.errorI18n?.key, 'server.instance.javaRuntimeInvalid');
  assert.deepEqual(fs.readdirSync(path.join(dataRoot, 'instances')), []);
  assert.deepEqual(fs.readdirSync(path.join(dataRoot, '.mystry-staging')), []);

  // Failure during DB insert after rename: directory must be moved back to staging and removed.
  const dbFailZip = path.join(dataRoot, 'uploads', '.tmp-import-db-fail.zip');
  fs.writeFileSync(dbFailZip, createZip([{ name: 'server.jar', contents: 'jar' }]));
  getDb().exec(`CREATE TRIGGER fail_instance_insert BEFORE INSERT ON instances
    BEGIN SELECT RAISE(ABORT, 'simulated disk full'); END`);
  try {
    const dbFailTask = await waitTask((await importZipPackage({
      name: 'db-fail',
      zipPath: dbFailZip,
      acceptEula: true,
    })).id);
    assert.equal(dbFailTask?.status, 'failed');
    assert.match(dbFailTask?.error ?? '', /simulated disk full/);
    assert.deepEqual(fs.readdirSync(path.join(dataRoot, 'instances')), [], 'failed DB insert must not leave an orphan instance directory');
    assert.deepEqual(fs.readdirSync(path.join(dataRoot, '.mystry-staging')), [], 'rolled-back staging tree must be cleaned');
    assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM instances').get()!.count, 0);
  } finally {
    getDb().exec('DROP TRIGGER fail_instance_insert');
  }
});

test('ZIP entry name decoding supports UTF-8 flag and Info-ZIP 0x7075, and rejects invalid non-UTF-8 legacy names', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-zip-encoding-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { listZipEntryNames, safeExtract } = await import('./zip-service.js');
  const { PanelError } = await import('../utils/errors.js');
  const { crc32 } = await import('node:zlib');

  const buildUnicodePathExtra = (rawName: Buffer, unicodeName: string, overrideCrc?: number): Buffer => {
    const unicodeBytes = Buffer.from(unicodeName, 'utf8');
    const dataSize = 1 + 4 + unicodeBytes.length;
    const extra = Buffer.alloc(4 + dataSize);
    extra.writeUInt16LE(0x7075, 0);
    extra.writeUInt16LE(dataSize, 2);
    extra[4] = 1;
    extra.writeUInt32LE(overrideCrc ?? (crc32(rawName) >>> 0), 5);
    unicodeBytes.copy(extra, 9);
    return extra;
  };

  // GBK bytes for "配置.yml" and "语言.yml" (not valid UTF-8; previously both decoded to "\ufffd\ufffd\ufffd\ufffd.yml" and collided as duplicateEntry).
  const gbkConfig = Buffer.from([0xc5, 0xe4, 0xd6, 0xc3, 0x2e, 0x79, 0x6d, 0x6c]);
  const gbkLang = Buffer.from([0xd3, 0xef, 0xd1, 0xd4, 0x2e, 0x79, 0x6d, 0x6c]);

  // 1. UTF-8 flag (bit 11) with Chinese entry names succeeds.
  const utf8Zip = path.join(root, 'utf8.zip');
  const utf8Dest = path.join(root, 'utf8-out');
  fs.writeFileSync(utf8Zip, createZip([
    { name: 'plugins/配置.yml', contents: 'a: 1\n', flags: 1 << 11 },
    { name: 'plugins/语言.yml', contents: 'b: 2\n', flags: 1 << 11 },
  ]));
  assert.deepEqual(listZipEntryNames(utf8Zip), ['plugins/配置.yml', 'plugins/语言.yml']);
  await safeExtract(utf8Zip, utf8Dest);
  assert.equal(fs.readFileSync(path.join(utf8Dest, 'plugins', '配置.yml'), 'utf8'), 'a: 1\n');
  assert.equal(fs.readFileSync(path.join(utf8Dest, 'plugins', '语言.yml'), 'utf8'), 'b: 2\n');

  // 2. Legacy GBK raw name paired with a valid Info-ZIP 0x7075 Unicode Path field decodes to the Unicode name.
  const extraZip = path.join(root, 'infozip-0x7075.zip');
  const extraDest = path.join(root, 'infozip-out');
  fs.writeFileSync(extraZip, createZip([
    {
      name: '',
      rawName: gbkConfig,
      centralExtra: buildUnicodePathExtra(gbkConfig, '配置.yml'),
      contents: 'ok: true\n',
    },
  ]));
  assert.deepEqual(listZipEntryNames(extraZip), ['配置.yml']);
  await safeExtract(extraZip, extraDest);
  assert.equal(fs.readFileSync(path.join(extraDest, '配置.yml'), 'utf8'), 'ok: true\n');

  // 3. Stale 0x7075 with mismatched CRC-32 is ignored, falling back to raw bytes which are rejected as non-UTF-8.
  const staleExtraZip = path.join(root, 'stale-0x7075.zip');
  fs.writeFileSync(staleExtraZip, createZip([
    {
      name: '',
      rawName: gbkConfig,
      centralExtra: buildUnicodePathExtra(gbkConfig, '配置.yml', 0x12345678),
      contents: 'ok: true\n',
    },
  ]));
  assert.throws(
    () => listZipEntryNames(staleExtraZip),
    (error: unknown) => error instanceof PanelError && error.messageKey === 'server.files.zip.nonUtf8EntryName',
  );

  // 4. Two distinct legacy GBK names without bit 11 or 0x7075 are rejected cleanly as nonUtf8EntryName, not duplicateEntry or U+FFFD corruption.
  const gbkZip = path.join(root, 'gbk.zip');
  fs.writeFileSync(gbkZip, createZip([
    { name: '', rawName: gbkConfig, contents: 'a: 1\n' },
    { name: '', rawName: gbkLang, contents: 'b: 2\n' },
  ]));
  assert.throws(
    () => listZipEntryNames(gbkZip),
    (error: unknown) => error instanceof PanelError && error.messageKey === 'server.files.zip.nonUtf8EntryName',
  );
  await assert.rejects(
    () => safeExtract(gbkZip, path.join(root, 'gbk-out')),
    (error: unknown) => error instanceof PanelError && error.messageKey === 'server.files.zip.nonUtf8EntryName',
  );

  // 5. Invalid UTF-8 bytes when bit 11 IS set are rejected as entryNameInvalid.
  const badUtf8FlagZip = path.join(root, 'bad-utf8-flag.zip');
  fs.writeFileSync(badUtf8FlagZip, createZip([
    { name: '', rawName: gbkConfig, flags: 1 << 11, contents: 'x' },
  ]));
  assert.throws(
    () => listZipEntryNames(badUtf8FlagZip),
    (error: unknown) => error instanceof PanelError && error.messageKey === 'server.files.zip.entryNameInvalid',
  );
});
