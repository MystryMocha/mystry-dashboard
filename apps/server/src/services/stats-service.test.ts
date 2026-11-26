/**
 * Regression suite for overview run history, 5-minute metric collection/pruning, two-layer bucket
 * aggregation, asynchronous directory-size scanning, host OS detection and GET /api/stats/overview.
 */
import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { DashboardMetrics, StatsOverview } from '@mystry/shared';
import type { InstanceRow, InstanceRunRow } from '../db.js';

const JWT_SECRET = 'a'.repeat(64);
const SETUP_TOKEN = 'b'.repeat(64);
const LAUNCHER_TOKEN = 'c'.repeat(64);
process.env.JWT_SECRET = JWT_SECRET;
process.env.SETUP_TOKEN = SETUP_TOKEN;
process.env.LAUNCHER_TOKEN = LAUNCHER_TOKEN;

function prepareTempDataRoot(t: test.TestContext, label: string): string {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), `mystry-stats-${label}-`));
  process.env.MYSTRY_DATA_DIR = dataRoot;
  delete process.env.BACKUP_DIR;
  t.after(async () => {
    try {
      const { detachRunHistoryLifecycle } = await import('./run-history-service.js');
      const { resetStatsRuntime } = await import('./stats-service.js');
      detachRunHistoryLifecycle();
      resetStatsRuntime();
    } catch {
      /* Modules may not have been loaded */
    }
    try {
      const { closeDb } = await import('../db.js');
      closeDb();
    } catch {
      /* Database may already be closed */
    }
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });
  return dataRoot;
}

