/**
 * Backup archive read/write regression: round-trip consistency, tamper detection, and rejection of unsafe and reserved paths.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';

process.env.JWT_SECRET = 'a'.repeat(64);
process.env.SETUP_TOKEN = 'b'.repeat(64);
process.env.LAUNCHER_TOKEN = 'c'.repeat(64);

const limits = { maxEntries: 1_000, maxBytes: 64 * 1024 * 1024 };
const header = {
  createdAt: '2026-10-26T00:00:00.000Z',
  instance: { id: 'abcdefghijkl', name: '测试服', coreType: null, mcVersion: '1.21.1', jarFile: 'server.jar' },
  wasRunning: false,
};

function tempRoot(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-backup-archive-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Hand-writes a ustar header, to build malicious archives the writer would never produce. */
function tarHeader(name: string, size: number, type = '0'): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  block.write('0000644\0', 100);
  block.write('0000000\0', 108);
  block.write('0000000\0', 116);
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  block.write('00000000000\0', 136);
  block.fill(0x20, 148, 156);
  block.write(type, 156);
  block.write('ustar\0', 257);
  block.write('00', 263);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return block;
}

function tarFile(name: string, contents: string, type = '0'): Buffer {
  const data = Buffer.from(contents);
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([tarHeader(name, data.length, type), data, padding]);
}

async function writeFixture(root: string) {
  const { writeBackupArchive } = await import('./backup-archive.js');
  const source = path.join(root, 'source');
  const longDir = `world/${'region-'.repeat(20)}`;
  fs.mkdirSync(path.join(source, longDir), { recursive: true });
  fs.writeFileSync(path.join(source, 'server.properties'), 'motd=hello\n');
  fs.writeFileSync(path.join(source, 'empty.txt'), '');
  fs.writeFileSync(path.join(source, longDir, 'r.0.0.mca'), Buffer.alloc(70_000, 7));
  const file = (relative: string) => {
    const absolute = path.join(source, ...relative.split('/'));
    const stat = fs.statSync(absolute);
    return { kind: 'file' as const, path: relative, absolute, size: stat.size, mtimeMs: stat.mtimeMs };
  };
  const archive = path.join(root, 'backup.tar.gz');
  const written = await writeBackupArchive({
    output: archive,
    entries: [
      file('empty.txt'),
      file('server.properties'),
      { kind: 'dir', path: 'world', mtimeMs: Date.now() },
      { kind: 'dir', path: longDir, mtimeMs: Date.now() },
      file(`${longDir}/r.0.0.mca`),
    ],
    header,
    signal: new AbortController().signal,
  });
  return { archive, written, longDir };
}

const hasKey = (key: string) => (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { messageKey?: string }).messageKey === key;

test('file contents, empty files and overlong paths survive a backup archive round trip', async (t) => {
  const root = tempRoot(t);
  const { readBackupArchive } = await import('./backup-archive.js');
  const { archive, written, longDir } = await writeFixture(root);

  assert.equal(written.manifest.files.length, 3);

  const destination = path.join(root, 'restored');
  fs.mkdirSync(destination);
  const result = await readBackupArchive({ archive, limits, signal: new AbortController().signal, destination });
  assert.equal(result.fileCount, 3);
  // The whole-archive digest computed along the way while reading should match the one from writing, and the file itself.
  assert.equal(result.archiveBytes, written.sizeBytes);
  assert.equal(result.archiveSha256, written.sha256);
  assert.equal(result.archiveBytes, fs.statSync(archive).size);
  assert.equal(result.manifest.instance.name, '测试服');
  assert.equal(fs.readFileSync(path.join(destination, 'server.properties'), 'utf8'), 'motd=hello\n');
  assert.equal(fs.statSync(path.join(destination, 'empty.txt')).size, 0);
  assert.deepEqual(fs.readFileSync(path.join(destination, longDir, 'r.0.0.mca')), Buffer.alloc(70_000, 7));
  assert.equal(fs.existsSync(path.join(destination, '.mystry-backup')), false);
});

test('tampered file content is rejected by checksum', async (t) => {
  const root = tempRoot(t);
  const { readBackupArchive } = await import('./backup-archive.js');
  const { archive } = await writeFixture(root);
  const tar = gunzipSync(fs.readFileSync(archive));
  const offset = tar.indexOf(Buffer.from('motd=hello'));
  assert.ok(offset > 0);
  tar[offset] = 'M'.charCodeAt(0);
  const tampered = path.join(root, 'tampered.tar.gz');
  fs.writeFileSync(tampered, gzipSync(tar));
  await assert.rejects(
    readBackupArchive({ archive: tampered, limits, signal: new AbortController().signal }),
    hasKey('server.backups.archive.checksumMismatch'),
  );
});

