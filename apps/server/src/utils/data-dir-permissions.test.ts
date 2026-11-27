/**
 * Data directory Unix permission regression.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('a new directory should be 0700 on Unix', { skip: process.platform === 'win32' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-data-perm-new-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { ensureSecureDirectory } = await import('./data-dir-permissions.js');
  const nested = path.join(root, 'instances');
  ensureSecureDirectory(nested);
  const mode = fs.statSync(nested).mode & 0o777;
  assert.equal(mode, 0o700);
});

test('forceSecureSensitiveFile should tighten a new file to 0600 immediately', { skip: process.platform === 'win32' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-data-perm-force-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = path.join(root, 'panel.db');
  fs.writeFileSync(file, 'db');
  const { forceSecureSensitiveFile } = await import('./data-dir-permissions.js');
  forceSecureSensitiveFile(file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('overly permissive permissions should refuse startup', { skip: process.platform === 'win32' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-data-perm-bad-'));
  t.after(() => {
    delete process.env.MYSTRY_REPAIR_DATA_PERMISSIONS;
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.chmodSync(root, 0o755);
  const { ensureSecureDirectory, DataDirPermissionError } = await import('./data-dir-permissions.js');
  assert.throws(() => ensureSecureDirectory(root), DataDirPermissionError);
  process.env.MYSTRY_REPAIR_DATA_PERMISSIONS = '1';
  ensureSecureDirectory(root);
  const mode = fs.statSync(root).mode & 0o777;
  assert.equal(mode, 0o700);
});

test('Unix owner mismatch error explains both uids and how to recover with chown', async () => {
  const { formatUnixOwnerMismatch } = await import('./data-dir-permissions.js');
  const message = formatUnixOwnerMismatch('/opt/mystry/data', 0, 1001);
  assert.match(message, /uid 0/);
  assert.match(message, /1001/);
  assert.match(message, /\/opt\/mystry\/data/);
  assert.match(message, /chown/);
});
