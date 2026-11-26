import type { EventEmitter } from 'node:events';
import type { DatabaseSync } from 'node:sqlite';
import type { InstanceStatus } from '@mystry/shared';
import { getDb, type InstanceRunRow } from '../db.js';
import { processManager } from './process-manager.js';

type ProcessEventSource = Pick<EventEmitter, 'on' | 'off'>;

export type RunHistoryTrackerOptions = {
  events?: ProcessEventSource;
  now?: () => Date;
  db?: () => DatabaseSync;
};

export type RunHistoryTracker = {
  attach(): void;
  detach(): void;
  recoverInterrupted(): { recovered: number };
};

function maxIso(...values: Array<string | null | undefined>): string {
  let latest = '';
  for (const value of values) {
    if (value && value > latest) latest = value;
  }
  return latest;
}

/**
 * Records start-to-exit runs of managed instances into `instance_runs`.
 * At most one open row (`ended_at IS NULL`) exists per instance. Every database write inside process event
 * listeners is wrapped in try/catch so a storage error or late exit during shutdown never crashes the panel.
 */
export function createRunHistoryTracker(options: RunHistoryTrackerOptions = {}): RunHistoryTracker {
  const events = options.events ?? processManager;
  const now = options.now ?? (() => new Date());
  const db = options.db ?? getDb;

  let attached = false;
  /** Tracks whether the current open run for each instance has ever reached `running`. */
  const sawRunning = new Set<string>();

  const findOpenRun = (instanceId: string): Pick<InstanceRunRow, 'id' | 'started_at' | 'ready_at'> | undefined =>
    db()
      .prepare('SELECT id, started_at, ready_at FROM instance_runs WHERE instance_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1')
      .get(instanceId) as Pick<InstanceRunRow, 'id' | 'started_at' | 'ready_at'> | undefined;

  const onStatus = (instanceId: string, status: InstanceStatus): void => {
    try {
      if (status === 'starting') {
        if (!findOpenRun(instanceId)) {
          sawRunning.delete(instanceId);
          db()
            .prepare('INSERT INTO instance_runs (instance_id, started_at) VALUES (?, ?)')
            .run(instanceId, now().toISOString());
        }
        return;
      }

      if (status === 'running') {
        sawRunning.add(instanceId);
        return;
      }

      if (status === 'stopping') {
        return;
      }

      if (status === 'stopped') {
        const hadRunning = sawRunning.has(instanceId);
        sawRunning.delete(instanceId);
        const open = findOpenRun(instanceId);
        if (!open) return;
        // Pre-spawn validation errors (such as an unavailable bound Java runtime) emit starting -> stopped without
        // ever running; drop the placeholder row so failed prechecks leave no run history behind.
        if (!hadRunning && open.ready_at === null) {
          db().prepare('DELETE FROM instance_runs WHERE id = ?').run(open.id);
          return;
        }
        const endedAt = maxIso(now().toISOString(), open.started_at, open.ready_at);
        db()
          .prepare("UPDATE instance_runs SET ended_at = ?, end_reason = 'stopped' WHERE id = ?")
          .run(endedAt, open.id);
        return;
      }

      if (status === 'crashed') {
        sawRunning.delete(instanceId);
        const open = findOpenRun(instanceId);
        if (!open) return;
        const endReason = open.ready_at ? 'crashed' : 'start-failed';
        const endedAt = maxIso(now().toISOString(), open.started_at, open.ready_at);
        db()
          .prepare('UPDATE instance_runs SET ended_at = ?, end_reason = ? WHERE id = ?')
          .run(endedAt, endReason, open.id);
      }
    } catch (error) {
      console.warn(`Failed to record run history status (${status}) for instance ${instanceId}`, error);
    }
  };

  const onReady = (instanceId: string): void => {
    try {
      db()
        .prepare('UPDATE instance_runs SET ready_at = ? WHERE instance_id = ? AND ended_at IS NULL AND ready_at IS NULL')
        .run(now().toISOString(), instanceId);
    } catch (error) {
      console.warn(`Failed to record ready timestamp for instance ${instanceId}`, error);
    }
  };

  return {
    attach() {
      if (attached) return;
      attached = true;
      sawRunning.clear();
      events.on('status', onStatus);
      events.on('ready', onReady);
    },
    detach() {
      if (!attached) {
        sawRunning.clear();
        return;
      }
      attached = false;
      events.off('status', onStatus);
      events.off('ready', onReady);
      sawRunning.clear();
    },
    recoverInterrupted() {
      sawRunning.clear();
      const target = db();
      const latestHost = target
        .prepare('SELECT MAX(sampled_at) AS sampled_at FROM metric_samples WHERE instance_id IS NULL')
        .get() as { sampled_at: string | null } | undefined;
      const lastHostSampleAt = latestHost?.sampled_at ?? null;
      // SQLite scalar MAX returns NULL if any argument is NULL, so every optional timestamp coalesces to started_at.
      const result = target
        .prepare(
          `UPDATE instance_runs
           SET ended_at = MAX(started_at, COALESCE(ready_at, started_at), COALESCE(?, started_at)),
               end_reason = 'panel-exit'
           WHERE ended_at IS NULL`,
        )
        .run(lastHostSampleAt);
      return { recovered: Number(result.changes) };
    },
  };
}

const defaultRunHistory = createRunHistoryTracker();

export function attachRunHistoryLifecycle(): void {
  defaultRunHistory.attach();
}

export function detachRunHistoryLifecycle(): void {
  defaultRunHistory.detach();
}

export function recoverInterruptedInstanceRuns(): { recovered: number } {
  return defaultRunHistory.recoverInterrupted();
}