test('a truncated or non-gzip file is treated as corrupted', async (t) => {
  const root = tempRoot(t);
  const { readBackupArchive } = await import('./backup-archive.js');
  const { archive } = await writeFixture(root);
  const truncated = path.join(root, 'truncated.tar.gz');
  const bytes = fs.readFileSync(archive);
  fs.writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.length / 2)));
  await assert.rejects(
    readBackupArchive({ archive: truncated, limits, signal: new AbortController().signal }),
    hasKey('server.backups.archive.corrupted'),
  );
  const garbage = path.join(root, 'garbage.tar.gz');
  fs.writeFileSync(garbage, 'not a backup');
  await assert.rejects(
    readBackupArchive({ archive: garbage, limits, signal: new AbortController().signal }),
    hasKey('server.backups.archive.corrupted'),
  );
});

test('archives with path traversal, link entries, panel-reserved files or a missing manifest are rejected', async (t) => {
  const root = tempRoot(t);
  const { readBackupArchive } = await import('./backup-archive.js');
  const end = Buffer.alloc(1024);
  const cases: Array<[string, Buffer, string]> = [
    ['traversal', tarFile('../evil.txt', 'x'), 'server.backups.archive.unsafePath'],
    ['absolute', tarFile('/etc/passwd', 'x'), 'server.backups.archive.unsafePath'],
    ['symlink', tarFile('link', '', '2'), 'server.backups.archive.unsupportedEntry'],
    ['marker', tarFile('.mystry-instance.json', '{}'), 'server.backups.archive.reservedPath'],
    ['noManifest', tarFile('server.properties', 'motd=x'), 'server.backups.archive.manifestMissing'],
  ];
  for (const [name, entry, key] of cases) {
    const archive = path.join(root, `${name}.tar.gz`);
    fs.writeFileSync(archive, gzipSync(Buffer.concat([entry, end])));
    const destination = path.join(root, `${name}-out`);
    fs.mkdirSync(destination);
    await assert.rejects(
      readBackupArchive({ archive, limits, signal: new AbortController().signal, destination }),
      hasKey(key),
      name,
    );
    assert.equal(fs.existsSync(path.join(root, 'evil.txt')), false);
  }
});

test('exceeding the entry count limit is rejected', async (t) => {
  const root = tempRoot(t);
  const { readBackupArchive } = await import('./backup-archive.js');
  const { archive } = await writeFixture(root);
  await assert.rejects(
    readBackupArchive({ archive, limits: { maxEntries: 2, maxBytes: limits.maxBytes }, signal: new AbortController().signal }),
    hasKey('server.backups.archive.tooManyEntries'),
  );
});

test('files that grow between scan and read (including 0-byte files) abort the backup instead of being truncated', async (t) => {
  const root = tempRoot(t);
  const { writeBackupArchive } = await import('./backup-archive.js');
  const source = path.join(root, 'source');
  fs.mkdirSync(source, { recursive: true });

  // Case 1: non-empty file grows after scan.
  const propFile = path.join(source, 'server.properties');
  fs.writeFileSync(propFile, 'motd=old\n');
  const propScan = fs.statSync(propFile);
  fs.appendFileSync(propFile, 'max-players=50\n');
  await assert.rejects(
    writeBackupArchive({
      output: path.join(root, 'grown.tar.gz'),
      entries: [{ kind: 'file', path: 'server.properties', absolute: propFile, size: propScan.size, mtimeMs: propScan.mtimeMs }],
      header,
      signal: new AbortController().signal,
    }),
    hasKey('server.backups.fileChanged'),
  );

  // Case 2: 0-byte file at scan time receives data before archiving.
  const emptyFile = path.join(source, 'empty.txt');
  fs.writeFileSync(emptyFile, '');
  const emptyScan = fs.statSync(emptyFile);
  fs.writeFileSync(emptyFile, 'written-later\n');
  await assert.rejects(
    writeBackupArchive({
      output: path.join(root, 'grown-from-empty.tar.gz'),
      entries: [{ kind: 'file', path: 'empty.txt', absolute: emptyFile, size: emptyScan.size, mtimeMs: emptyScan.mtimeMs }],
      header,
      signal: new AbortController().signal,
    }),
    hasKey('server.backups.fileChanged'),
  );
});

