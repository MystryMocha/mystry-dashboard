/**
 * Process inspection decides whether a world is still held by a server the panel lost track of. The parsing tests run
 * everywhere; the rest ask the real operating system about real child processes, because the callers' tests replace
 * all of this module with fakes. A copy of the Node binary named `java` stands in for a Java server.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  captureProcessIdentityAsync,
  inspectTrackedProcess,
  isTimestampBeforeBoot,
  isTrackedProcessPresentSync,
  parseProcStatStartTicks,
  readLinuxProcStartTicksSync,
} from './process-inspect.js';

/** A cold PowerShell start on a CI runner can take longer than the production timeout; that would read as `unknown`. */
const INSPECT_TIMEOUT_MS = 30_000;
const realOsSkip = process.platform === 'win32' || process.platform === 'linux'
  ? false
  : 'only Windows and Linux are inspected in CI';

/** Fields 3 to 22 of a stat line, after the command name; the last one is the start time in clock ticks. */
const STAT_TAIL = 'S 1 4321 4321 0 -1 4194560 2000 0 0 0 150 30 0 0 20 0 42 0 987654';

test('the start time is read from a stat line, also when the command name contains spaces and parentheses', () => {
  assert.equal(parseProcStatStartTicks(`4321 (java) ${STAT_TAIL} 123456 789 18446744073709551615\n`), '987654');
  assert.equal(parseProcStatStartTicks(`4321 (my ) java) ${STAT_TAIL} 123456\n`), '987654');
  assert.equal(parseProcStatStartTicks(`4321 (java) S 1 4321`), null);
  assert.equal(parseProcStatStartTicks('4321 java S 1'), null);
});

test('a timestamp counts as before boot only when it is earlier than the boot time by more than the allowed skew', () => {
  const now = Date.parse('2026-11-27T12:00:00.000Z');
  const uptimeSeconds = 3600;
  const boot = now - uptimeSeconds * 1000;
  const at = (ms: number) => new Date(ms).toISOString();
  assert.equal(isTimestampBeforeBoot(at(boot - 60_000), now, uptimeSeconds), true);
  assert.equal(isTimestampBeforeBoot(at(boot - 1_000), now, uptimeSeconds), false);
  assert.equal(isTimestampBeforeBoot(at(boot + 60_000), now, uptimeSeconds), false);
  assert.equal(isTimestampBeforeBoot('not a date', now, uptimeSeconds), false);
  assert.equal(isTimestampBeforeBoot(at(boot - 60_000), now, Number.NaN), false);
  assert.equal(isTimestampBeforeBoot(at(boot - 60_000), now, -1), false);
});

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

/**
 * Temp directories and idle child processes for one test. The children are ended before the directories are removed:
 * Windows refuses to delete a directory a process runs in, and a child left running keeps the test file from exiting.
 */
