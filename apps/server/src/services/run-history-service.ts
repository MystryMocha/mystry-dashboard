import type { EventEmitter } from 'node:events';
import type { DatabaseSync } from 'node:sqlite';
import type { InstanceStatus } from '@mystry/shared';
import { getDb, type InstanceRunRow } from '../db.js';
import { defaultInstanceDir } from '../utils/path.js';
import {
  canGracefullyStopOrphan,
  inspectTrackedProcess,
  type TrackedProcessCandidate,
  type TrackedProcessState,
} from '../utils/process-inspect.js';
import { processManager, type OrphanProcessRecord } from './process-manager.js';

type ProcessEventSource = Pick<EventEmitter, 'on' | 'off'> & {
  registerOrphanProcess?: (instanceId: string, record: OrphanProcessRecord) => void;
  clearOrphanProcesses?: () => void;
};

type OrphanRegistry = {
  registerOrphanProcess(instanceId: string, record: OrphanProcessRecord): void;
  clearOrphanProcesses(): void;
};

export type OrphanRecoveryResult = {
  orphans: Array<{ instanceId: string; pid: number; runId: number }>;
  activeRunIds: Set<number>;
};

export type RunHistoryTrackerOptions = {
  events?: ProcessEventSource;
  orphanRegistry?: OrphanRegistry;
  inspectProcess?: (candidate: TrackedProcessCandidate) => Promise<TrackedProcessState>;
  canGracefulStop?: () => boolean;
  now?: () => Date;
  db?: () => DatabaseSync;
};

export type RunHistoryTracker = {
  attach(): void;
  detach(): void;
  recoverOrphanProcesses(): Promise<OrphanRecoveryResult>;
  recoverInterrupted(excludeRunIds?: ReadonlySet<number>): { recovered: number };
};