test('files appended or atomically replaced while being read abort the backup with fileChanged', async (t) => {
  const root = tempRoot(t);
  const { writeBackupArchive } = await import('./backup-archive.js');
  const source = path.join(root, 'source');
  fs.mkdirSync(source, { recursive: true });

  // Case 1: multi-chunk file grows after the first chunk is read.
  const growing = path.join(source, 'region.mca');
  fs.writeFileSync(growing, Buffer.alloc(140 * 1024, 1));
  const growingScan = fs.statSync(growing);
  const originalOpen = fs.promises.open.bind(fs.promises);
  let appended = false;
  const openMock = t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await originalOpen(...args);
    if (path.resolve(String(args[0])) === path.resolve(growing)) {
      const originalRead = handle.read.bind(handle);
      handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
        const result = await originalRead(...readArgs);
        if (!appended) {
          appended = true;
          fs.appendFileSync(growing, 'extra-tail-bytes');
        }
        return result;
      }) as typeof handle.read;
    }
    return handle;
  });
  try {
    await assert.rejects(
      writeBackupArchive({
        output: path.join(root, 'grown-mid-read.tar.gz'),
        entries: [{ kind: 'file', path: 'region.mca', absolute: growing, size: growingScan.size, mtimeMs: growingScan.mtimeMs }],
        header,
        signal: new AbortController().signal,
      }),
      hasKey('server.backups.fileChanged'),
    );
  } finally {
    openMock.mock.restore();
  }

  // Case 2: file is overwritten in place with same-length different content while open (e.g. a text save that could not replace the file by a rename).
  const overwritten = path.join(source, 'config.yml');
  fs.writeFileSync(overwritten, 'mode: safe\n');
  const overwrittenScan = fs.statSync(overwritten);
  let didOverwrite = false;
  const overwriteMock = t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await originalOpen(...args);
    if (path.resolve(String(args[0])) === path.resolve(overwritten)) {
      const originalRead = handle.read.bind(handle);
      handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
        const result = await originalRead(...readArgs);
        if (!didOverwrite) {
          didOverwrite = true;
          fs.writeFileSync(overwritten, 'mode: new!\n');
          const bumped = new Date(overwrittenScan.mtimeMs + 2_000);
          fs.utimesSync(overwritten, bumped, bumped);
        }
        return result;
      }) as typeof handle.read;
    }
    return handle;
  });
  try {
    await assert.rejects(
      writeBackupArchive({
        output: path.join(root, 'overwritten-mid-read.tar.gz'),
        entries: [{ kind: 'file', path: 'config.yml', absolute: overwritten, size: overwrittenScan.size, mtimeMs: overwrittenScan.mtimeMs }],
        header,
        signal: new AbortController().signal,
      }),
      hasKey('server.backups.fileChanged'),
    );
  } finally {
    overwriteMock.mock.restore();
  }

  // Case 3 (Unix): file is atomically replaced via rename with a new inode while open (Windows forbids renaming over an open handle).
  if (process.platform !== 'win32') {
    const replaced = path.join(source, 'replaced.yml');
    fs.writeFileSync(replaced, 'mode: safe\n');
    const replacedScan = fs.statSync(replaced);
    let didReplace = false;
    const replaceMock = t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await originalOpen(...args);
      if (path.resolve(String(args[0])) === path.resolve(replaced)) {
        const originalRead = handle.read.bind(handle);
        handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
          const result = await originalRead(...readArgs);
          if (!didReplace) {
            didReplace = true;
            const temp = path.join(source, 'replaced.yml.tmp');
            fs.writeFileSync(temp, 'mode: new!\n');
            fs.renameSync(temp, replaced);
          }
          return result;
        }) as typeof handle.read;
      }
      return handle;
    });
    try {
      await assert.rejects(
        writeBackupArchive({
          output: path.join(root, 'replaced-mid-read.tar.gz'),
          entries: [{ kind: 'file', path: 'replaced.yml', absolute: replaced, size: replacedScan.size, mtimeMs: replacedScan.mtimeMs }],
          header,
          signal: new AbortController().signal,
        }),
        hasKey('server.backups.fileChanged'),
      );
    } finally {
      replaceMock.mock.restore();
    }
  }
});
