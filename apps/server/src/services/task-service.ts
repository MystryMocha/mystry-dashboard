import fs from 'node:fs';
import { nanoid } from 'nanoid';
import { isPanelMessage, renderPanelMessage, type PanelMessage, type TaskInfo } from '@mystry/shared';
import { config } from '../config.js';
import { getDb, type TaskRow } from '../db.js';
import { nowIso } from '../utils/path.js';
import { getInstanceRow } from './instance-service.js';
import {
  removeTaskStagingTree,
  stagingMarkerMatches,
  taskStagingDir,
} from './task-staging-service.js';
import { errorMessage, hasErrorCode, PanelError, toPanelMessage } from '../utils/errors.js';

export class TaskCapacityError extends PanelError {
  readonly code = 'TASK_CAPACITY';

  constructor() {
    super('server.tasks.capacity');
    this.name = 'TaskCapacityError';
  }
}

export class TaskShuttingDownError extends PanelError {
  readonly code = 'TASK_SHUTTING_DOWN';

  constructor() {
    super('server.tasks.shuttingDown');
    this.name = 'TaskShuttingDownError';
  }
}

export function isTaskCapacityError(error: unknown): error is TaskCapacityError {
  return error instanceof TaskCapacityError
    || hasErrorCode(error, 'TASK_CAPACITY');
}

export function isTaskShuttingDownError(error: unknown): error is TaskShuttingDownError {
  return error instanceof TaskShuttingDownError
    || hasErrorCode(error, 'TASK_SHUTTING_DOWN');
}

type TaskWorker = (
  taskId: string,
  signal: AbortSignal,
  report: (progress: number, msg: PanelMessage) => void,
) => Promise<TaskInfo['result'] | void>;

type QueuedTask = {
  task: TaskInfo;
  worker: TaskWorker;
  timeoutMs: number;
};

export type BackgroundTaskOptions = {
  /** Time limit for a single task (counted from when it starts running, excluding queue time), TASK_TIMEOUT_MS by default. */
  timeoutMs?: number;
};

const taskQueue: QueuedTask[] = [];
let runningTasks = 0;
let shuttingDown = false;
const runningControllers = new Map<string, AbortController>();
const runningExecutions = new Map<string, Promise<void>>();
/** Tasks the user asked to cancel that are waiting for the worker to finish up; on ending they are recorded as "you cancelled this task" based on this, not as ordinary failures. */
const userCancelled = new Set<string>();

type TaskResultPayload = {
  instanceId?: string;
  stagingToken?: string;
};

