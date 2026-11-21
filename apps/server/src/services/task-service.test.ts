/**
 * 任务 staging 与保守恢复回归。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function prepareTempDataRoot(t: test.TestContext): string {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-task-service-test-'));
  t.after(async () => {
    try {
      const { closeDb } = await import('../db.js');
      closeDb();
    } catch {
      /* 模块可能尚未加载 */
    }
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });
  process.env.MYSTRY_DATA_DIR = dataRoot;
  process.env.JWT_SECRET = 'a'.repeat(64);
  process.env.SETUP_TOKEN = 'b'.repeat(64);
  return dataRoot;
}

test('recoverInterruptedTasks 不得因 result.instanceId 删除最终实例', async (t) => {
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

test('仅清理 .mystry-staging 内 marker 匹配且任务未完成的半成品', async (t) => {
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

test('worker 正常返回后即使任务已中止也保持成功', async (t) => {
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

test('runBackgroundTask 的 timeoutMs 覆盖全局 TASK_TIMEOUT_MS', async (t) => {
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

test('cancelTask：排队的直接取消，运行中的等 worker 收尾后记成用户取消，已结束的不认', async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { config } = await import('../config.js');
  const { runBackgroundTask, getTask, cancelTask, resetTaskRuntimeForTests } = await import('./task-service.js');
  t.after(() => {
    resetTaskRuntimeForTests();
  });
  initDb();

  let cleanedUp = 0;
  // worker 被中止时抛自己的错误：任务结果仍要写成「你取消了这个任务」。
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

test('任务消息以键和参数存库，旧库自动补列且旧任务原文照常读取', async (t) => {
  const dataRoot = prepareTempDataRoot(t);
  // 模拟升级前的 panel.db：tasks 表没有 message_i18n / error_i18n，且已有一条中文旧任务。
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

  // 原始文本错误只存原文，同时清掉旧的消息键。
  const raw = updateTask(task.id, { error: 'ENOSPC: no space left on device' });
  assert.equal(raw.error, 'ENOSPC: no space left on device');
  assert.equal(raw.errorI18n, undefined);
});
