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

test('a lock whose PID was recycled by the new process itself or predates OS boot is quarantined and taken over', async (t) => {
  const { acquirePanelDataLock, isPanelLockOwnerStale } = await import('./data-lock-service.js');

  // Case 1: owner.json carries process.pid from an earlier process that did not unlock (not in activeLocks).
  const rootSelfPid = prepareTempDataRoot(t);
  const lockDirSelf = path.join(rootSelfPid, '.mystry-panel-lock');
  fs.mkdirSync(lockDirSelf, { recursive: true });
  fs.writeFileSync(
    path.join(lockDirSelf, 'owner.json'),
    `${JSON.stringify({
      pid: process.pid,
      fingerprint: 'prior-process-fingerprint',
      version: '0.0.0',
      createdAt: new Date().toISOString(),
    })}\n`,
    'utf8',
  );
  const acquiredSelf = acquirePanelDataLock(rootSelfPid);
  assert.equal(acquiredSelf.owner.pid, process.pid);
  assert.notEqual(acquiredSelf.owner.fingerprint, 'prior-process-fingerprint');
  acquiredSelf.release();

  // Case 2: owner.pid belongs to a live PID (e.g. a system process returning EPERM), but lock createdAt predates boot.
  const rootPreBoot = prepareTempDataRoot(t);
  const lockDirPreBoot = path.join(rootPreBoot, '.mystry-panel-lock');
  fs.mkdirSync(lockDirPreBoot, { recursive: true });
  fs.writeFileSync(
    path.join(lockDirPreBoot, 'owner.json'),
    `${JSON.stringify({
      pid: 4,
      fingerprint: 'pre-boot-fingerprint',
      version: '0.0.0',
      createdAt: new Date(Date.now() - os.uptime() * 1000 - 60_000).toISOString(),
    })}\n`,
    'utf8',
  );
  const acquiredPreBoot = acquirePanelDataLock(rootPreBoot, { isAlive: () => true });
  assert.equal(acquiredPreBoot.owner.pid, process.pid);
  assert.ok(fs.readdirSync(rootPreBoot).some((name) => name.startsWith('.mystry-panel-lock.quarantine.')));
  acquiredPreBoot.release();

  // Case 3: Different Linux bootId -> stale even with a live PID and recent wall-clock time; same boot with live PID -> conflict.
  const fakeDir = path.join(rootPreBoot, '.mystry-panel-lock');
  const recentIso = new Date(Date.now() - 1_000).toISOString();
  assert.equal(
    isPanelLockOwnerStale(
      { pid: 12345, fingerprint: 'other', version: '0.0.0', createdAt: recentIso, bootId: 'boot-old' },
      fakeDir,
      { bootId: 'boot-new', isAlive: () => true, uptimeSeconds: () => 3600 },
    ),
    true,
  );
  assert.equal(
    isPanelLockOwnerStale(
      { pid: 12345, fingerprint: 'other', version: '0.0.0', createdAt: recentIso, bootId: 'boot-same' },
      fakeDir,
      { bootId: 'boot-same', isAlive: () => true, uptimeSeconds: () => 3600 },
    ),
    false,
  );
});