/** Reads the localized message column; ignored when the content is corrupted or the key no longer exists, falling back to showing the original text. */
function parseMessageColumn(value: string | null): PanelMessage | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isPanelMessage(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Task text: translatable messages write both the English text and the key; plain text (raw errors or legacy calls) writes only the original text. */
export type TaskText = PanelMessage | string;

function textColumns(value: TaskText): [text: string, i18n: string | null] {
  return typeof value === 'string'
    ? [value, null]
    : [renderPanelMessage(value), JSON.stringify(value)];
}

/** Failure reason: translatable errors keep the key, the rest use the English or raw text. */
function failureText(error: unknown): TaskText {
  return toPanelMessage(error) ?? errorMessage(error);
}

function rowToTask(row: TaskRow): TaskInfo {
  const messageI18n = parseMessageColumn(row.message_i18n);
  const errorI18n = parseMessageColumn(row.error_i18n);
  return {
    id: row.id,
    type: row.type as TaskInfo['type'],
    status: row.status as TaskInfo['status'],
    progress: row.progress,
    message: row.message,
    ...(messageI18n ? { messageI18n } : {}),
    result: row.result_json ? JSON.parse(row.result_json) : undefined,
    error: row.error ?? undefined,
    ...(errorI18n ? { errorI18n } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseTaskResult(row: TaskRow): TaskResultPayload | null {
  if (!row.result_json) return null;
  try {
    return JSON.parse(row.result_json) as TaskResultPayload;
  } catch {
    return null;
  }
}

export function createTask(type: TaskInfo['type'], message: TaskText = { key: 'server.tasks.queued' }): TaskInfo {
  const id = nanoid(12);
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO tasks (id, type, status, phase, progress, message, message_i18n, result_json, error, error_i18n, created_at, updated_at)
       VALUES (?, ?, 'pending', NULL, 0, ?, ?, NULL, NULL, NULL, ?, ?)`,
    )
    .run(id, type, ...textColumns(message), now, now);
  return getTask(id)!;
}

export function getTask(id: string): TaskInfo | null {
  const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
  return row ? rowToTask(row) : null;
}

/** Task center list: returns recent tasks in descending creation time, with limit bounded by the server. */
export function listTasks(limit = 50): TaskInfo[] {
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 200);
  const rows = getDb()
    .prepare('SELECT * FROM tasks ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(safeLimit) as TaskRow[];
  return rows.map(rowToTask);
}

export type TaskPatch = Partial<Pick<TaskInfo, 'status' | 'progress' | 'result'>> & {
  message?: TaskText;
  /** null clears the failure reason. */
  error?: TaskText | null;
};

export function updateTask(
  id: string,
  patch: TaskPatch,
  options?: { phase?: string | null },
): TaskInfo {
  const existing = getTask(id);
  if (!existing) throw new PanelError('server.tasks.notFound');
  const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow;
  const now = nowIso();
  const phase = options?.phase !== undefined ? options.phase : row.phase;
  getDb()
    .prepare(
      `UPDATE tasks SET
        status = ?,
        phase = ?,
        progress = ?,
        message = ?,
        message_i18n = ?,
        result_json = ?,
        error = ?,
        error_i18n = ?,
        updated_at = ?
      WHERE id = ?`,
    )
    .run(
      patch.status ?? existing.status,
      phase,
      patch.progress ?? existing.progress,
      ...(patch.message !== undefined ? textColumns(patch.message) : [row.message, row.message_i18n]),
      patch.result !== undefined
        ? JSON.stringify(patch.result)
        : existing.result
          ? JSON.stringify(existing.result)
          : null,
      ...(patch.error === null
        ? [null, null]
        : patch.error !== undefined
          ? textColumns(patch.error)
          : [row.error, row.error_i18n]),
      now,
      id,
    );
  return getTask(id)!;
}

/** Records task staging resources, so only half-finished directories are cleaned up after a crash. */
export function recordTaskStaging(taskId: string, instanceId: string, stagingToken: string): TaskInfo {
  return updateTask(
    taskId,
    { result: { instanceId, stagingToken } },
    { phase: 'staging' },
  );
}

/**
 * @deprecated Kept for compatibility with legacy calls; new tasks should use recordTaskStaging, and must not write to the final instance before the files have landed.
 */
export function recordTaskInstance(taskId: string, instanceId: string): TaskInfo {
  return updateTask(taskId, { result: { instanceId } }, { phase: 'staging' });
}

export type InterruptedTaskRecovery = {
  interrupted: number;
  cleanedStaging: number;
  stagingCleanupFailures: number;
};

function tryCleanInterruptedStaging(row: TaskRow): { cleaned: boolean; cleanupError: TaskText | null } {
  const result = parseTaskResult(row);
  if (!result?.instanceId || !result.stagingToken) {
    return { cleaned: false, cleanupError: null };
  }
  const stagingPath = taskStagingDir(row.id, result.instanceId, config.dataDir);
  if (!fs.existsSync(stagingPath)) {
    return { cleaned: false, cleanupError: null };
  }
  const marker = {
    version: 1 as const,
    taskId: row.id,
    instanceId: result.instanceId,
    token: result.stagingToken,
  };
  if (!stagingMarkerMatches(stagingPath, marker)) {
    return { cleaned: false, cleanupError: { key: 'server.tasks.stagingMarkerMismatch' } };
  }
  try {
    removeTaskStagingTree(row.id, result.instanceId, config.dataDir);
    return { cleaned: true, cleanupError: null };
  } catch (error) {
    return {
      cleaned: false,
      cleanupError: failureText(error),
    };
  }
}

/**
 * In-memory workers cannot be resumed across panel processes; at startup, leftover tasks are settled into the failed final state.
 * Only half-finished items provably inside .mystry-staging are cleaned up; registered instances and the final instances directory are never deleted.
 */
export function recoverInterruptedTasks(): InterruptedTaskRecovery {
  const rows = getDb()
    .prepare("SELECT * FROM tasks WHERE status IN ('pending', 'running') ORDER BY created_at")
    .all() as TaskRow[];
  let cleanedStaging = 0;
  let stagingCleanupFailures = 0;
  const update = getDb().prepare(
    `UPDATE tasks
     SET status = 'failed', phase = 'failed', message = ?, message_i18n = ?, error = ?, error_i18n = ?,
       result_json = ?, updated_at = ?
     WHERE id = ?`,
  );
  const markFailed = (error: TaskText, resultJson: string | null, id: string) => {
    update.run(...textColumns({ key: 'server.tasks.interrupted' }), ...textColumns(error), resultJson, nowIso(), id);
  };

  for (const row of rows) {
    const result = parseTaskResult(row);
    const instanceId = result?.instanceId;
    const stagingCleanup = tryCleanInterruptedStaging(row);
    if (stagingCleanup.cleaned) {
      cleanedStaging += 1;
    } else if (stagingCleanup.cleanupError) {
      stagingCleanupFailures += 1;
    }

    // The final instance directory and database record are always kept, even when the task did not complete.
    const cleanupFailed: TaskText | null = stagingCleanup.cleanupError
      ? { key: 'server.tasks.restartCleanupFailed', params: { reason: stagingCleanup.cleanupError } }
      : null;
    if (instanceId && getInstanceRow(instanceId)) {
      markFailed(cleanupFailed ?? { key: 'server.tasks.restartLostKeptInstance' }, row.result_json, row.id);
      continue;
    }

    markFailed(
      cleanupFailed ?? { key: 'server.tasks.restartLost' },
      stagingCleanup.cleaned ? null : row.result_json,
      row.id,
    );
  }

  return { interrupted: rows.length, cleanedStaging, stagingCleanupFailures };
}

function drainTaskQueue(): void {
  while (!shuttingDown && runningTasks < config.maxConcurrentTasks && taskQueue.length > 0) {
    const item = taskQueue.shift()!;
    runningTasks += 1;
    const controller = new AbortController();
    runningControllers.set(item.task.id, controller);
    const execution = executeTask(item, controller).finally(() => {
      runningTasks -= 1;
      runningControllers.delete(item.task.id);
      runningExecutions.delete(item.task.id);
      drainTaskQueue();
    });
    runningExecutions.set(item.task.id, execution);
    void execution;
  }
}

async function executeTask(item: QueuedTask, controller: AbortController): Promise<void> {
  let timedOut = false;
  let ended = false;
  let result: TaskInfo['result'] | void = undefined;
  let failure: unknown;
  let failed = false;

  try {
    updateTask(item.task.id, { status: 'running', message: item.task.messageI18n ?? item.task.message }, { phase: 'staging' });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new PanelError('server.tasks.timeout'));
    }, item.timeoutMs);

    try {
      result = await item.worker(item.task.id, controller.signal, (progress, msg) => {
        if (!ended && !controller.signal.aborted) {
          updateTask(item.task.id, { progress, message: msg, status: 'running' });
        }
      });
      // A normal return from the worker counts as success. If a timeout/shutdown lands after the return, an instance that has already landed must not be rewritten as failed.
    } catch (error) {
      failure = error;
      failed = true;
    } finally {
      clearTimeout(timeout);
      ended = true;
    }
  } catch (error) {
    failure = error;
    failed = true;
    ended = true;
  }

  // A cancel does not count once the worker has returned normally (see above), so the flag is cleared here too.
  const cancelledByUser = userCancelled.delete(item.task.id);
  if (failed) {
    const error: TaskText = timedOut
      ? { key: 'server.tasks.timeout' }
      : cancelledByUser ? { key: 'server.tasks.cancelledByUser' } : failureText(failure);
    const message: TaskText = { key: cancelledByUser && !timedOut ? 'server.tasks.cancelled' : 'server.tasks.failed' };
    updateTask(item.task.id, { status: 'failed', message, error }, { phase: 'failed' });
    return;
  }

  updateTask(item.task.id, {
    status: 'completed',
    progress: 100,
    message: { key: 'server.tasks.completed' },
    result: result ?? undefined,
  }, { phase: 'completed' });
}

export async function runBackgroundTask(
  type: TaskInfo['type'],
  message: PanelMessage,
  worker: TaskWorker,
  options: BackgroundTaskOptions = {},
): Promise<TaskInfo> {
  if (shuttingDown) {
    throw new TaskShuttingDownError();
  }
  if (runningTasks + taskQueue.length >= config.maxConcurrentTasks + config.maxQueuedTasks) {
    throw new TaskCapacityError();
  }

  const task = createTask(type, message);
  taskQueue.push({ task, worker, timeoutMs: options.timeoutMs ?? config.taskTimeoutMs });
  drainTaskQueue();

  return getTask(task.id)!;
}

/**
 * The user cancels a task. A queued one is recorded as cancelled directly; a running one has its signal aborted, and after the worker finishes up on its own (cleaning temp files)
 * executeTask records it as cancelled, so the task may still be running on return. Returns false for one that has ended or is not in this process's queue.
 * Not every task can be interrupted safely, so the caller must confirm the task type first (currently only open to one-click Java install).
 */
export function cancelTask(id: string): boolean {
  const queuedIndex = taskQueue.findIndex((item) => item.task.id === id);
  if (queuedIndex !== -1) {
    taskQueue.splice(queuedIndex, 1);
    updateTask(id, {
      status: 'failed',
      message: { key: 'server.tasks.cancelled' },
      error: { key: 'server.tasks.cancelledByUser' },
    }, { phase: 'failed' });
    return true;
  }
  const controller = runningControllers.get(id);
  if (!controller) return false;
  if (!controller.signal.aborted) {
    userCancelled.add(id);
    controller.abort(new PanelError('server.tasks.cancelledByUser'));
  }
  return true;
}

export function getTaskActivity(): { running: number; queued: number } {
  return { running: runningTasks, queued: taskQueue.length };
}

/** Stops accepting tasks, cancels queued items and waits for running tasks to finish cleaning up. */
export async function shutdownTasks(): Promise<void> {
  shuttingDown = true;

  while (taskQueue.length > 0) {
    const item = taskQueue.shift()!;
    updateTask(item.task.id, {
      status: 'failed',
      message: { key: 'server.tasks.cancelled' },
      error: { key: 'server.tasks.cancelledByShutdown' },
    }, { phase: 'failed' });
  }

  for (const controller of runningControllers.values()) {
    if (!controller.signal.aborted) {
      controller.abort(new PanelError('server.tasks.aborted'));
    }
  }

  await Promise.allSettled([...runningExecutions.values()]);
}

/** Tests only: restores the in-memory queue, so shutdownTasks does not pollute later cases. */
export function resetTaskRuntimeForTests(): void {
  shuttingDown = false;
  taskQueue.length = 0;
  runningTasks = 0;
  for (const controller of runningControllers.values()) {
    if (!controller.signal.aborted) controller.abort(new Error('测试重置'));
  }
  runningControllers.clear();
  runningExecutions.clear();
  userCancelled.clear();
}