function sandbox(t: test.TestContext) {
  const children: ChildProcess[] = [];
  const dirs: string[] = [];
  t.after(async () => {
    await Promise.all(children.map(stop));
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return {
    dir(): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-process-inspect-test-'));
      dirs.push(dir);
      return dir;
    },
    /** Puts the Node binary in `dir` under `name`: a symlink on Linux, whose command name is the link's, or a hard link or copy on Windows. */
    nodeBinaryNamed(dir: string, name: string): string {
      const target = path.join(dir, process.platform === 'win32' ? `${name}.exe` : name);
      if (process.platform === 'win32') {
        try {
          fs.linkSync(process.execPath, target);
        } catch {
          fs.copyFileSync(process.execPath, target);
        }
      } else {
        fs.symlinkSync(process.execPath, target);
      }
      return target;
    },
    async start(executable: string, cwd: string): Promise<ChildProcess & { pid: number }> {
      const child = spawn(executable, ['-e', 'setInterval(() => {}, 1000)'], { cwd, stdio: 'ignore', windowsHide: true });
      children.push(child);
      await once(child, 'spawn');
      assert.ok(typeof child.pid === 'number' && child.pid > 0);
      return child as ChildProcess & { pid: number };
    },
  };
}

test('a process whose start identity still matches is alive, and dead once it exits', { skip: realOsSkip }, async (t) => {
  const box = sandbox(t);
  const child = await box.start(process.execPath, box.dir());
  const identity = await captureProcessIdentityAsync(child.pid, INSPECT_TIMEOUT_MS);
  assert.ok(identity?.startsWith(`${process.platform}:`), `identity: ${identity}`);
  const candidate = { pid: child.pid, startedAt: new Date().toISOString(), processIdentity: identity };

  assert.equal(await inspectTrackedProcess(candidate, INSPECT_TIMEOUT_MS), 'alive');
  assert.equal(isTrackedProcessPresentSync(candidate), true);

  await stop(child);
  assert.equal(await inspectTrackedProcess(candidate, INSPECT_TIMEOUT_MS), 'dead');
  assert.equal(isTrackedProcessPresentSync(candidate), false);
});

test('a PID that now belongs to a process with another start identity is dead', { skip: realOsSkip }, async (t) => {
  const box = sandbox(t);
  const child = await box.start(process.execPath, box.dir());
  const startedAt = new Date().toISOString();
  const recycled = process.platform === 'linux' ? `linux:${'0'.repeat(8)}:1` : 'win32:1';
  assert.equal(
    await inspectTrackedProcess({ pid: child.pid, startedAt, processIdentity: recycled }, INSPECT_TIMEOUT_MS),
    'dead',
  );
  // An identity recorded on another system can never be checked here.
  const foreign = process.platform === 'linux' ? 'win32:1' : 'linux:boot:1';
  assert.equal(
    await inspectTrackedProcess({ pid: child.pid, startedAt, processIdentity: foreign }, INSPECT_TIMEOUT_MS),
    'dead',
  );
  assert.equal(isTrackedProcessPresentSync({ pid: child.pid, startedAt, processIdentity: foreign }), false);
});

test('the panel process itself is never taken for a tracked server', async () => {
  const candidate = { pid: process.pid, startedAt: new Date().toISOString(), processIdentity: null };
  assert.equal(await inspectTrackedProcess(candidate, INSPECT_TIMEOUT_MS), 'dead');
  assert.equal(isTrackedProcessPresentSync(candidate), false);
});

test('without a recorded identity, a Java process started at the recorded time in the instance directory is alive', { skip: realOsSkip }, async (t) => {
  const box = sandbox(t);
  const dir = box.dir();
  const startedAt = new Date().toISOString();
  const child = await box.start(box.nodeBinaryNamed(dir, 'java'), dir);
  assert.equal(
    await inspectTrackedProcess({ pid: child.pid, startedAt, processIdentity: null, cwd: dir }, INSPECT_TIMEOUT_MS),
    'alive',
  );
});

test('without a recorded identity, a PID now held by a program other than Java is dead', { skip: realOsSkip }, async (t) => {
  const box = sandbox(t);
  const dir = box.dir();
  const startedAt = new Date().toISOString();
  const child = await box.start(box.nodeBinaryNamed(dir, 'other'), dir);
  assert.equal(
    await inspectTrackedProcess({ pid: child.pid, startedAt, processIdentity: null, cwd: dir }, INSPECT_TIMEOUT_MS),
    'dead',
  );
});

test('on Windows, without a recorded identity, a Java process started well after the recorded run is dead', {
  skip: process.platform === 'win32' ? false : 'Windows compares start times; Linux compares the working directory',
}, async (t) => {
  const box = sandbox(t);
  const dir = box.dir();
  const startedAt = new Date(Date.now() - 120_000).toISOString();
  const child = await box.start(box.nodeBinaryNamed(dir, 'java'), dir);
  assert.equal(
    await inspectTrackedProcess({ pid: child.pid, startedAt, processIdentity: null }, INSPECT_TIMEOUT_MS),
    'dead',
  );
});

test('on Linux, without a recorded identity, a Java process in another directory is dead', {
  skip: process.platform === 'linux' ? false : 'Linux compares the working directory; Windows compares start times',
}, async (t) => {
  const box = sandbox(t);
  const dir = box.dir();
  const elsewhere = box.dir();
  const startedAt = new Date().toISOString();
  const child = await box.start(box.nodeBinaryNamed(dir, 'java'), elsewhere);
  assert.equal(
    await inspectTrackedProcess({ pid: child.pid, startedAt, processIdentity: null, cwd: dir }, INSPECT_TIMEOUT_MS),
    'dead',
  );
  assert.match(readLinuxProcStartTicksSync(child.pid) ?? '', /^\d+$/);
});
