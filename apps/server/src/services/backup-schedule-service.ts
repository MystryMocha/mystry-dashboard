import {
  BACKUP_SCHEDULE_MAX_KEEP,
  BACKUP_SCHEDULE_TIME_PATTERN,
  isPanelMessage,
  type BackupInfo,
  type BackupScheduleInfo,
  type BackupScheduleInput,
  type InstanceStatus,
  type PanelMessage,
} from '@mystry/shared';
import { getDb, type BackupScheduleRow } from '../db.js';
import { errorMessage, PanelError, toPanelMessage } from '../utils/errors.js';
import { getBackup, requireManagedInstance, startScheduledBackupTask } from './backup-service.js';
import { processManager } from './process-manager.js';
import { isTaskCapacityError, isTaskQueueIdle, isTaskShuttingDownError } from './task-service.js';

/** Product choices for scheduled backups, kept in one place because they may change. */
export const BACKUP_SCHEDULE_DEFAULTS = {
  /** Time of day of the daily backup, on the clock of the computer the panel runs on. */
  time: '04:00',
  /** How many scheduled backups an instance keeps. */
  keep: 7,
  /** Free space a scheduled run needs on top of the size of the instance's previous backup. */
  freeSpaceMarginBytes: 256 * 1024 * 1024,
  /** How often the scheduler looks for a backup that is due. */
  checkIntervalMs: 60_000,
  /** How many times one day's backup is tried when the server starting, stopping or crashing cuts it short. */
  maxInterruptedAttempts: 3,
} as const;

const TIME_OF_DAY = new RegExp(BACKUP_SCHEDULE_TIME_PATTERN);

/** What a wall clock shows at one moment: the calendar date (YYYY-MM-DD) and the minutes since midnight. */
export type WallClock = { date: string; minutes: number };

/** Reads the wall clock of `timeZone` (an IANA name), or of the computer the panel runs on when none is given. */
export function wallClockAt(instant: Date, timeZone?: string): WallClock {
  // Built on every call: a format without a time zone fixes the system zone it found when it was created.
  const parts = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    minutes: Number(part('hour')) * 60 + Number(part('minute')),
  };
}

function previousDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! - 1)).toISOString().slice(0, 10);
}

/**
 * The date of the latest daily slot that has come: today once the clock reads the scheduled time or later, otherwise yesterday.
 * A slot is a calendar date rather than an instant, and no instant is ever built from a local time, which is what keeps
 * daylight-saving changes harmless. A time the clock skips comes due at the first minute after the gap. A time the clock
 * shows twice comes due the first time; when the clock is set back, the latest slot reads as yesterday's again, and by the
 * second time today's date is already settled.
 */
export function latestSlot(clock: WallClock, time: string): string {
  const [hours, minutes] = time.split(':').map(Number);
  return clock.minutes >= hours! * 60 + minutes! ? clock.date : previousDate(clock.date);
}

function readRow(instanceId: string): BackupScheduleRow | undefined {
  return getDb().prepare('SELECT * FROM instance_backup_schedules WHERE instance_id = ?').get(instanceId) as
    | BackupScheduleRow
    | undefined;
}

