/**
 * Data directory lifecycle lock regression.
 * A random temp DATA_DIR must be used; touching the repo's data/ is forbidden.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LOCK_DIR = '.mystry-panel-lock';
const LOCK_DB = '.mystry-panel-lock.db';
const CONFLICT = /数据目录已被其他面板进程占用/;

function prepareTempDataRoot(t: test.TestContext): string {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-data-lock-test-'));
  t.after(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  process.env.MYSTRY_DATA_DIR = dataRoot;
  process.env.JWT_SECRET = 'a'.repeat(64);
  return dataRoot;
}

function writeLeftoverOwner(dataRoot: string, owner: { pid: number; createdAt: string; lock?: 'sqlite' }): void {
  const lockDir = path.join(dataRoot, LOCK_DIR);
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    path.join(lockDir, 'owner.json'),
    `${JSON.stringify({ fingerprint: 'leftover', version: '0.0.0', ...owner })}\n`,
    'utf8',
  );
}

/** Starts another process that takes the lock through the real service and holds it until killed. */
async function spawnLockHolder(t: test.TestContext, dataRoot: string): Promise<ChildProcess> {
  const serviceUrl = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'data-lock-service.ts')).href;
  const script = `import(${JSON.stringify(serviceUrl)}).then(({ acquirePanelDataLock }) => {
    // Referenced for the life of the process: a lock object that becomes garbage has its connection closed.
    globalThis.heldLock = acquirePanelDataLock(process.env.MYSTRY_DATA_DIR);
    process.stdout.write('held\\n');
    setInterval(() => {}, 1000);
  }).catch((error) => { process.stdout.write('failed ' + error.message + '\\n'); process.exit(1); });`;
  const child = spawn(process.execPath, ['--no-warnings', '--experimental-sqlite', '--import', 'tsx', '-e', script], {
    env: { ...process.env, MYSTRY_DATA_DIR: dataRoot, MYSTRY_CONFIG_PATH: path.join(dataRoot, 'none.env') },
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  });
  t.after(() => {
    child.kill('SIGKILL');
  });
  const firstLine = await new Promise<string>((resolve, reject) => {
    let output = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      output += chunk;
      if (output.includes('\n')) resolve(output.trim());
    });
    child.once('exit', (code) => reject(new Error(`lock holder exited early with code ${code}: ${output}`)));
  });
  assert.equal(firstLine, 'held');
  return child;
}

test('a second panel process must not write to the database before entering initDb', async (t) => {
  const dataRoot = prepareTempDataRoot(t);
  const { acquirePanelDataLock } = await import('./data-lock-service.js');
  const first = acquirePanelDataLock(dataRoot);
  assert.throws(() => acquirePanelDataLock(dataRoot), CONFLICT, '存活锁持有者应拒绝第二个进程');
  first.release();
  assert.equal(fs.existsSync(path.join(dataRoot, LOCK_DIR)), false, '释放后应清除诊断目录');
  const second = acquirePanelDataLock(dataRoot);
  second.release();
});

test('the lock directory should be 0700, owner.json and the lock database 0600', { skip: process.platform === 'win32' }, async (t) => {
  const dataRoot = prepareTempDataRoot(t);
  const { acquirePanelDataLock } = await import('./data-lock-service.js');
  const lock = acquirePanelDataLock(dataRoot);
  t.after(() => lock.release());
  const lockDir = path.join(dataRoot, LOCK_DIR);
  assert.equal(fs.statSync(lockDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(lockDir, 'owner.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dataRoot, LOCK_DB)).mode & 0o777, 0o600);
});

test('a leftover owner record never blocks startup, even when its PID is alive and its timestamp is fresh', async (t) => {
  const dataRoot = prepareTempDataRoot(t);
  // The parent test runner is alive and is not this process: exactly what a recycled PID looks like after a crash.
  writeLeftoverOwner(dataRoot, { pid: process.ppid, createdAt: new Date().toISOString(), lock: 'sqlite' });

  const { acquirePanelDataLock } = await import('./data-lock-service.js');
  const lock = acquirePanelDataLock(dataRoot);
  const owner = JSON.parse(fs.readFileSync(path.join(dataRoot, LOCK_DIR, 'owner.json'), 'utf8')) as { pid: number };
  assert.equal(owner.pid, process.pid);
  assert.equal(lock.owner.pid, process.pid);
  lock.release();
});

test('a live panel from a release that only held the lock directory still keeps the data directory', async (t) => {
  const dataRoot = prepareTempDataRoot(t);
  const { acquirePanelDataLock } = await import('./data-lock-service.js');

  // Alive in this boot (the parent test runner stands in for the older panel): refused, and its record is left alone.
  writeLeftoverOwner(dataRoot, { pid: process.ppid, createdAt: new Date().toISOString() });
  assert.throws(() => acquirePanelDataLock(dataRoot), /旧版面板进程占用[\s\S]*记录 PID/);
  const kept = JSON.parse(fs.readFileSync(path.join(dataRoot, LOCK_DIR, 'owner.json'), 'utf8')) as { pid: number };
  assert.equal(kept.pid, process.ppid);

  // Its PID is gone, or the record predates this boot: the directory is stale and is taken over.
  for (const leftover of [
    { pid: 9_999_999, createdAt: new Date().toISOString() },
    { pid: process.ppid, createdAt: new Date(0).toISOString() },
  ]) {
    writeLeftoverOwner(dataRoot, leftover);
    const lock = acquirePanelDataLock(dataRoot);
    const owner = JSON.parse(fs.readFileSync(path.join(dataRoot, LOCK_DIR, 'owner.json'), 'utf8')) as { pid: number; lock?: string };
    assert.deepEqual({ pid: owner.pid, lock: owner.lock }, { pid: process.pid, lock: 'sqlite' });
    lock.release();
  }
});

test('a lock held by another live process is refused whatever the owner record says, and is free once that process dies', async (t) => {
  const dataRoot = prepareTempDataRoot(t);
  const holder = await spawnLockHolder(t, dataRoot);
  const { acquirePanelDataLock } = await import('./data-lock-service.js');

  assert.throws(() => acquirePanelDataLock(dataRoot), new RegExp(`记录 PID：${holder.pid}`));

  // A record that looks ancient, or names a dead PID, used to let a second panel take over a live one.
  writeLeftoverOwner(dataRoot, { pid: 9_999_999, createdAt: new Date(0).toISOString() });
  assert.throws(() => acquirePanelDataLock(dataRoot), CONFLICT);

  // Killed without any chance to clean up: the operating system releases the lock, the stale record stays behind.
  const exited = new Promise((resolve) => holder.once('exit', resolve));
  holder.kill('SIGKILL');
  await exited;
  assert.ok(fs.existsSync(path.join(dataRoot, LOCK_DIR, 'owner.json')));
  const lock = acquirePanelDataLock(dataRoot);
  assert.equal(lock.owner.pid, process.pid);
  lock.release();
});
