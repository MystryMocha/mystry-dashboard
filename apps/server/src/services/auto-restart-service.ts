import type { AutoRestartSettings, InstanceAutoRestartState, InstanceStatus } from '@mystry/shared';
import { getDb, type InstanceRow } from '../db.js';
import { errorMessage, PanelError, toPanelMessage } from '../utils/errors.js';
import { getAutoRestartSettings } from './auto-restart-settings.js';
import { getJavaRuntime } from './java-runtime-service.js';
import { processManager, type ProcessManager } from './process-manager.js';

type TimerHandle = unknown;

export type AutoRestartDeps = {
  processManager: ProcessManager;
  loadInstance(instanceId: string): InstanceRow | null;
  loadSettings(): AutoRestartSettings;
  now(): number;
  /** The callback's promise settles once the restart attempt is over and never rejects; a test clock can await it. */
  setTimer(callback: () => Promise<void>, delayMs: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
};

/** The numbers are the ones saved when the crash happened: a change to the settings applies from the next crash. */
type PendingRestart = {
  at: number;
  attempt: number;
  max: number;
  timer: TimerHandle;
};

/** The automatic restarts made in a row so far. */
type RestartSeries = {
  count: number;
  lastRestartAt: number;
};

type RestartOutcome = Exclude<InstanceAutoRestartState, { state: 'scheduled' }>;

function isRefusalWithKey(error: unknown, ...keys: string[]): boolean {
  return error instanceof PanelError && keys.includes(error.messageKey);
}

/**
 * Starts a server again after it crashes, while the panel-wide setting is on. It only decides when: the start itself
 * is ProcessManager.start with a freshly read instance record, so the instance lock, the maintenance and detached-process
 * refusals, JVM argument validation and the Java runtime check apply exactly as for a start from the UI.
 *
 * The instance record is read straight from the database: instance-service reports the restart state in the instance
 * info, so importing it here would be circular.
 */
export class AutoRestartService {
  private readonly deps: AutoRestartDeps;
  private readonly pending = new Map<string, PendingRestart>();
  private readonly series = new Map<string, RestartSeries>();
  private readonly outcomes = new Map<string, RestartOutcome>();
  /** Instances this service is starting right now, to tell its own `starting` event from a start by the user. */
  private readonly ownStarts = new Set<string>();
  private attached = false;
  private shuttingDown = false;

  constructor(deps: Partial<AutoRestartDeps> = {}) {
    this.deps = {
      processManager,
      loadInstance: (instanceId) =>
        (getDb().prepare('SELECT * FROM instances WHERE id = ?').get(instanceId) as InstanceRow | undefined) ?? null,
      loadSettings: getAutoRestartSettings,
      now: Date.now,
      setTimer: (callback, delayMs) => setTimeout(() => void callback(), delayMs),
      clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
      ...deps,
    };
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.deps.processManager.on('status', this.onStatus);
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.deps.processManager.off('status', this.onStatus);
  }

  /** For the instance info: the restart that is waiting, or why the latest crash was not restarted. */
  getState(instanceId: string): InstanceAutoRestartState | null {
    const pending = this.pending.get(instanceId);
    if (!pending) return this.outcomes.get(instanceId) ?? null;
    return {
      state: 'scheduled',
      attempt: pending.attempt,
      max: pending.max,
      at: new Date(pending.at).toISOString(),
      remainingMs: Math.max(0, pending.at - this.deps.now()),
    };
  }

  /**
   * Drops the restart that is waiting and whatever was reported about the latest crash; the instance stays as it is.
   * Called for the cancel button and when a restore begins: a restore leaves the instance crashed, and the server
   * must not start by itself on files that were just replaced.
   */
  cancel(instanceId: string): void {
    this.outcomes.delete(instanceId);
    const pending = this.pending.get(instanceId);
    if (!pending) return;
    this.pending.delete(instanceId);
    this.deps.clearTimer(pending.timer);
  }

  /** The user started the instance or deleted it: nothing is waiting any more, and the count starts over. */
  forget(instanceId: string): void {
    this.cancel(instanceId);
    this.series.delete(instanceId);
  }

  /** The setting was turned off: restarts that are waiting are no longer wanted either. */
  cancelAll(): void {
    for (const instanceId of new Set([...this.pending.keys(), ...this.outcomes.keys()])) this.cancel(instanceId);
  }

  /**
   * Panel shutdown: nothing is scheduled or started from here on. A timer firing later would be refused by
   * ProcessManager and reported as a failed restart, and one left running would keep the process alive.
   */
  shutdown(): void {
    this.shuttingDown = true;
    this.cancelAll();
  }

  // Runs inside ProcessManager's handler for the child's exit, where a throw would take the panel down.
  private readonly onStatus = (instanceId: string, status: InstanceStatus): void => {
    try {
      if (status === 'crashed') this.onCrashed(instanceId);
      else if (status === 'starting' && !this.ownStarts.has(instanceId)) this.forget(instanceId);
    } catch (error) {
      console.warn(`Failed to handle the automatic restart of instance ${instanceId}`, error);
    }
  };

  private onCrashed(instanceId: string): void {
    this.cancel(instanceId);
    const row = this.deps.loadInstance(instanceId);
    const settings = this.deps.loadSettings();
    if (!row || !this.mayRestart(row, settings)) return;

    const manager = this.deps.processManager;
    // A server that dies while starting would die again. This also covers every failure the panel diagnoses:
    // a start issue is only recognized in a run that never finished starting.
    if (!manager.exitedAfterReady(instanceId)) return;
    if (manager.getOrphanProcess(instanceId)) return;

    const now = this.deps.now();
    // The series ends once the server has stayed up for the whole window after its last restart. A crash sooner than
    // that continues it, however long ago it began: a server that keeps dying every few minutes must reach the limit.
    const series = this.series.get(instanceId);
    if (series && now - series.lastRestartAt >= settings.windowMinutes * 60_000) this.series.delete(instanceId);
    const made = this.series.get(instanceId)?.count ?? 0;
    const max = settings.maxAttempts;
    if (made >= max) {
      this.outcomes.set(instanceId, {
        state: 'gaveUp',
        attempt: made,
        max,
        at: new Date(now).toISOString(),
        windowMinutes: settings.windowMinutes,
      });
      return;
    }

    const delayMs = settings.delaySeconds * 1000;
    const pending: PendingRestart = { at: now + delayMs, attempt: made + 1, max, timer: undefined };
    pending.timer = this.deps.setTimer(() => this.restartNow(instanceId, pending), delayMs);
    this.pending.set(instanceId, pending);
  }

  /** What can change while a restart is waiting, checked both at the crash and when the restart comes due. */
  private mayRestart(row: InstanceRow, settings: AutoRestartSettings): boolean {
    if (this.shuttingDown || !settings.enabled) return false;
    // A bound Java that is gone fails every start, and the instance info already says so.
    if (row.java_runtime_id !== null && !getJavaRuntime(row.java_runtime_id)?.available) return false;
    return true;
  }

  private async restartNow(instanceId: string, pending: PendingRestart): Promise<void> {
    // A cancelled timer that had already fired, or one replaced by a later crash, finds another entry or none here.
    if (this.pending.get(instanceId) !== pending) return;
    this.pending.delete(instanceId);
    const manager = this.deps.processManager;
    const now = this.deps.now();
    try {
      const row = this.deps.loadInstance(instanceId);
      if (!row || !this.mayRestart(row, this.deps.loadSettings()) || manager.getStatus(instanceId) !== 'crashed') return;
      // Counted when it runs, so a restart that was cancelled while waiting does not use up an attempt.
      this.series.set(instanceId, { count: pending.attempt, lastRestartAt: now });
      this.ownStarts.add(instanceId);
      // Called outside any runExclusive: the instance lock is not re-entrant, and start takes it itself.
      await manager.start(row);
    } catch (error) {
      try {
        this.onStartRefused(instanceId, pending, now, error);
      } catch (reportError) {
        console.warn(`Failed to record why the automatic restart of instance ${instanceId} was refused`, error, reportError);
      }
    } finally {
      this.ownStarts.delete(instanceId);
    }
  }

  private onStartRefused(instanceId: string, pending: PendingRestart, now: number, error: unknown): void {
    // The user's own start got the instance lock first and has reset everything, or the instance is being shut down
    // with the panel: neither is a failed restart.
    if (isRefusalWithKey(error, 'server.instance.alreadyRunning')) {
      this.series.delete(instanceId);
      return;
    }
    if (isRefusalWithKey(error, 'server.instance.startShuttingDown', 'server.instance.startCancelledShuttingDown')) return;
    // Deleted while the start waited for the instance lock.
    if (!this.deps.loadInstance(instanceId)) return;
    // Refused by a backup holding the instance, a detached process, a missing jar or invalid JVM arguments: the same
    // start would be refused again, so the reason is reported and the instance is left for the user.
    this.outcomes.set(instanceId, {
      state: 'failed',
      attempt: pending.attempt,
      max: pending.max,
      at: new Date(now).toISOString(),
      reason: toPanelMessage(error) ?? errorMessage(error),
    });
  }
}

export const autoRestartService = new AutoRestartService();
