/**
 * Task staging and conservative recovery regression.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TaskInfo } from '@mystry/shared';

function prepareTempDataRoot(t: test.TestContext): string {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-task-service-test-'));
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

test('recoverInterruptedTasks must not delete the final instance because of result.instanceId', async (t) => {
  prepareTempDataRoot(t);
  const { initDb, getDb } = await import('../db.js');
  const { createInstance, getInstanceRow } = await import('./instance-service.js');
  const { createTask, recordTaskInstance, recoverInterruptedTasks } = await import('./task-service.js');

  initDb();
  const inst = createInstance({ name: 'recovery-stub' });
  const task = createTask('deploy', '模拟中断');
  recordTaskInstance(task.id, inst.id);
  getDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(task.id);

  const instanceDir = path.join(process.env.MYSTRY_DATA_DIR!, 'instances', inst.id);
  assert.ok(fs.existsSync(instanceDir), '前置：实例目录应已创建');

  recoverInterruptedTasks();

  assert.ok(
    fs.existsSync(instanceDir) && getInstanceRow(inst.id),
    '恢复逻辑不得 deleteInstance 已落地的最终目录',
  );
});

test('only half-finished items inside .mystry-staging with a matching marker and an unfinished task are cleaned up', async (t) => {
  const dataRoot = prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { createTask, recordTaskStaging, recoverInterruptedTasks } = await import('./task-service.js');
  const { prepareTaskStaging, taskStagingDir } = await import('./task-staging-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const task = createTask('deploy', 'staging 中断');
  const { getDb } = await import('../db.js');
  getDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(task.id);
  const instanceId = 'staginginst01';
  const token = 'token-staging-test-32chars-long!!';
  recordTaskStaging(task.id, instanceId, token);
  const stagingPath = prepareTaskStaging(task.id, instanceId, token, dataRoot);
  fs.writeFileSync(path.join(stagingPath, 'server.jar'), 'partial', 'utf8');

  const finalInstanceId = 'finalinst001';
  const finalDir = defaultInstanceDir(finalInstanceId);
  fs.mkdirSync(finalDir, { recursive: true });
  fs.writeFileSync(path.join(finalDir, 'world.dat'), 'keep-me', 'utf8');

  const recovery = recoverInterruptedTasks();
  assert.equal(recovery.cleanedStaging, 1);
  assert.equal(fs.existsSync(taskStagingDir(task.id, instanceId, dataRoot)), false);
  assert.ok(fs.existsSync(finalDir), '与任务无关的最终目录必须保留');
});

test('the task stays successful once the worker returned normally, even if it was aborted', async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { createInstance, getInstanceRow } = await import('./instance-service.js');
  const {
    runBackgroundTask,
    getTask,
    shutdownTasks,
    resetTaskRuntimeForTests,
  } = await import('./task-service.js');

  t.after(() => {
    resetTaskRuntimeForTests();
  });

  initDb();
  const inst = createInstance({ name: 'task-keep-success' });
  let workerEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    workerEntered = resolve;
  });

  const task = await runBackgroundTask('import', { key: 'server.tasks.queued' }, async () => {
    workerEntered();
    await new Promise((resolve) => setTimeout(resolve, 80));
    return { instanceId: inst.id };
  });

  await entered;
  await shutdownTasks();

  const current = getTask(task.id);
  assert.equal(current?.status, 'completed');
  assert.equal(current?.result?.instanceId, inst.id);
  assert.ok(getInstanceRow(inst.id));
});

test('timeoutMs of runBackgroundTask overrides the global TASK_TIMEOUT_MS', async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { config } = await import('../config.js');
  const { runBackgroundTask, getTask, resetTaskRuntimeForTests } = await import('./task-service.js');
  t.after(() => {
    resetTaskRuntimeForTests();
  });
  initDb();
  assert.ok(config.taskTimeoutMs > 1000, '前置：全局超时远大于本用例的时限');

  const task = await runBackgroundTask('backup', { key: 'server.tasks.queued' }, (_taskId, signal) => (
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })
  ), { timeoutMs: 30 });

  let current = getTask(task.id);
  for (let attempt = 0; attempt < 200 && current?.status !== 'failed'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    current = getTask(task.id);
  }
  assert.equal(current?.status, 'failed');
  assert.equal(current?.errorI18n?.key, 'server.tasks.timeout');
});

test('onlyWhenIdle refuses a task while another is running or waiting, although the queue has room', async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { config } = await import('../config.js');
  const { runBackgroundTask, getTask, getTaskActivity, isTaskCapacityError, isTaskQueueIdle, resetTaskRuntimeForTests } = await import('./task-service.js');
  t.after(() => {
    resetTaskRuntimeForTests();
  });
  initDb();
  assert.ok(config.maxConcurrentTasks + config.maxQueuedTasks > 1, '前置：队列在一个任务之外还有空位');

  let finish!: () => void;
  const held = await runBackgroundTask('download', { key: 'server.tasks.queued' }, () => new Promise<void>((resolve) => {
    finish = resolve;
  }), { onlyWhenIdle: true });
  assert.equal(getTask(held.id)?.status, 'running', '空闲时照常接受');
  assert.equal(isTaskQueueIdle(), false);

  await assert.rejects(
    runBackgroundTask('backup', { key: 'server.tasks.queued' }, async () => {}, { onlyWhenIdle: true }),
    isTaskCapacityError,
  );
  assert.deepEqual(getTaskActivity(), { running: 1, queued: 0 }, '被拒绝的任务不留记录在队列里');
  const ordinary = await runBackgroundTask('download', { key: 'server.tasks.queued' }, async () => {});
  assert.equal(getTask(ordinary.id)?.status, 'pending', '没有这个选项的任务仍可排队');

  finish();
  for (let attempt = 0; attempt < 200 && !isTaskQueueIdle(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(isTaskQueueIdle(), true);
});

test('cancelTask: a queued one is cancelled directly, a running one is recorded as cancelled by the user after the worker finishes up, and a finished one is not accepted', async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { config } = await import('../config.js');
  const { runBackgroundTask, getTask, cancelTask, resetTaskRuntimeForTests } = await import('./task-service.js');
  t.after(() => {
    resetTaskRuntimeForTests();
  });
  initDb();

  let cleanedUp = 0;
  // When the worker is aborted it throws its own error: the task result must still be written as "you cancelled this task".
  const blocking = (_taskId: string, signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      cleanedUp += 1;
      reject(new Error('worker 自己的中止错误'));
    }, { once: true });
  });
  const running = [];
  for (let index = 0; index < config.maxConcurrentTasks; index += 1) {
    running.push(await runBackgroundTask('download', { key: 'server.tasks.queued' }, blocking));
  }
  const queued = await runBackgroundTask('download', { key: 'server.tasks.queued' }, async () => {
    throw new Error('取消后的排队任务不该运行');
  });
  assert.equal(getTask(queued.id)?.status, 'pending');

  assert.equal(cancelTask(queued.id), true);
  const queuedAfter = getTask(queued.id);
  assert.equal(queuedAfter?.status, 'failed');
  assert.equal(queuedAfter?.messageI18n?.key, 'server.tasks.cancelled');
  assert.equal(queuedAfter?.errorI18n?.key, 'server.tasks.cancelledByUser');

  const target = running[0]!;
  assert.equal(cancelTask(target.id), true);
  let current = getTask(target.id);
  for (let attempt = 0; attempt < 200 && current?.status !== 'failed'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    current = getTask(target.id);
  }
  assert.equal(current?.status, 'failed');
  assert.equal(current?.messageI18n?.key, 'server.tasks.cancelled');
  assert.equal(current?.errorI18n?.key, 'server.tasks.cancelledByUser');
  assert.equal(cleanedUp, 1, '只中止被取消的那个任务');

  assert.equal(cancelTask(target.id), false);
  assert.equal(cancelTask('missing-task'), false);
});

test('onSettled is called once however the task ends: after its worker, when it fails before the worker is called, and when it is cancelled or shut down while waiting', async (t) => {
  prepareTempDataRoot(t);
  const { initDb, getDb } = await import('../db.js');
  const { config } = await import('../config.js');
  const { runBackgroundTask, getTask, cancelTask, shutdownTasks, resetTaskRuntimeForTests } = await import('./task-service.js');
  t.after(() => {
    resetTaskRuntimeForTests();
  });
  initDb();
  assert.ok(config.maxQueuedTasks >= 2, '前置：队列能同时容纳两个等待中的任务');

  const settled: string[] = [];
  const mark = (name: string) => () => {
    settled.push(name);
  };
  const untilSettled = async (count: number) => {
    for (let attempt = 0; attempt < 200 && settled.length < count; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(settled.length, count, `已收尾：${settled.join('、')}`);
  };
  const queued = { key: 'server.tasks.queued' } as const;

  const returned = await runBackgroundTask('download', queued, async () => {}, { onSettled: mark('returned') });
  await untilSettled(1);
  assert.equal(getTask(returned.id)?.status, 'completed');

  const threw = await runBackgroundTask('download', queued, async () => {
    throw new Error('worker 出错');
  }, { onSettled: mark('threw') });
  await untilSettled(2);
  assert.equal(getTask(threw.id)?.status, 'failed');

  // Stands in for a write error at the moment the task is marked as running, which ends it before its worker is called.
  let workerCalled = false;
  getDb().exec(`CREATE TRIGGER refuse_running BEFORE UPDATE ON tasks WHEN NEW.status = 'running'
    BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`);
  let neverRan: TaskInfo;
  try {
    neverRan = await runBackgroundTask('download', queued, async () => {
      workerCalled = true;
    }, { onSettled: mark('failed before the worker') });
  } finally {
    getDb().exec('DROP TRIGGER refuse_running');
  }
  await untilSettled(3);
  assert.equal(getTask(neverRan.id)?.status, 'failed');
  assert.equal(workerCalled, false);

  for (let index = 0; index < config.maxConcurrentTasks; index += 1) {
    await runBackgroundTask('download', queued, (_taskId, signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
  }
  const waiting = async (name: string) => runBackgroundTask('download', queued, async () => {
    workerCalled = true;
  }, { onSettled: mark(name) });
  const cancelled = await waiting('cancelled while waiting');
  const shutDown = await waiting('shut down while waiting');
  assert.equal(getTask(shutDown.id)?.status, 'pending');
  assert.equal(settled.length, 3, '还在等待的任务不算结束');

  assert.equal(cancelTask(cancelled.id), true);
  assert.equal(settled.length, 4);
  await shutdownTasks();
  assert.equal(getTask(shutDown.id)?.status, 'failed');
  assert.equal(workerCalled, false);
  assert.deepEqual(settled, [
    'returned',
    'threw',
    'failed before the worker',
    'cancelled while waiting',
    'shut down while waiting',
  ]);
});

test('task messages are stored as key and params, old databases get the columns added, and old task text is still read as is', async (t) => {
  const dataRoot = prepareTempDataRoot(t);
  // Simulates a pre-upgrade panel.db: the tasks table has no message_i18n / error_i18n, and already holds one old task in Chinese.
  const { DatabaseSync } = await import('node:sqlite');
  const legacy = new DatabaseSync(path.join(dataRoot, 'panel.db'));
  legacy.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, progress REAL NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT '', result_json TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  legacy.prepare(
    `INSERT INTO tasks (id, type, status, progress, message, error, created_at, updated_at)
     VALUES ('legacy', 'deploy', 'failed', 100, '失败', '下载失败', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run();
  legacy.close();

  const { initDb, getDb } = await import('../db.js');
  const { createTask, getTask, updateTask } = await import('./task-service.js');
  const { PanelError } = await import('../utils/errors.js');
  initDb();

  const columns = (getDb().prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(columns.includes('message_i18n') && columns.includes('error_i18n'), '旧库应自动补上两列');
  const old = getTask('legacy');
  assert.equal(old?.message, '失败');
  assert.equal(old?.error, '下载失败');
  assert.equal(old?.messageI18n, undefined);
  assert.equal(old?.errorI18n, undefined);

  const task = createTask('import');
  assert.deepEqual(task.messageI18n, { key: 'server.tasks.queued' });
  assert.equal(task.message, 'Queued');

  const cleanup = new PanelError('server.tasks.stagingMarkerMismatch');
  const failed = updateTask(task.id, {
    status: 'failed',
    message: { key: 'server.tasks.failed' },
    error: { key: 'server.tasks.restartCleanupFailed', params: { reason: cleanup.toPanelMessage() } },
  });
  assert.equal(failed.message, 'Failed');
  assert.deepEqual(failed.errorI18n, {
    key: 'server.tasks.restartCleanupFailed',
    params: { reason: { key: 'server.tasks.stagingMarkerMismatch' } },
  });
  assert.match(failed.error ?? '', /^The panel restarted .*Cleaning up its temporary folder failed: The task marker/);

  // Raw text errors store only the original text, and also clear the old message key.
  const raw = updateTask(task.id, { error: 'ENOSPC: no space left on device' });
  assert.equal(raw.error, 'ENOSPC: no space left on device');
  assert.equal(raw.errorI18n, undefined);
});

test('terminal task persistence failures do not become unhandled rejections or wedge the queue', async (t) => {
  prepareTempDataRoot(t);
  const { initDb, getDb } = await import('../db.js');
  const {
    runBackgroundTask,
    getTask,
    isTaskQueueIdle,
    shutdownTasks,
    resetTaskRuntimeForTests,
  } = await import('./task-service.js');
  t.after(() => {
    resetTaskRuntimeForTests();
  });
  initDb();

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => {
    process.off('unhandledRejection', onUnhandled);
  });

  getDb().exec(`CREATE TRIGGER refuse_terminal BEFORE UPDATE ON tasks
    WHEN NEW.status IN ('completed', 'failed')
    BEGIN SELECT RAISE(ABORT, 'simulated disk full'); END`);

  const settled: string[] = [];
  try {
    await runBackgroundTask('download', { key: 'server.tasks.queued' }, async () => {}, {
      onSettled: () => settled.push('completed'),
    });
    await runBackgroundTask('download', { key: 'server.tasks.queued' }, async () => {
      throw new Error('worker failed');
    }, {
      onSettled: () => settled.push('failed'),
    });

    for (let attempt = 0; attempt < 200 && settled.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(settled, ['completed', 'failed']);
    assert.equal(isTaskQueueIdle(), true);
    assert.deepEqual(unhandled, [], 'terminal updateTask failures must never become unhandled rejections');

    // Also verify shutdownTasks settles queued tasks without throwing if SQLite refuses writes during shutdown.
    let releaseBlocker!: () => void;
    const blockerGate = new Promise<void>((resolve) => { releaseBlocker = resolve; });
    await runBackgroundTask('download', { key: 'server.tasks.queued' }, () => blockerGate);
    let queuedSettled = false;
    await runBackgroundTask('download', { key: 'server.tasks.queued' }, async () => {}, {
      onSettled: () => { queuedSettled = true; },
    });
    const shutdownPromise = shutdownTasks();
    releaseBlocker();
    await shutdownPromise;
    assert.equal(queuedSettled, true);
  } finally {
    getDb().exec('DROP TRIGGER refuse_terminal');
  }

  resetTaskRuntimeForTests();
  const after = await runBackgroundTask('download', { key: 'server.tasks.queued' }, async () => ({ ok: true }));
  for (let attempt = 0; attempt < 200 && getTask(after.id)?.status !== 'completed'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(getTask(after.id)?.status, 'completed');
});

test('high-frequency progress reports are throttled and deduplicated while flushing stage changes and trailing updates', async (t) => {
  prepareTempDataRoot(t);
  const { initDb, getDb } = await import('../db.js');
  const { runBackgroundTask, getTask, resetTaskRuntimeForTests } = await import('./task-service.js');
  t.after(() => {
    resetTaskRuntimeForTests();
  });
  initDb();

  getDb().exec(`
    CREATE TABLE task_update_log (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL);
    CREATE TRIGGER count_task_updates AFTER UPDATE ON tasks
    BEGIN
      INSERT INTO task_update_log (task_id) VALUES (NEW.id);
    END;
  `);

  let observedAfterFlush: number | undefined;
  const task = await runBackgroundTask('download', { key: 'server.tasks.queued' }, async (taskId, _signal, report) => {
    // Burst of 200 per-chunk progress callbacks within a single stage (including duplicate values).
    for (let i = 1; i <= 200; i += 1) {
      report(10 + Math.floor(i / 4), {
        key: 'server.deploy.progress.downloadingFrom',
        params: { source: 'PaperMC', percent: Math.floor(i / 2) },
      });
    }
    // Wait slightly beyond the throttle interval so the trailing progress update flushes to SQLite.
    await new Promise((resolve) => setTimeout(resolve, 320));
    observedAfterFlush = getTask(taskId)?.progress;

    // A stage change must write immediately without waiting for another throttle interval.
    report(95, { key: 'server.deploy.progress.writingConfig' });
    assert.equal(getTask(taskId)?.messageI18n?.key, 'server.deploy.progress.writingConfig');
  });

  for (let attempt = 0; attempt < 200 && getTask(task.id)?.status !== 'completed'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(getTask(task.id)?.status, 'completed');
  assert.equal(observedAfterFlush, 60, 'latest progress from the burst must flush within the throttle window');

  const row = getDb()
    .prepare('SELECT COUNT(*) AS c FROM task_update_log WHERE task_id = ?')
    .get(task.id) as { c: number };
  assert.ok(row.c <= 10, `expected throttled SQLite updates (<= 10), got ${row.c}`);
});