function fakeChild(options: {
  failStopWrite?: boolean;
  exitOnStop?: boolean;
  exitOnKill?: boolean;
} = {}): ChildProcessWithoutNullStreams {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;

  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    Object.assign(child, { exitCode: code, signalCode: signal });
    child.emit('exit', code, signal);
  };

  if (options.failStopWrite) {
    stdin.write = (() => {
      throw new Error('EPIPE');
    }) as typeof stdin.write;
  } else if (options.exitOnStop) {
    stdin.on('data', (chunk: Buffer) => {
      if (chunk.toString('utf8').includes('stop')) {
        setImmediate(() => finish(0, null));
      }
    });
  }

  Object.assign(child, {
    pid: Math.floor(Math.random() * 100_000) + 10_000,
    stdin,
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    kill: (signal?: NodeJS.Signals) => {
      if (options.exitOnKill) {
        setImmediate(() => finish(null, signal ?? 'SIGKILL'));
      }
      return true;
    },
  });
  setImmediate(() => child.emit('spawn'));
  return child;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('run history records ready/stopped/crashed/start-failed, drops pre-spawn failures, and keeps one open row when stop write fails', async (t) => {
  prepareTempDataRoot(t, 'run-history');
  const { initDb, getDb } = await import('../db.js');
  const { createInstance, getInstanceRow } = await import('./instance-service.js');
  const { ProcessManager } = await import('./process-manager.js');
  const { createRunHistoryTracker } = await import('./run-history-service.js');
  const { getStatsOverview } = await import('./stats-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const info = createInstance({ name: 'Survival' });
  fs.writeFileSync(path.join(defaultInstanceDir(info.id), 'server.jar'), 'stub-jar');
  const row = getInstanceRow(info.id)! as InstanceRow;

  let tick = Date.parse('2026-11-26T10:00:00.000Z');
  const advance = (ms: number) => {
    tick += ms;
  };
  let nextChildFactory: () => ChildProcessWithoutNullStreams = () => fakeChild();
  let resolveJava: () => Promise<string> = async () => 'java';

  const manager = new ProcessManager(
    () => nextChildFactory(),
    () => resolveJava(),
  );
  const tracker = createRunHistoryTracker({
    events: manager,
    now: () => new Date(tick),
  });
  tracker.attach();
  t.after(() => tracker.detach());

  const allRuns = () =>
    getDb().prepare('SELECT * FROM instance_runs ORDER BY id ASC').all() as InstanceRunRow[];

  // 1. Pre-spawn failure (e.g. bound Java verification fails): placeholder row must be deleted.
  resolveJava = async () => {
    throw new Error('java unavailable');
  };
  await assert.rejects(() => manager.start(row), /java unavailable/);
  assert.equal(allRuns().length, 0, 'pre-spawn failure must leave no run row');

  // 2. Startup failure via child error (e.g. PATH missing java): end_reason = start-failed, ready_at = NULL.
  resolveJava = async () => 'java';
  let currentChild = fakeChild();
  nextChildFactory = () => currentChild;
  await manager.start(row);
  advance(5_000);
  currentChild.emit('error', new Error('spawn java ENOENT'));
  assert.equal(allRuns().length, 1);
  assert.equal(allRuns()[0]!.ready_at, null);
  assert.equal(allRuns()[0]!.end_reason, 'start-failed');

  // 3. EULA not accepted (output -> running, exit code 0 before Done): end_reason = stopped, ready_at = NULL.
  advance(60_000);
  currentChild = fakeChild();
  await manager.start(row);
  currentChild.stdout.emit('data', Buffer.from('[10:01:00] [Server thread/INFO]: You need to agree to the EULA\n'));
  await flush();
  advance(3_000);
  currentChild.emit('exit', 0, null);
  assert.equal(allRuns().length, 2);
  assert.equal(allRuns()[1]!.ready_at, null);
  assert.equal(allRuns()[1]!.end_reason, 'stopped');

  // 4. Ready run that hits a stop write failure stays on ONE open row, then closes cleanly as stopped.
  advance(60_000);
  const startedAt4 = new Date(tick).toISOString();
  currentChild = fakeChild({ failStopWrite: true, exitOnKill: true });
  await manager.start(row);
  advance(10_000);
  const readyAt4 = new Date(tick).toISOString();
  currentChild.stdout.emit('data', Buffer.from('[10:02:10] [Server thread/INFO]: Done (9.8s)! For help, type "help"\n'));
  await flush();

  advance(30_000);
  await assert.rejects(
    () => manager.stop(info.id),
    (error: unknown) => error instanceof Error && 'messageKey' in error && (error as { messageKey: string }).messageKey === 'server.instance.stopWriteFailed',
  );
  const openAfterWriteFailure = allRuns().filter((r) => r.ended_at === null);
  assert.equal(openAfterWriteFailure.length, 1, 'stop write failure must keep exactly one open run');
  assert.equal(openAfterWriteFailure[0]!.started_at, startedAt4);
  assert.equal(openAfterWriteFailure[0]!.ready_at, readyAt4);

  advance(30_000);
  await manager.stop(info.id, true);
  assert.equal(allRuns().length, 3);
  assert.equal(allRuns()[2]!.end_reason, 'stopped');
  assert.equal(allRuns()[2]!.ready_at, readyAt4);

  // 5. Ready run that crashes with exit code 1: end_reason = crashed.
  advance(60_000);
  currentChild = fakeChild();
  await manager.start(row);
  advance(5_000);
  currentChild.stdout.emit('data', Buffer.from('[10:04:00] [Server thread/INFO]: Done (4.2s)! For help, type "help"\n'));
  await flush();
  advance(120_000);
  currentChild.emit('exit', 1, null);
  assert.equal(allRuns().length, 4);
  assert.equal(allRuns()[3]!.end_reason, 'crashed');
  assert.ok(allRuns()[3]!.ready_at);

  // 6. Normal panel shutdown (stopAll): running ready instance records end_reason = stopped.
  advance(60_000);
  currentChild = fakeChild({ exitOnStop: true });
  await manager.start(row);
  advance(5_000);
  currentChild.stdout.emit('data', Buffer.from('[10:07:00] [Server thread/INFO]: Done (3.0s)! For help, type "help"\n'));
  await flush();
  advance(60_000);
  const stopResult = await manager.stopAll();
  assert.deepEqual(stopResult.stillStopping, []);
  assert.equal(allRuns().length, 5);
  assert.equal(allRuns()[4]!.end_reason, 'stopped');

  // Overview runs only include ready runs (rows #3, #4, #5); start-failed & unready EULA exit are excluded.
  const overview = getStatsOverview('24h', { now: () => new Date(tick + 10_000) });
  assert.deepEqual(
    overview.runs.map((r) => r.endReason),
    ['stopped', 'crashed', 'stopped'],
  );
});

test('run history recovery sets panel-exit with ended_at never earlier than started_at or ready_at and never null', async (t) => {
  prepareTempDataRoot(t, 'recovery');
  const { initDb, getDb } = await import('../db.js');
  const { createInstance } = await import('./instance-service.js');
  const { createRunHistoryTracker } = await import('./run-history-service.js');

  initDb();
  const a = createInstance({ name: 'Alpha' });
  const b = createInstance({ name: 'Beta' });
  const tracker = createRunHistoryTracker();

  // Case 1: No host samples in metric_samples at all -> falls back to MAX(started_at, COALESCE(ready_at, started_at)).
  getDb().prepare('INSERT INTO instance_runs (instance_id, started_at, ready_at) VALUES (?, ?, ?)').run(
    a.id,
    '2026-11-26T08:00:00.000Z',
    '2026-11-26T08:01:00.000Z',
  );
  getDb().prepare('INSERT INTO instance_runs (instance_id, started_at, ready_at) VALUES (?, ?, NULL)').run(
    b.id,
    '2026-11-26T08:05:00.000Z',
  );

  const firstRecovery = tracker.recoverInterrupted();
  assert.equal(firstRecovery.recovered, 2);
  const rows1 = getDb().prepare('SELECT instance_id, ended_at, end_reason FROM instance_runs ORDER BY id').all() as Array<{
    instance_id: string;
    ended_at: string | null;
    end_reason: string | null;
  }>;
  assert.deepEqual(
    rows1.map((row) => ({ ...row })),
    [
      { instance_id: a.id, ended_at: '2026-11-26T08:01:00.000Z', end_reason: 'panel-exit' },
      { instance_id: b.id, ended_at: '2026-11-26T08:05:00.000Z', end_reason: 'panel-exit' },
    ],
  );

  // Case 2: Host sample exists after ready_at -> uses last host sample timestamp; ignores instance samples.
  getDb().prepare(
    'INSERT INTO metric_samples (sampled_at, instance_id, cpu_percent, memory_bytes) VALUES (?, NULL, 20, 1000), (?, ?, 10, 500)',
  ).run('2026-11-26T09:30:00.000Z', '2026-11-26T09:45:00.000Z', a.id);
  getDb().prepare('INSERT INTO instance_runs (instance_id, started_at, ready_at) VALUES (?, ?, ?)').run(
    a.id,
    '2026-11-26T09:00:00.000Z',
    '2026-11-26T09:02:00.000Z',
  );
  // Case 3: Host sample is EARLIER than started_at -> clamped to ready_at/started_at.
  getDb().prepare('INSERT INTO instance_runs (instance_id, started_at, ready_at) VALUES (?, ?, ?)').run(
    b.id,
    '2026-11-26T10:00:00.000Z',
    '2026-11-26T10:03:00.000Z',
  );

  const secondRecovery = tracker.recoverInterrupted();
  assert.equal(secondRecovery.recovered, 2);
  const rows2 = getDb().prepare('SELECT instance_id, ended_at, end_reason FROM instance_runs ORDER BY id DESC LIMIT 2').all() as Array<{
    instance_id: string;
    ended_at: string | null;
    end_reason: string | null;
  }>;
  assert.deepEqual(
    rows2.reverse().map((row) => ({ ...row })),
    [
      { instance_id: a.id, ended_at: '2026-11-26T09:30:00.000Z', end_reason: 'panel-exit' },
      { instance_id: b.id, ended_at: '2026-11-26T10:03:00.000Z', end_reason: 'panel-exit' },
    ],
  );
});

test('metric collector shares timestamps, skips deleted instances, prunes >30d samples, and stays safe across shutdown/closeDb', async (t) => {
  prepareTempDataRoot(t, 'collector');
  const { initDb, getDb, closeDb } = await import('../db.js');
  const { createInstance, deleteInstance } = await import('./instance-service.js');
  const { createRunHistoryTracker } = await import('./run-history-service.js');
  const { createStatsCollector } = await import('./stats-service.js');

  initDb();
  const instA = createInstance({ name: 'A' });
  const instB = createInstance({ name: 'B' });

  const currentNow = Date.parse('2026-11-26T12:00:00.000Z');
  const fakeMetrics = {
    get: (): Promise<DashboardMetrics> =>
      Promise.resolve({
        sampledAt: new Date(currentNow).toISOString(),
        cpuPercent: 42.5,
        memory: { usedBytes: 8_000_000_000, totalBytes: 16_000_000_000 },
        disk: { availableBytes: 100_000_000_000, totalBytes: 500_000_000_000 },
        warnings: [],
        instances: {
          [instA.id]: { cpuPercent: 18, memoryBytes: 2_000_000_000, state: 'ready' },
          'vanished-instance': { cpuPercent: 5, memoryBytes: 500_000_000, state: 'ready' },
        },
      }),
  };

  const collector = createStatsCollector({
    metrics: fakeMetrics,
    now: () => new Date(currentNow),
  });
  t.after(() => collector.stop());

  assert.equal(await collector.sampleOnce(), true);
  const inserted = getDb().prepare('SELECT sampled_at, instance_id, cpu_percent, memory_bytes FROM metric_samples ORDER BY id').all() as Array<{
    sampled_at: string;
    instance_id: string | null;
    cpu_percent: number | null;
    memory_bytes: number | null;
  }>;
  assert.deepEqual(
    inserted.map((row) => ({ ...row })),
    [
      { sampled_at: '2026-11-26T12:00:00.000Z', instance_id: null, cpu_percent: 42.5, memory_bytes: 8_000_000_000 },
      { sampled_at: '2026-11-26T12:00:00.000Z', instance_id: instA.id, cpu_percent: 18, memory_bytes: 2_000_000_000 },
    ],
  );

  // Add a 31-day-old sample and a 29-day-old sample for instB, then prune.
  getDb().prepare(
    'INSERT INTO metric_samples (sampled_at, instance_id, cpu_percent, memory_bytes) VALUES (?, NULL, 10, 1000), (?, ?, 5, 500)',
  ).run('2026-10-25T11:59:59.000Z', '2026-10-28T12:00:00.000Z', instB.id);
  const pruned = collector.pruneOldSamples();
  assert.equal(pruned, 1);

  // Deleting instA cascades its samples and runs while preserving host & instB rows.
  getDb().prepare("INSERT INTO instance_runs (instance_id, started_at, ready_at, ended_at, end_reason) VALUES (?, ?, ?, ?, 'stopped')")
    .run(instA.id, '2026-11-26T11:00:00.000Z', '2026-11-26T11:01:00.000Z', '2026-11-26T11:30:00.000Z');
  await deleteInstance(instA.id);
  assert.equal(
    Number((getDb().prepare('SELECT COUNT(*) AS c FROM instance_runs WHERE instance_id = ?').get(instA.id) as { c: number }).c),
    0,
  );
  assert.deepEqual(
    (getDb().prepare('SELECT instance_id FROM metric_samples ORDER BY id').all() as Array<{ instance_id: string | null }>).map((r) => r.instance_id),
    [null, instB.id],
  );

  // Shutdown race: an in-flight metrics.get() resolves AFTER stop() and closeDb(), plus late process exit after detach().
  let releasePending!: (snapshot: DashboardMetrics) => void;
  const slowCollector = createStatsCollector({
    metrics: {
      get: () => new Promise<DashboardMetrics>((resolve) => {
        releasePending = resolve;
      }),
    },
    now: () => new Date(currentNow),
  });
  const emitter = new EventEmitter();
  const tracker = createRunHistoryTracker({ events: emitter });
  tracker.attach();

  const inFlight = slowCollector.sampleOnce();
  slowCollector.stop();
  tracker.detach();
  closeDb();

  releasePending({
    sampledAt: new Date(currentNow).toISOString(),
    cpuPercent: 50,
    memory: { usedBytes: 1000, totalBytes: 2000 },
    disk: null,
    warnings: [],
    instances: {},
  });
  assert.equal(await inFlight, false, 'stopped in-flight sample must not touch a closed database');
  assert.doesNotThrow(() => {
    emitter.emit('status', instB.id, 'stopped');
    emitter.emit('ready', instB.id);
  });
});

test('two-layer aggregation prevents half-bucket overshoot, handles NULL process samples, offline gaps, clock rollback and unsupported platforms', async (t) => {
  prepareTempDataRoot(t, 'aggregation');
  const { initDb, getDb } = await import('../db.js');
  const { createInstance } = await import('./instance-service.js');
  const { getStatsOverview } = await import('./stats-service.js');

  initDb();
  const instA = createInstance({ name: 'Alpha' });
  const instB = createInstance({ name: 'Beta' });

  const now = new Date('2026-11-26T12:30:00.000Z');
  const insert = getDb().prepare(
    'INSERT INTO metric_samples (sampled_at, instance_id, cpu_percent, memory_bytes) VALUES (?, ?, ?, ?)',
  );

  // Bucket 10:00–11:00: first half has 0 running instances (host 10%, 4 GiB), second half has 1 running instance (host 50%, 8 GiB; instA 40%, 2 GiB).
  // Expected bucket average: hostCpu = 30, instCpu = (0 + 40)/2 = 20 (<= 30), hostMem = 6 GiB, instMem = 1 GiB.
  const GiB = 1024 ** 3;
  insert.run('2026-11-26T10:10:00.000Z', null, 10, 4 * GiB);
  insert.run('2026-11-26T10:40:00.000Z', null, 50, 8 * GiB);
  insert.run('2026-11-26T10:40:00.000Z', instA.id, 40, 2 * GiB);

  // Bucket 11:00–12:00: running instance exists but process query timed out (all NULL) -> skipped, NOT counted as 0.
  insert.run('2026-11-26T11:15:00.000Z', null, 60, 10 * GiB);
  insert.run('2026-11-26T11:15:00.000Z', instA.id, null, null);

  // Bucket 12:00–13:00 (current partial bucket): two running instances summed (15 + 25 = 40%, 1 + 2 = 3 GiB).
  insert.run('2026-11-26T12:15:00.000Z', null, 70, 12 * GiB);
  insert.run('2026-11-26T12:15:00.000Z', instA.id, 15, 1 * GiB);
  insert.run('2026-11-26T12:15:00.000Z', instB.id, 25, 2 * GiB);

  // Clock rollback sample ahead of `now` (12:45 > 12:30): must be ignored.
  insert.run('2026-11-26T12:45:00.000Z', null, 99, 16 * GiB);

  const overview7d = getStatsOverview('7d', { now: () => now, processMetricsSupported: true });
  assert.equal(overview7d.bucketSeconds, 3600);
  assert.equal(overview7d.buckets.length, 168);
  assert.equal(overview7d.processMetricsSupported, true);

  const byTime = new Map(overview7d.buckets.map((b) => [b.timestamp, b]));
  const bucket10 = byTime.get('2026-11-26T10:00:00.000Z')!;
  assert.equal(bucket10.hostCpuPercent, 30);
  assert.equal(bucket10.instancesCpuPercent, 20);
  assert.ok(bucket10.instancesCpuPercent! <= bucket10.hostCpuPercent!);
  assert.equal(bucket10.hostMemoryBytes, 6 * GiB);
  assert.equal(bucket10.instancesMemoryBytes, 1 * GiB);

  const bucket11 = byTime.get('2026-11-26T11:00:00.000Z')!;
  assert.equal(bucket11.hostCpuPercent, 60);
  assert.equal(bucket11.instancesCpuPercent, null);
  assert.equal(bucket11.instancesMemoryBytes, null);

  const bucket12 = byTime.get('2026-11-26T12:00:00.000Z')!;
  assert.equal(bucket12.hostCpuPercent, 70, 'future sample ahead of now must be ignored');
  assert.equal(bucket12.instancesCpuPercent, 40);
  assert.equal(bucket12.instancesMemoryBytes, 3 * GiB);

  // Offline bucket with no samples returns null in every field.
  const bucket09 = byTime.get('2026-11-26T09:00:00.000Z')!;
  assert.deepEqual(bucket09, {
    timestamp: '2026-11-26T09:00:00.000Z',
    hostCpuPercent: null,
    hostMemoryBytes: null,
    instancesCpuPercent: null,
    instancesMemoryBytes: null,
  });

  // Unsupported platform (e.g. macOS): instance series stays null everywhere.
  const macOverview = getStatsOverview('7d', { now: () => now, processMetricsSupported: false });
  assert.equal(macOverview.processMetricsSupported, false);
  assert.equal(macOverview.buckets.find((b) => b.timestamp === '2026-11-26T10:00:00.000Z')!.instancesCpuPercent, null);
  assert.equal(macOverview.buckets.find((b) => b.timestamp === '2026-11-26T10:00:00.000Z')!.instancesMemoryBytes, null);

  // Bucket counts for 24h and 30d.
  const overview24h = getStatsOverview('24h', { now: () => now, processMetricsSupported: true });
  assert.equal(overview24h.bucketSeconds, 300);
  assert.equal(overview24h.buckets.length, 288);

  const overview30d = getStatsOverview('30d', { now: () => now, processMetricsSupported: true });
  assert.equal(overview30d.bucketSeconds, 21600);
  assert.equal(overview30d.buckets.length, 120);
});

test('OS name detection formats Windows, Linux /etc/os-release (with fallback) and macOS cleanly', async () => {
  const { detectOsName, parseLinuxOsReleasePrettyName } = await import('./stats-service.js');

  assert.equal(parseLinuxOsReleasePrettyName('NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n'), 'Ubuntu 24.04.1 LTS');
  assert.equal(parseLinuxOsReleasePrettyName("PRETTY_NAME='Debian GNU/Linux 12'\n"), 'Debian GNU/Linux 12');
  assert.equal(parseLinuxOsReleasePrettyName('NAME="NoPretty"\n'), null);

  assert.equal(detectOsName({ platform: 'darwin', osVersion: () => 'Darwin Kernel Version 24.0.0' }), 'macOS');
  assert.equal(detectOsName({ platform: 'win32', osVersion: () => 'Windows 11 Home' }), 'Windows 11 Home');
  assert.equal(
    detectOsName({
      platform: 'linux',
      readOsRelease: () => 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\n',
    }),
    'Ubuntu 24.04.1 LTS',
  );
  assert.equal(
    detectOsName({
      platform: 'linux',
      readOsRelease: () => {
        throw new Error('ENOENT');
      },
      osType: () => 'Linux',
      osRelease: () => '6.8.0',
    }),
    'Linux 6.8.0',
  );
});

test('directory size scanner skips symlinks/junctions, supports abort, and detects uncreated or cross-volume BACKUP_DIR', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-dir-scan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { createDiskUsageScanner, measureDirectoryBytes } = await import('./dir-size-scanner.js');

  const dataDir = path.join(root, 'data');
  const instancesDir = path.join(dataDir, 'instances');
  const worldDir = path.join(instancesDir, 'inst-1', 'world');
  const externalDir = path.join(root, 'external-secret');
  fs.mkdirSync(worldDir, { recursive: true });
  fs.mkdirSync(externalDir, { recursive: true });

  fs.writeFileSync(path.join(instancesDir, 'inst-1', 'server.jar'), Buffer.alloc(120));
  fs.writeFileSync(path.join(worldDir, 'level.dat'), Buffer.alloc(80));
  fs.writeFileSync(path.join(externalDir, 'huge.bin'), Buffer.alloc(50_000));

  // Add a directory junction on Windows (works without admin privileges) or a directory symlink on POSIX.
  const dirLinkPath = path.join(instancesDir, 'inst-1', 'linked-external');
  fs.symlinkSync(externalDir, dirLinkPath, process.platform === 'win32' ? 'junction' : 'dir');

  // Best-effort file symlink (unprivileged Windows may throw EPERM for file symlinks).
  try {
    fs.symlinkSync(path.join(externalDir, 'huge.bin'), path.join(instancesDir, 'inst-1', 'linked-file.bin'), 'file');
  } catch {
    /* Expected on unprivileged Windows */
  }

  assert.equal(await measureDirectoryBytes(instancesDir, { yieldEvery: 1 }), 200);
  assert.equal(await measureDirectoryBytes(path.join(dataDir, 'does-not-exist')), 0);

  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await measureDirectoryBytes(instancesDir, { signal: aborted.signal }), null);

  // Uncreated BACKUP_DIR under dataDir: walks up to nearest existing parent -> same volume, 0 bytes.
  const uncreatedBackupDir = path.join(dataDir, 'backups', 'nested');
  const sameVolScanner = createDiskUsageScanner({
    dataDir: () => dataDir,
    instancesDir: () => instancesDir,
    backupDir: () => uncreatedBackupDir,
  });
  assert.deepEqual(sameVolScanner.getSnapshot(), {
    instancesBytes: null,
    backupsBytes: null,
    backupsOnSameVolume: false,
  });
  const afterSame = await sameVolScanner.refresh();
  assert.deepEqual(afterSame, {
    instancesBytes: 200,
    backupsBytes: 0,
    backupsOnSameVolume: true,
  });

  // Cross-volume BACKUP_DIR: omits backupsBytes and marks backupsOnSameVolume = false.
  const otherBackupDir = path.join(root, 'other-volume', 'backups');
  fs.mkdirSync(otherBackupDir, { recursive: true });
  fs.writeFileSync(path.join(otherBackupDir, 'b1.tar.gz'), Buffer.alloc(4096));
  const diffVolScanner = createDiskUsageScanner({
    dataDir: () => dataDir,
    instancesDir: () => instancesDir,
    backupDir: () => otherBackupDir,
    readDeviceId: async (targetPath) => (path.resolve(targetPath).startsWith(path.resolve(dataDir)) ? 1 : 2),
  });
  const afterDiff = await diffVolScanner.refresh();
  assert.deepEqual(afterDiff, {
    instancesBytes: 200,
    backupsBytes: null,
    backupsOnSameVolume: false,
  });
});

