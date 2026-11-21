/**
 * Regression for entry-module detection and data directory resolution when the install path contains a symlink or junction.
 * Uses only random temp directories; touching the repo's data/ is forbidden.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainModule, resolveRealPath } from './real-path.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Creates a real directory and a directory link pointing to it; on Windows a junction is used, which needs no admin rights. */
function prepareLinkedRoot(t: test.TestContext): { real: string; link: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-real-path-test-'));
  t.after(() => {
    // Remove the link itself separately first, so a recursive delete does not follow the link into the target.
    fs.rmSync(path.join(base, 'link'), { force: true });
    fs.rmSync(base, { recursive: true, force: true });
  });
  const real = path.join(base, 'real');
  const link = path.join(base, 'link');
  fs.mkdirSync(real);
  fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  return { real, link };
}

test('a path without links is returned as is, without rewriting drive letters or short names', () => {
  const tmp = os.tmpdir();
  assert.equal(resolveRealPath(tmp), path.resolve(tmp));
});

test('a path through a directory link resolves to the real location, with the nonexistent tail appended as is', (t) => {
  const { real, link } = prepareLinkedRoot(t);
  fs.mkdirSync(path.join(real, 'sub'));
  assert.equal(resolveRealPath(path.join(link, 'sub')), path.join(real, 'sub'));
  assert.equal(
    resolveRealPath(path.join(link, 'missing', 'panel.db')),
    path.join(real, 'missing', 'panel.db'),
  );
});

test('still recognized as the entry module when argv[1] goes through a link', (t) => {
  const { real, link } = prepareLinkedRoot(t);
  fs.writeFileSync(path.join(real, 'entry.js'), '');
  fs.writeFileSync(path.join(real, 'other.js'), '');
  const moduleUrl = pathToFileURL(path.join(real, 'entry.js')).href;
  assert.equal(isMainModule(moduleUrl, path.join(link, 'entry.js')), true);
  assert.equal(isMainModule(moduleUrl, path.join(real, 'entry.js')), true);
  assert.equal(isMainModule(moduleUrl, path.join(link, 'other.js')), false);
  assert.equal(isMainModule(moduleUrl, undefined), false);
});

test('a process started through a linked path runs the entry logic instead of exiting silently', (t) => {
  const { real, link } = prepareLinkedRoot(t);
  const helperUrl = pathToFileURL(path.join(serverRoot, 'src', 'utils', 'real-path.ts')).href;
  fs.writeFileSync(
    path.join(real, 'entry.ts'),
    `import { isMainModule } from ${JSON.stringify(helperUrl)};\n`
      + 'if (isMainModule(import.meta.url)) console.log("main");\n',
  );
  const result = spawnSync(process.execPath, ['--import', 'tsx', path.join(link, 'entry.ts')], {
    cwd: serverRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'main');
});

test('the data directory resolves links only in the parent path, and links at or inside the directory itself are still rejected', async (t) => {
  const { real, link } = prepareLinkedRoot(t);
  process.env.JWT_SECRET = 'a'.repeat(64);
  const { config } = await import('../config.js');
  const { assertSafeInstanceRoot, defaultInstanceDir } = await import('./path.js');

  // Install location under a link: the data directory is switched to the real path, and the instance directory check passes.
  process.env.MYSTRY_DATA_DIR = path.join(link, 'data');
  assert.equal(config.dataDir, path.join(real, 'data'));
  assert.equal(config.backupDir, path.join(real, 'data', 'backups'));
  fs.mkdirSync(path.join(real, 'data', 'instances', 'abc'), { recursive: true });
  assert.equal(assertSafeInstanceRoot(defaultInstanceDir('abc')), path.join(real, 'data', 'instances', 'abc'));

  // The data directory itself is a link: it keeps its name, and the instance directory check still rejects it.
  const dataLink = path.join(real, 'data-link');
  fs.symlinkSync(path.join(real, 'data'), dataLink, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => fs.rmSync(dataLink, { force: true }));
  process.env.MYSTRY_DATA_DIR = dataLink;
  assert.equal(config.dataDir, dataLink);
  assert.throws(
    () => assertSafeInstanceRoot(defaultInstanceDir('abc')),
    (error: unknown) => (error as { messageKey?: string }).messageKey === 'server.files.instanceDirEscapes',
  );
});
