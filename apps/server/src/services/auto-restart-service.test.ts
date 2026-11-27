/**
 * Restarting a server after it crashes: when a restart is scheduled, counted, given up, refused and cancelled.
 */
import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { AutoRestartSettings, InstanceInfo } from '@mystry/shared';
import type { InstanceRow } from '../db.js';

const DONE_LINE = '[13:23:09] [Server thread/INFO]: Done (4.512s)! For help, type "help"\n';
const START = Date.parse('2026-01-01T00:00:00.000Z');

function prepareTempDataRoot(t: test.TestContext): string {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-auto-restart-test-'));
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

function fakeChild(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, {
    pid: Math.floor(Math.random() * 100_000) + 10_000,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: () => true,
  });
  setImmediate(() => child.emit('spawn'));
  return child;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function manualClock() {
  let now = START;
  let nextHandle = 0;
  const timers = new Map<number, { at: number; run: () => Promise<void> }>();
  return {
    now: () => now,
    setTimer(run: () => Promise<void>, delayMs: number): number {
      nextHandle += 1;
      timers.set(nextHandle, { at: now + delayMs, run });
      return nextHandle;
    },
    clearTimer(handle: unknown): void {
      timers.delete(handle as number);
    },
    waiting: () => timers.size,
    /** Moves time forward, runs the timers that came due and waits for each restart attempt to finish. */
    async advance(ms: number): Promise<void> {
      now += ms;
      for (const [handle, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(handle);
        await timer.run();
      }
    },
  };
}

/** One instance, the setting switched on, its own ProcessManager with stub children, and a restart service on a manual clock. */
async function setup(t: test.TestContext, overrides: Partial<AutoRestartSettings> = {}) {
  prepareTempDataRoot(t);
  const { ProcessManager } = await import('./process-manager.js');
  const { AutoRestartService } = await import('./auto-restart-service.js');
  const { initDb, getDb } = await import('../db.js');
  const { createInstance, getInstanceRow, updateInstance } = await import('./instance-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const info = createInstance({ name: 'auto-restart' });
  const jar = path.join(defaultInstanceDir(info.id), 'server.jar');
  fs.writeFileSync(jar, 'stub-jar');
  const settings: AutoRestartSettings = { enabled: true, delaySeconds: 10, maxAttempts: 3, windowMinutes: 10, ...overrides };

  const children: ChildProcessWithoutNullStreams[] = [];
  const spawnArgs: string[][] = [];
  const manager = new ProcessManager(
    (_command, args) => {
      const child = fakeChild();
      children.push(child);
      spawnArgs.push([...args]);
      return child;
    },
    async () => 'java',
  );
  const clock = manualClock();
  const service = new AutoRestartService({
    processManager: manager,
    loadSettings: () => ({ ...settings }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  service.attach();
  t.after(() => service.detach());

  const latest = () => children[children.length - 1];
  const ready = async () => {
    latest().stdout.emit('data', Buffer.from(DONE_LINE));
    await flush();
  };
  const start = () => manager.start(getInstanceRow(info.id)! as InstanceRow);
  return {
    id: info.id,
    jar,
    manager,
    service,
    clock,
    children,
    spawnArgs,
    getDb,
    updateInstance,
    /** The saved setting; change it in place to act as a save from the settings page. */
    settings,
    start,
    ready,
    exit: (code: number) => latest().emit('exit', code, null),
    /** Runs the server until it has finished starting, then lets it die with an error. */
    async crashAfterReady() {
      if (!manager.isRunning(info.id)) await start();
      await ready();
      latest().emit('exit', 1, null);
    },
  };
}

test('a crash after the server finished starting is restarted after the saved delay, with the instance record read again', async (t) => {
  const s = await setup(t);
  await s.start();
  await s.ready();
  assert.equal(s.service.getState(s.id), null);

  s.exit(1);
  assert.equal(s.manager.getStatus(s.id), 'crashed');
  assert.deepEqual(s.service.getState(s.id), {
    state: 'scheduled',
    attempt: 1,
    max: 3,
    at: new Date(START + 10_000).toISOString(),
    remainingMs: 10_000,
  });

  // The start reads the settings saved by then, as a start from the UI would.
  s.updateInstance(s.id, { jvmArgs: '-Xms1G -Xmx3G' });
  await s.clock.advance(9_999);
  assert.equal(s.children.length, 1, 'not before the delay is over');
  const waiting = s.service.getState(s.id);
  assert.equal(waiting?.state === 'scheduled' && waiting.remainingMs, 1);
  await s.clock.advance(1);
  assert.equal(s.children.length, 2);
  assert.ok(s.spawnArgs[1].includes('-Xmx3G'), s.spawnArgs[1].join(' '));
  assert.equal(s.manager.isRunning(s.id), true);
  assert.equal(s.service.getState(s.id), null);
  assert.equal(s.clock.waiting(), 0);
});

test('a waiting restart keeps the delay and the limit saved at the crash; changed settings apply from the next one', async (t) => {
  const s = await setup(t, { delaySeconds: 30, maxAttempts: 5 });
  await s.crashAfterReady();
  Object.assign(s.settings, { delaySeconds: 5, maxAttempts: 2 });
  const waiting = s.service.getState(s.id);
  assert.equal(waiting?.max, 5);
  assert.equal(waiting?.state === 'scheduled' && waiting.remainingMs, 30_000);
  await s.clock.advance(29_999);
  assert.equal(s.children.length, 1);
  await s.clock.advance(1);
  assert.equal(s.children.length, 2);

  await s.crashAfterReady();
  const next = s.service.getState(s.id);
  assert.equal(next?.attempt, 2);
  assert.equal(next?.max, 2);
  assert.equal(next?.state === 'scheduled' && next.remainingMs, 5_000);
});

test('a crash while starting, diagnosed or not, a clean exit and a crash with the setting off are left alone', async (t) => {
  const s = await setup(t);
  await s.start();
  s.exit(1);
  assert.equal(s.manager.getStatus(s.id), 'crashed');
  assert.equal(s.service.getState(s.id), null, 'died before it finished starting');

  await s.start();
  s.children[1].stderr.emit('data', Buffer.from(
    'java.lang.ClassCastException: class jdk.internal.loader.ClassLoaders$AppClassLoader cannot be cast to class java.net.URLClassLoader\n',
  ));
  await flush();
  s.exit(1);
  assert.equal(s.manager.getStartIssue(s.id)?.kind, 'java-too-new');
  assert.equal(s.service.getState(s.id), null, 'a diagnosed failure is one that happened while starting');

  await s.start();
  await s.ready();
  s.exit(0);
  assert.equal(s.manager.getStatus(s.id), 'stopped');
  assert.equal(s.service.getState(s.id), null);

  s.settings.enabled = false;
  await s.crashAfterReady();
  assert.equal(s.service.getState(s.id), null);
  assert.equal(s.clock.waiting(), 0);
});

test('the fourth crash in a row leaves the server crashed, and a start by the user begins the count again', async (t) => {
  const s = await setup(t);
  for (const attempt of [1, 2, 3]) {
    await s.crashAfterReady();
    assert.equal(s.service.getState(s.id)?.attempt, attempt);
    await s.clock.advance(10_000);
    assert.equal(s.children.length, attempt + 1);
  }

  await s.crashAfterReady();
  assert.deepEqual(s.service.getState(s.id), {
    state: 'gaveUp',
    attempt: 3,
    max: 3,
    at: new Date(s.clock.now()).toISOString(),
    windowMinutes: 10,
  });
  assert.equal(s.clock.waiting(), 0);
  await s.clock.advance(3_600_000);
  assert.equal(s.children.length, 4, 'nothing starts until the user does');

  await s.start();
  assert.equal(s.service.getState(s.id), null);
  await s.crashAfterReady();
  assert.equal(s.service.getState(s.id)?.attempt, 1);
});

test('a server that crashes every four minutes is restarted three times and then stays crashed', async (t) => {
  const s = await setup(t);
  for (const attempt of [1, 2, 3]) {
    await s.crashAfterReady();
    assert.equal(s.service.getState(s.id)?.attempt, attempt);
    await s.clock.advance(10_000);
    await s.ready();
    await s.clock.advance(240_000);
  }
  // The first restart is more than ten minutes old by now, and still counts: the server never stayed up that long.
  await s.crashAfterReady();
  assert.equal(s.service.getState(s.id)?.state, 'gaveUp');
  assert.equal(s.children.length, 4);
});

test('the count starts over only once the restarted server has stayed up for the saved time after it finished starting', async (t) => {
  const s = await setup(t);
  await s.crashAfterReady();
  await s.clock.advance(10_000);
  await s.ready();

  await s.clock.advance(599_999);
  await s.crashAfterReady();
  assert.equal(s.service.getState(s.id)?.attempt, 2, 'one millisecond short of ten minutes');
  await s.clock.advance(10_000);

  // Nine minutes to start and two minutes up: eleven minutes after the restart, but not ten minutes of running.
  await s.clock.advance(540_000);
  await s.ready();
  await s.clock.advance(120_000);
  await s.crashAfterReady();
  assert.equal(s.service.getState(s.id)?.attempt, 3, 'the time spent starting does not count');
  await s.clock.advance(10_000);
  await s.ready();

  await s.clock.advance(600_000);
  await s.crashAfterReady();
  assert.equal(s.service.getState(s.id)?.attempt, 1, 'a server that crashes now and then is restarted every time');
});

test('a restarted server that crashes before it finished starting is left crashed, with the reason reported', async (t) => {
  const s = await setup(t);
  await s.crashAfterReady();
  await s.clock.advance(10_000);
  assert.equal(s.children.length, 2);
  s.exit(1);
  assert.deepEqual(s.service.getState(s.id), {
    state: 'failed',
    attempt: 1,
    max: 3,
    at: new Date(s.clock.now()).toISOString(),
    reason: { key: 'server.instance.autoRestartDidNotStart' },
  });
  assert.equal(s.clock.waiting(), 0);

  await s.start();
  assert.equal(s.service.getState(s.id), null);
  s.exit(1);
  assert.equal(s.service.getState(s.id), null, 'a start by the user that fails is not reported as a failed restart');
});

test('a waiting restart is dropped by cancelling it, by switching the option off and by panel shutdown, and none uses up an attempt', async (t) => {
  const s = await setup(t);
  await s.crashAfterReady();
  s.service.cancel(s.id);
  assert.equal(s.service.getState(s.id), null);
  assert.equal(s.clock.waiting(), 0);
  assert.equal(s.manager.getStatus(s.id), 'crashed');

  await s.start();
  await s.crashAfterReady();
  assert.equal(s.service.getState(s.id)?.attempt, 1, 'the user start began the count again');
  s.settings.enabled = false;
  await s.clock.advance(10_000);
  assert.equal(s.children.length, 2, 'the switch is read again when the restart comes due');
  assert.equal(s.service.getState(s.id), null);

  s.settings.enabled = true;
  await s.start();
  await s.crashAfterReady();
  assert.equal(s.clock.waiting(), 1);
  s.service.shutdown();
  assert.equal(s.clock.waiting(), 0);
  assert.equal(s.service.getState(s.id), null);

  await s.start();
  await s.crashAfterReady();
  assert.equal(s.service.getState(s.id), null, 'nothing is scheduled once shutdown began');
});

test('a start the normal path refuses is reported with its reason and not tried again', async (t) => {
  const s = await setup(t);
  await s.crashAfterReady();
  const endBackup = s.manager.beginMaintenance(s.id, 'server.backups.busyBackingUp');
  await s.clock.advance(10_000);
  assert.equal(s.children.length, 1);
  assert.deepEqual(s.service.getState(s.id), {
    state: 'failed',
    attempt: 1,
    max: 3,
    at: new Date(s.clock.now()).toISOString(),
    reason: { key: 'server.backups.busyBackingUp' },
  });
  endBackup();
  await s.clock.advance(3_600_000);
  assert.equal(s.children.length, 1);
  assert.equal(s.clock.waiting(), 0);

  await s.start();
  assert.equal(s.service.getState(s.id), null, 'cleared once the user starts the server');
  await s.crashAfterReady();
  fs.rmSync(s.jar);
  await s.clock.advance(10_000);
  const failed = s.service.getState(s.id);
  assert.equal(failed?.state, 'failed');
  assert.deepEqual(failed?.state === 'failed' && failed.reason, { key: 'server.instance.jarMissing', params: { jar: 'server.jar' } });
});

test('a crash while a backup holds the instance is still restarted once the backup has let go', async (t) => {
  const s = await setup(t);
  await s.start();
  await s.ready();
  // A backup of a running server aborts when the server exits, and releases the instance shortly after.
  const endBackup = s.manager.beginMaintenance(s.id, 'server.backups.busyBackingUp');
  s.exit(1);
  assert.equal(s.service.getState(s.id)?.state, 'scheduled');
  endBackup();
  await s.clock.advance(10_000);
  assert.equal(s.children.length, 2);
});

test('a restart that comes due after the user started the server, or after the instance was deleted, does nothing', async (t) => {
  const s = await setup(t);
  await s.crashAfterReady();
  await s.start();
  assert.equal(s.clock.waiting(), 0, 'the user start cancelled it');
  assert.equal(s.children.length, 2);

  await s.crashAfterReady();
  s.getDb().prepare('DELETE FROM instances WHERE id = ?').run(s.id);
  await s.clock.advance(10_000);
  assert.equal(s.children.length, 2);
  assert.equal(s.service.getState(s.id), null);
});

test('auto restart over the API: the panel-wide setting and its ranges, the state in the instance info, and what keeps or drops a waiting restart', async (t) => {
  prepareTempDataRoot(t);
  const { buildApp } = await import('../index.js');
  const { processManager } = await import('./process-manager.js');
  const { autoRestartService } = await import('./auto-restart-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');
  const app = await buildApp({ skipDataLock: true });

  const children: ChildProcessWithoutNullStreams[] = [];
  const singleton = processManager as unknown as {
    spawnMinecraft: (...args: unknown[]) => ChildProcessWithoutNullStreams;
    resolveJavaCommand: (id: string | null) => Promise<string>;
  };
  const originalSpawn = singleton.spawnMinecraft;
  const originalResolve = singleton.resolveJavaCommand;
  singleton.spawnMinecraft = () => {
    const child = fakeChild();
    children.push(child);
    return child;
  };
  singleton.resolveJavaCommand = async () => 'java';
  let id = '';
  t.after(async () => {
    // The shared service runs on real timers: none may outlive the test.
    autoRestartService.forget(id);
    singleton.spawnMinecraft = originalSpawn;
    singleton.resolveJavaCommand = originalResolve;
    await app.close();
  });

  const setupResponse = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { 'x-setup-token': 'b'.repeat(64) },
    payload: { username: 'admin12', password: 'password1234' },
  });
  assert.equal(setupResponse.statusCode, 200, setupResponse.body);
  const headers = { authorization: `Bearer ${setupResponse.json<{ token: string }>().token}` };
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

  const created = await call('POST', '/api/instances', { name: 'auto-restart-routes' });
  assert.equal(created.statusCode, 200, created.body);
  id = created.json<InstanceInfo>().id;
  assert.equal(created.json<InstanceInfo>().autoRestartState, null);
  fs.writeFileSync(path.join(defaultInstanceDir(id), 'server.jar'), 'stub-jar');

  const defaults = { enabled: false, delaySeconds: 10, maxAttempts: 3, windowMinutes: 10 };
  assert.deepEqual((await call('GET', '/api/system/auto-restart')).json(), defaults, 'off unless the user turns it on');
  for (const invalid of [
    { ...defaults, enabled: 'yes' },
    { enabled: true },
    { ...defaults, delaySeconds: 4 },
    { ...defaults, delaySeconds: 301 },
    { ...defaults, delaySeconds: 7.5 },
    { ...defaults, maxAttempts: 0 },
    { ...defaults, maxAttempts: 11 },
    { ...defaults, windowMinutes: 4 },
    { ...defaults, windowMinutes: 61 },
  ]) {
    const refused = await call('PUT', '/api/system/auto-restart', invalid);
    assert.equal(refused.statusCode, 400, JSON.stringify(invalid));
    assert.equal(refused.json<{ code: string }>().code, 'server.system.autoRestartInvalid');
  }
  const switchedOn = { enabled: true, delaySeconds: 60, maxAttempts: 4, windowMinutes: 10 };
  const saved = await call('PUT', '/api/system/auto-restart', switchedOn);
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(saved.json(), switchedOn);
  assert.deepEqual((await call('GET', '/api/system/auto-restart')).json(), switchedOn);

  const info = async () => (await call('GET', `/api/instances/${id}`)).json<InstanceInfo>();
  const runUntilCrash = async () => {
    const started = await call('POST', `/api/instances/${id}/start`);
    assert.equal(started.statusCode, 200, started.body);
    const child = children[children.length - 1];
    child.stdout.emit('data', Buffer.from(DONE_LINE));
    await flush();
    child.emit('exit', 1, null);
    const crashed = await info();
    assert.equal(crashed.status, 'crashed');
    return crashed;
  };

  const crashed = await runUntilCrash();
  const state = crashed.autoRestartState;
  assert.equal(state?.state, 'scheduled');
  assert.equal(state?.attempt, 1);
  assert.equal(state?.max, 4);
  assert.ok(state?.state === 'scheduled' && state.remainingMs > 50_000 && state.remainingMs <= 60_000);
  const listed = (await call('GET', '/api/instances')).json<InstanceInfo[]>().find((item) => item.id === id);
  assert.equal(listed?.autoRestartState?.state, 'scheduled');

  // A start that is refused changes nothing: the restart the panel planned is still waiting.
  const endBackup = processManager.beginMaintenance(id, 'server.backups.busyBackingUp');
  assert.equal((await call('POST', `/api/instances/${id}/start`)).statusCode, 409);
  assert.equal((await info()).autoRestartState?.state, 'scheduled');
  endBackup();

  const cancelled = await call('DELETE', `/api/instances/${id}/pending-restart`);
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.equal(cancelled.json<InstanceInfo>().autoRestartState, null);
  assert.equal(cancelled.json<InstanceInfo>().status, 'crashed');
  assert.equal((await call('DELETE', `/api/instances/${id}/pending-restart`)).statusCode, 200, 'a late click is not an error');
  assert.equal((await call('DELETE', '/api/instances/missing/pending-restart')).statusCode, 404);

  assert.equal((await runUntilCrash()).autoRestartState?.attempt, 1, 'a start by the user begins the count again');
  await call('PUT', '/api/system/auto-restart', { ...switchedOn, enabled: false });
  assert.equal((await info()).autoRestartState, null, 'switching the setting off drops the restart that was waiting');

  await call('PUT', '/api/system/auto-restart', switchedOn);
  assert.equal((await runUntilCrash()).autoRestartState?.state, 'scheduled');
  assert.equal((await call('DELETE', `/api/instances/${id}`)).statusCode, 200);
  assert.equal(autoRestartService.getState(id), null);
});
