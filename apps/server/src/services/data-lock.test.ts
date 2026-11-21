/**
 * Data directory lifecycle lock regression.
 * A random temp DATA_DIR must be used; touching the repo's data/ is forbidden.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function prepareTempDataRoot(t: test.TestContext): string {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-data-lock-test-'));
  t.after(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });
  process.env.MYSTRY_DATA_DIR = dataRoot;
  process.env.JWT_SECRET = 'a'.repeat(64);
  return dataRoot;
}

test('a second panel process must not write to the database before entering initDb', async (t) => {
  const dataRoot = prepareTempDataRoot(t);
  const { acquirePanelDataLock } = await import('./data-lock-service.js');
  const first = acquirePanelDataLock(dataRoot);
  assert.throws(
    () => acquirePanelDataLock(dataRoot),
    /数据目录|已有面板|锁/,
    '存活锁持有者应拒绝第二个进程',
  );
  first.release();
  const second = acquirePanelDataLock(dataRoot);
  second.release();
});

test('the lock directory should be 0700 and owner.json 0600', { skip: process.platform === 'win32' }, async (t) => {
  const dataRoot = prepareTempDataRoot(t);
  const { acquirePanelDataLock } = await import('./data-lock-service.js');
  const lock = acquirePanelDataLock(dataRoot);
  t.after(() => lock.release());
  const lockDir = path.join(dataRoot, '.mystry-panel-lock');
  assert.equal(fs.statSync(lockDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(lockDir, 'owner.json')).mode & 0o777, 0o600);
});

test('a stale lock can be quarantined and taken over only when the original PID no longer exists', async (t) => {
  const dataRoot = prepareTempDataRoot(t);
  const lockDir = path.join(dataRoot, '.mystry-panel-lock');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    path.join(lockDir, 'owner.json'),
    `${JSON.stringify({
      pid: 9_999_999,
      fingerprint: 'stale-test',
      version: '0.0.0',
      createdAt: new Date(0).toISOString(),
    })}\n`,
    'utf8',
  );

  const { acquirePanelDataLock } = await import('./data-lock-service.js');
  const lock = acquirePanelDataLock(dataRoot);
  assert.ok(fs.existsSync(path.join(lockDir, 'owner.json')));
  assert.equal(lock.owner.pid, process.pid);
  const quarantined = fs.readdirSync(dataRoot).some((name) => name.startsWith('.mystry-panel-lock.quarantine.'));
  assert.ok(quarantined, '陈旧锁应移入 quarantine 目录');
  lock.release();
});