test('GET /api/stats/overview enforces auth, validates range query, defaults to 7d, and resets shared metrics across buildApp calls', async (t) => {
  const dir1 = prepareTempDataRoot(t, 'route-1');
  const { buildApp } = await import('../index.js');
  const { closeDb, getDb } = await import('../db.js');

  let activeApp: Awaited<ReturnType<typeof buildApp>> | null = await buildApp({ skipDataLock: true });
  t.after(async () => {
    if (activeApp) {
      await activeApp.close();
      activeApp = null;
    }
  });
  const app = activeApp;

  assert.equal((await app.inject({ method: 'GET', url: '/api/stats/overview' })).statusCode, 401);

  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { 'x-setup-token': SETUP_TOKEN },
    payload: { username: 'admin12', password: 'password1234' },
  });
  assert.equal(setup.statusCode, 200);
  const { token } = setup.json<{ token: string }>();
  const headers = { authorization: `Bearer ${token}` };

  // Default range is 7d.
  const resDefault = await app.inject({ method: 'GET', url: '/api/stats/overview', headers });
  assert.equal(resDefault.statusCode, 200);
  const bodyDefault = resDefault.json<StatsOverview>();
  assert.equal(bodyDefault.range, '7d');
  assert.equal(bodyDefault.bucketSeconds, 3600);
  assert.equal(bodyDefault.buckets.length, 168);
  assert.ok(bodyDefault.host.osName.length > 0);
  assert.ok(bodyDefault.host.cpuThreads >= 1);
  assert.ok(bodyDefault.host.totalMemoryBytes > 0);
  assert.ok(Number.isFinite(Date.parse(bodyDefault.host.bootedAt)));
  assert.equal(bodyDefault.diskBreakdown.instancesBytes, null);
  assert.equal(bodyDefault.diskBreakdown.backupsBytes, null);

  // Explicit 24h and 30d ranges.
  const res24h = await app.inject({ method: 'GET', url: '/api/stats/overview?range=24h', headers });
  assert.equal(res24h.statusCode, 200);
  assert.equal(res24h.json<StatsOverview>().buckets.length, 288);

  const res30d = await app.inject({ method: 'GET', url: '/api/stats/overview?range=30d', headers });
  assert.equal(res30d.statusCode, 200);
  assert.equal(res30d.json<StatsOverview>().buckets.length, 120);

  // Invalid range or unknown query parameter returns 400 PanelError.
  for (const url of ['/api/stats/overview?range=90d', '/api/stats/overview?range=', '/api/stats/overview?range=7d&extra=1']) {
    const invalid = await app.inject({ method: 'GET', url, headers });
    assert.equal(invalid.statusCode, 400, url);
    const body = invalid.json<{ code?: string; error: string }>();
    assert.equal(body.code, 'server.system.statsRangeInvalid', url);
    assert.ok(body.error.length > 0);
  }

  // Verify live metrics endpoint works on dir1, then switch MYSTRY_DATA_DIR to dir2 and rebuild app.
  const metricsRes1 = await app.inject({ method: 'GET', url: '/api/system/metrics', headers });
  assert.equal(metricsRes1.statusCode, 200);
  assert.ok(metricsRes1.json<DashboardMetrics>().disk !== null);

  // Insert an open run in dir1 to verify recovery runs cleanly on restart.
  const nowIso = new Date().toISOString();
  getDb().prepare('INSERT INTO instances (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('inst-open', 'Open', nowIso, nowIso);
  getDb().prepare('INSERT INTO instance_runs (instance_id, started_at, ready_at) VALUES (?, ?, ?)').run('inst-open', nowIso, nowIso);
  await app.close();
  activeApp = null;
  closeDb();

  const appReload = await buildApp({ skipDataLock: true });
  activeApp = appReload;
  const recoveredRow = getDb().prepare('SELECT ended_at, end_reason FROM instance_runs WHERE instance_id = ?').get('inst-open') as {
    ended_at: string | null;
    end_reason: string | null;
  };
  assert.equal(recoveredRow.end_reason, 'panel-exit');
  assert.ok(recoveredRow.ended_at !== null);

  // Switch to a second temp directory and verify shared MetricsService picks up the new dataDir cleanly.
  await appReload.close();
  activeApp = null;
  closeDb();
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-stats-route-2-'));
  t.after(() => fs.rmSync(dir2, { recursive: true, force: true }));
  process.env.MYSTRY_DATA_DIR = dir2;
  assert.notEqual(dir1, dir2);

  const app2 = await buildApp({ skipDataLock: true });
  activeApp = app2;
  const setup2 = await app2.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { 'x-setup-token': SETUP_TOKEN },
    payload: { username: 'admin12', password: 'password1234' },
  });
  const token2 = setup2.json<{ token: string }>().token;
  const metricsRes2 = await app2.inject({
    method: 'GET',
    url: '/api/system/metrics',
    headers: { authorization: `Bearer ${token2}` },
  });
  assert.equal(metricsRes2.statusCode, 200);
  assert.ok(metricsRes2.json<DashboardMetrics>().disk !== null);
});