const ORPHAN_INSPECT_CONCURRENCY = 4;

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
  const orphanRegistry: Partial<OrphanRegistry> = options.orphanRegistry ?? events;
  const inspectProcess = options.inspectProcess ?? inspectTrackedProcess;
  const canGracefulStop = options.canGracefulStop ?? canGracefullyStopOrphan;
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

  const onSpawned = (instanceId: string, pid: number, processIdentity: string | null): void => {
    try {
      const open = findOpenRun(instanceId);
      if (!open) return;
      db()
        .prepare('UPDATE instance_runs SET pid = ?, process_identity = ? WHERE id = ?')
        .run(pid, processIdentity, open.id);
    } catch (error) {
      console.warn(`Failed to record spawned process identity for instance ${instanceId}`, error);
    }
  };

  const onProcessIdentity = (instanceId: string, pid: number, processIdentity: string): void => {
    if (!attached) return;
    try {
      db()
        .prepare(
          'UPDATE instance_runs SET process_identity = ? WHERE instance_id = ? AND ended_at IS NULL AND pid = ? AND process_identity IS NULL',
        )
        .run(processIdentity, instanceId, pid);
    } catch (error) {
      console.warn(`Failed to record async process identity for instance ${instanceId}`, error);
    }
  };

  const onOrphanExited = (instanceId: string, runId?: number): void => {
    try {
      const target = db();
      const open = runId !== undefined
        ? (target
            .prepare('SELECT id, started_at, ready_at FROM instance_runs WHERE id = ? AND instance_id = ? AND ended_at IS NULL')
            .get(runId, instanceId) as Pick<InstanceRunRow, 'id' | 'started_at' | 'ready_at'> | undefined)
        : findOpenRun(instanceId);
      if (!open) return;
      const endedAt = maxIso(now().toISOString(), open.started_at, open.ready_at);
      target
        .prepare("UPDATE instance_runs SET ended_at = ?, end_reason = 'stopped' WHERE id = ? AND ended_at IS NULL")
        .run(endedAt, open.id);
    } catch (error) {
      console.warn(`Failed to close exited detached run for instance ${instanceId}`, error);
    }
  };

  return {
    attach() {
      if (attached) return;
      attached = true;
      sawRunning.clear();
      events.on('status', onStatus);
      events.on('ready', onReady);
      events.on('spawned', onSpawned);
      events.on('process-identity', onProcessIdentity);
      events.on('orphan-exited', onOrphanExited);
    },
    detach() {
      if (!attached) {
        sawRunning.clear();
        return;
      }
      attached = false;
      events.off('status', onStatus);
      events.off('ready', onReady);
      events.off('spawned', onSpawned);
      events.off('process-identity', onProcessIdentity);
      events.off('orphan-exited', onOrphanExited);
      sawRunning.clear();
    },
    async recoverOrphanProcesses() {
      orphanRegistry.clearOrphanProcesses?.();
      const rows = db()
        .prepare(
          `SELECT r.id, r.instance_id, r.started_at, r.pid, r.process_identity, i.install_path
           FROM instance_runs r
           INNER JOIN instances i ON i.id = r.instance_id
           WHERE r.ended_at IS NULL AND r.pid IS NOT NULL
           ORDER BY r.id DESC`,
        )
        .all() as Array<{
          id: number;
          instance_id: string;
          started_at: string;
          pid: number;
          process_identity: string | null;
          install_path: string | null;
        }>;
      const seenInstances = new Set<string>();
      const orphans: Array<{ instanceId: string; pid: number; runId: number }> = [];
      const activeRunIds = new Set<number>();
      const candidates = rows
        .filter((row) => {
          if (seenInstances.has(row.instance_id)) return false;
          seenInstances.add(row.instance_id);
          return Number.isSafeInteger(row.pid) && row.pid > 0;
        })
        .map((row) => ({ row, cwd: row.install_path ?? defaultInstanceDir(row.instance_id) }));
      // Each inspection may spawn a system tool that takes up to its timeout, so run a few at a time rather than
      // delaying the listener by the sum of all of them.
      const states: TrackedProcessState[] = [];
      for (let offset = 0; offset < candidates.length; offset += ORPHAN_INSPECT_CONCURRENCY) {
        const batch = candidates.slice(offset, offset + ORPHAN_INSPECT_CONCURRENCY);
        states.push(...await Promise.all(batch.map(({ row, cwd }) => inspectProcess({
          pid: row.pid,
          startedAt: row.started_at,
          processIdentity: row.process_identity,
          cwd,
        }))));
      }
      for (const [index, { row, cwd }] of candidates.entries()) {
        // An uninspectable PID is kept as a detached process with its run left open: treating it as exited would
        // let a second server start on the same world directory.
        if (states[index] === 'dead') continue;
        orphanRegistry.registerOrphanProcess?.(row.instance_id, {
          pid: row.pid,
          startedAt: row.started_at,
          canGracefulStop: canGracefulStop(),
          runId: row.id,
          processIdentity: row.process_identity,
          cwd,
        });
        orphans.push({ instanceId: row.instance_id, pid: row.pid, runId: row.id });
        activeRunIds.add(row.id);
      }
      return { orphans, activeRunIds };
    },
    recoverInterrupted(excludeRunIds?: ReadonlySet<number>) {
      sawRunning.clear();
      const target = db();
      const latestHost = target
        .prepare('SELECT MAX(sampled_at) AS sampled_at FROM metric_samples WHERE instance_id IS NULL')
        .get() as { sampled_at: string | null } | undefined;
      const lastHostSampleAt = latestHost?.sampled_at ?? null;
      const excluded = excludeRunIds
        ? [...excludeRunIds].filter((id) => Number.isSafeInteger(id) && id > 0)
        : [];
      const exclusionSql = excluded.length > 0 ? ` AND id NOT IN (${excluded.map(() => '?').join(', ')})` : '';
      // SQLite scalar MAX returns NULL if any argument is NULL, so every optional timestamp coalesces to started_at.
      const result = target
        .prepare(
          `UPDATE instance_runs
           SET ended_at = MAX(started_at, COALESCE(ready_at, started_at), COALESCE(?, started_at)),
               end_reason = 'panel-exit'
           WHERE ended_at IS NULL${exclusionSql}`,
        )
        .run(lastHostSampleAt, ...excluded);
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

export async function recoverOrphanInstanceProcesses(): Promise<OrphanRecoveryResult> {
  return defaultRunHistory.recoverOrphanProcesses();
}

export function recoverInterruptedInstanceRuns(excludeRunIds?: ReadonlySet<number>): { recovered: number } {
  return defaultRunHistory.recoverInterrupted(excludeRunIds);
}