function parseFailure(value: string | null): PanelMessage | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isPanelMessage(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toInfo(row: BackupScheduleRow | undefined, now: Date): BackupScheduleInfo {
  const errorI18n = parseFailure(row?.last_failure_i18n ?? null);
  return {
    enabled: row?.enabled === 1,
    time: row?.time_of_day ?? BACKUP_SCHEDULE_DEFAULTS.time,
    keep: row?.keep_count ?? BACKUP_SCHEDULE_DEFAULTS.keep,
    // `|| 0` turns the -0 of a computer on UTC into 0.
    utcOffsetMinutes: -now.getTimezoneOffset() || 0,
    lastBackupAt: row?.last_backup_at ?? null,
    lastFailure: row?.last_failure_at
      ? { at: row.last_failure_at, error: row.last_failure ?? '', ...(errorI18n ? { errorI18n } : {}) }
      : null,
  };
}

export function getBackupSchedule(instanceId: string, now = new Date()): BackupScheduleInfo {
  requireManagedInstance(instanceId);
  return toInfo(readRow(instanceId), now);
}

/**
 * Saves the schedule. Turning it on, or changing its time while it is on, settles every slot up to now, so the first
 * backup is at the next occurrence of the chosen time rather than at once for a time of day that has already passed.
 */
export function saveBackupSchedule(
  instanceId: string,
  input: BackupScheduleInput,
  options: { now?: Date; timeZone?: string } = {},
): BackupScheduleInfo {
  requireManagedInstance(instanceId);
  if (
    typeof input.enabled !== 'boolean'
    || typeof input.time !== 'string'
    || !TIME_OF_DAY.test(input.time)
    || !Number.isSafeInteger(input.keep)
    || input.keep < 1
    || input.keep > BACKUP_SCHEDULE_MAX_KEEP
  ) {
    throw new PanelError('server.backups.schedule.invalidParams', undefined, { statusCode: 400 });
  }
  const now = options.now ?? new Date();
  const existing = readRow(instanceId);
  const startsAfresh = input.enabled && (existing?.enabled !== 1 || existing.time_of_day !== input.time);
  const lastSlot = startsAfresh
    ? latestSlot(wallClockAt(now, options.timeZone), input.time)
    : existing?.last_slot ?? null;
  const timestamp = now.toISOString();
  getDb()
    .prepare(
      `INSERT INTO instance_backup_schedules (instance_id, enabled, time_of_day, keep_count, last_slot, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(instance_id) DO UPDATE SET
         enabled = excluded.enabled,
         time_of_day = excluded.time_of_day,
         keep_count = excluded.keep_count,
         last_slot = excluded.last_slot,
         updated_at = excluded.updated_at`,
    )
    .run(instanceId, input.enabled ? 1 : 0, input.time, input.keep, lastSlot, timestamp, timestamp);
  return toInfo(readRow(instanceId), now);
}

/**
 * Records that the server has run since its last scheduled backup. It is called from a process status event, which is
 * also emitted from inside the child's exit handler, so it must never throw.
 */
export function noteInstanceStatus(instanceId: string, status: InstanceStatus): void {
  if (status !== 'running') return;
  try {
    getDb()
      .prepare('UPDATE instance_backup_schedules SET server_ran = 1 WHERE instance_id = ? AND server_ran = 0')
      .run(instanceId);
  } catch (error) {
    console.warn(`未能记录实例 ${instanceId} 在上次定时备份后运行过`, error);
  }
}

let lifecycleAttached = false;

export function attachBackupScheduleLifecycle(): void {
  if (lifecycleAttached) return;
  lifecycleAttached = true;
  processManager.on('status', noteInstanceStatus);
}

/** Marks every slot up to `slot` as settled. Never moves backwards: the schedule may have been saved again while a backup ran. */
function settleSlot(instanceId: string, slot: string): void {
  getDb()
    .prepare("UPDATE instance_backup_schedules SET last_slot = MAX(COALESCE(last_slot, ''), ?) WHERE instance_id = ?")
    .run(slot, instanceId);
}

function recordSuccess(instanceId: string, slot: string, info: BackupInfo): void {
  getDb()
    .prepare(
      `UPDATE instance_backup_schedules SET
         last_slot = MAX(COALESCE(last_slot, ''), ?),
         last_backup_at = ?,
         last_backup_id = ?,
         server_ran = ?,
         last_failure_at = NULL,
         last_failure = NULL,
         last_failure_i18n = NULL
       WHERE instance_id = ?`,
    )
    // A server that was running when the backup was taken has gone on changing the world since, so it counts as having run.
    .run(slot, info.createdAt, info.id, info.wasRunning ? 1 : 0, instanceId);
}

function recordFailure(instanceId: string, slot: string, error: unknown, at: Date): void {
  const message = toPanelMessage(error);
  getDb()
    .prepare(
      `UPDATE instance_backup_schedules SET
         last_slot = MAX(COALESCE(last_slot, ''), ?),
         last_failure_at = ?,
         last_failure = ?,
         last_failure_i18n = ?
       WHERE instance_id = ?`,
    )
    .run(slot, at.toISOString(), errorMessage(error), message ? JSON.stringify(message) : null, instanceId);
}

/**
 * Whether another scheduled backup would only repeat the latest one: that backup is still there, and the server has not
 * run since it was taken.
 */
function isUnchangedSinceLastBackup(row: BackupScheduleRow): boolean {
  if (row.last_backup_id === null || row.server_ran === 1) return false;
  if (processManager.getStatus(row.instance_id) === 'running') return false;
  try {
    getBackup(row.instance_id, row.last_backup_id);
    return true;
  } catch {
    return false;
  }
}

/**
 * The server started, stopped or crashed under the run. Unlike a full disk or a file that cannot be read, that says
 * nothing about the next attempt, so the day is not given up at once.
 */
function isInterruptedByServerState(error: unknown): boolean {
  return error instanceof PanelError
    && (error.messageKey === 'server.backups.serverStateChanged'
      || error.messageKey === 'server.backups.lifecycleBusy');
}

/** The reason the task queue gives the tasks it aborts when the panel shuts down. */
function isAbortedByShutdown(error: unknown): boolean {
  return error instanceof PanelError && error.messageKey === 'server.tasks.aborted';
}

/** Not being able to queue now is no failure: nothing is recorded and the slot stays due for the next check. */
function isDeferral(error: unknown): boolean {
  return isTaskCapacityError(error)
    || isTaskShuttingDownError(error)
    || (error instanceof PanelError && error.statusCode === 409);
}

export type BackupSchedulerOptions = {
  /** The clock the scheduler reads; replaced in tests. */
  now?: () => Date;
  /** IANA time zone the time of day is read in; the panel computer's own when omitted. Set in tests only. */
  timeZone?: string;
  /** See ScheduledBackupOptions.readFreeBytes. */
  readFreeBytes?: (dir: string) => number | null;
};

export type BackupScheduler = {
  /** Starts checking once per interval; the first check is one interval after the call. */
  start(): void;
  /** Stops checking. A backup already queued or running is left to the task queue. */
  stop(): void;
  /** Runs one check now; does nothing while another check is still running or after stop(). */
  check(): Promise<void>;
};

export function createBackupScheduler(options: BackupSchedulerOptions = {}): BackupScheduler {
  const now = options.now ?? (() => new Date());
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let checking = false;
  /** Per instance, the runs of its current slot that the server cut short. An entry for an earlier slot counts for nothing. */
  const interruptedAttempts = new Map<string, { slot: string; count: number }>();

  async function queueBackup(row: BackupScheduleRow, slot: string): Promise<void> {
    const instanceId = row.instance_id;
    try {
      await startScheduledBackupTask(instanceId, {
        keep: () => readRow(instanceId)?.keep_count ?? null,
        freeSpaceMarginBytes: BACKUP_SCHEDULE_DEFAULTS.freeSpaceMarginBytes,
        readFreeBytes: options.readFreeBytes,
        onCreated: (info) => {
          interruptedAttempts.delete(instanceId);
          try {
            recordSuccess(instanceId, slot, info);
          } catch (error) {
            console.warn(`未能记录实例 ${instanceId} 的定时备份结果`, error);
          }
        },
        onFailed: (error) => {
          // A run cut short by the panel shutting down stays due, and is made up after the next start. One that failed
          // for a reason of its own while the panel was closing is recorded like any other.
          if (stopped && isAbortedByShutdown(error)) return;
          // Nothing is recorded for a run that will be tried again, so the slot stays due for the next check.
          if (isInterruptedByServerState(error)) {
            const previous = interruptedAttempts.get(instanceId);
            const count = (previous?.slot === slot ? previous.count : 0) + 1;
            if (count < BACKUP_SCHEDULE_DEFAULTS.maxInterruptedAttempts) {
              interruptedAttempts.set(instanceId, { slot, count });
              return;
            }
          }
          interruptedAttempts.delete(instanceId);
          try {
            recordFailure(instanceId, slot, error, now());
          } catch (recordError) {
            console.warn(`未能记录实例 ${instanceId} 的定时备份失败原因`, recordError);
          }
        },
      });
    } catch (error) {
      if (!isDeferral(error)) console.warn(`未能为实例 ${instanceId} 排入定时备份`, error);
    }
  }

  async function runCheck(): Promise<void> {
    const clock = wallClockAt(now(), options.timeZone);
    // Oldest settled slot first, so an instance that keeps being busy does not hold back the ones behind it for good.
    const rows = getDb()
      .prepare('SELECT * FROM instance_backup_schedules WHERE enabled = 1 ORDER BY last_slot, instance_id')
      .all() as BackupScheduleRow[];
    for (const row of rows) {
      if (stopped) return;
      const instanceId = row.instance_id;
      const slot = latestSlot(clock, row.time_of_day);
      if (row.last_slot === null || row.last_slot > clock.date) {
        // The settled date is ahead of today: the clock was set back, or the time zone changed. Start again from here
        // instead of waiting for the clock to catch up. It is compared with today rather than with the latest slot,
        // because in the hour a daylight-saving change repeats, the latest slot reads as yesterday's once more.
        getDb().prepare('UPDATE instance_backup_schedules SET last_slot = ? WHERE instance_id = ?').run(slot, instanceId);
        continue;
      }
      if (row.last_slot >= slot) {
        // A day can come due a second time, when the time of day is changed or the clock is set back. Its runs are then
        // counted from the first again.
        interruptedAttempts.delete(instanceId);
        continue;
      }
      // An instance in the middle of something is asked again at the next check, and before it is judged unchanged:
      // a server on its way up does not count as having run yet, and a restore has not replaced the files yet.
      const status = processManager.getStatus(instanceId);
      if (status === 'starting' || status === 'stopping' || processManager.getMaintenance(instanceId) !== null) continue;
      // Another copy of files that have not changed would only push an older, different one out of the kept set.
      if (isUnchangedSinceLastBackup(row)) {
        settleSlot(instanceId, slot);
        continue;
      }
      // A scheduled backup starts only while no other task is running or waiting, so it never takes a place in the
      // queue from work the user asked for. Its own task then keeps the others that are due waiting for a later check.
      if (!isTaskQueueIdle()) continue;
      await queueBackup(row, slot);
    }
  }

  async function check(): Promise<void> {
    if (stopped || checking) return;
    checking = true;
    try {
      await runCheck();
    } catch (error) {
      console.warn('检查定时备份计划时出错', error);
    } finally {
      checking = false;
    }
  }

  return {
    start() {
      stopped = false;
      if (timer) return;
      // check() never rejects; an unhandled rejection would take the whole panel down.
      timer = setInterval(() => void check(), BACKUP_SCHEDULE_DEFAULTS.checkIntervalMs);
      timer.unref();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
    check,
  };
}

export const backupScheduler = createBackupScheduler();
