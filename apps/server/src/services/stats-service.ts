import fs from 'node:fs';
import os from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import type {
  DashboardMetrics,
  InstanceRunEndReason,
  StatsDiskBreakdown,
  StatsHostInfo,
  StatsInstanceRun,
  StatsIoReadFailed,
  StatsMetricBucket,
  StatsOverview,
  StatsRange,
} from '@mystry/shared';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { createDiskUsageScanner } from './dir-size-scanner.js';
import { createIoRateSampler, EMPTY_IO_RATES, isIoMetricsSupported, type IoRateSampler, type IoRates } from './io-counters.js';
import { isProcessMetricsSupported, MetricsService } from './metrics-service.js';
import { processManager } from './process-manager.js';

export const STATS_DEFAULTS = {
  sampleIntervalMs: 5 * 60_000,
  pruneIntervalMs: 60 * 60_000,
  retentionMs: 30 * 24 * 60 * 60_000,
} as const;

const RANGE_SPECS: Record<StatsRange, { rangeMs: number; bucketMs: number; bucketCount: number }> = {
  '24h': { rangeMs: 24 * 60 * 60_000, bucketMs: 5 * 60_000, bucketCount: 288 },
  '7d': { rangeMs: 7 * 24 * 60 * 60_000, bucketMs: 60 * 60_000, bucketCount: 168 },
  '30d': { rangeMs: 30 * 24 * 60 * 60_000, bucketMs: 6 * 60 * 60_000, bucketCount: 120 },
};

const sharedMetrics = new MetricsService(
  () => config.dataDir,
  () => processManager.getMetricTargets(),
);

/** Returns the shared MetricsService instance used by both live polling and 5-minute background sampling. */
export function getSharedMetricsService(): MetricsService {
  return sharedMetrics;
}

export const diskUsageScanner = createDiskUsageScanner({
  dataDir: () => config.dataDir,
  instancesDir: () => config.instancesDir,
  backupDir: () => config.backupDir,
});

/** Extracts the unquoted PRETTY_NAME value from Linux /etc/os-release content. */
export function parseLinuxOsReleasePrettyName(content: string): string | null {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('PRETTY_NAME=')) continue;
    let value = line.slice('PRETTY_NAME='.length).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    value = value.replace(/\\(["\\$`])/g, '$1').trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

export type DetectOsNameOptions = {
  platform?: NodeJS.Platform;
  readOsRelease?: () => string;
  osVersion?: () => string;
  osType?: () => string;
  osRelease?: () => string;
};

export function detectOsName(options: DetectOsNameOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const fallback = () => `${(options.osType ?? os.type)()} ${(options.osRelease ?? os.release)()}`.trim();
  if (platform === 'darwin') {
    // Avoid os.version() returning a verbose Darwin kernel build string on macOS.
    return 'macOS';
  }
  if (platform === 'win32') {
    const version = (options.osVersion ?? os.version)().trim();
    return version || fallback();
  }
  if (platform === 'linux') {
    try {
      const content = (options.readOsRelease ?? (() => fs.readFileSync('/etc/os-release', 'utf8')))();
      const pretty = parseLinuxOsReleasePrettyName(content);
      if (pretty) return pretty;
    } catch {
      /* Fall back to kernel type and release when /etc/os-release is unavailable */
    }
    return fallback();
  }
  return fallback();
}

let cachedOsName: string | null = null;

function getOsName(): string {
  if (cachedOsName === null) cachedOsName = detectOsName();
  return cachedOsName;
}

export function getHostInfo(nowMs = Date.now()): StatsHostInfo {
  const rawCpuModel = os.cpus()[0]?.model?.trim();
  const cpuModel = rawCpuModel && rawCpuModel.length > 0 ? rawCpuModel : null;
  const uptimeMs = Math.max(0, os.uptime()) * 1000;
  return {
    osName: getOsName(),
    cpuModel,
    cpuThreads: os.availableParallelism(),
    totalMemoryBytes: os.totalmem(),
    bootedAt: new Date(nowMs - uptimeMs).toISOString(),
  };
}

export type StatsCollectorOptions = {
  metrics?: Pick<MetricsService, 'get'>;
  io?: IoRateSampler;
  now?: () => Date;
  db?: () => DatabaseSync;
  sampleIntervalMs?: number;
  pruneIntervalMs?: number;
  retentionMs?: number;
};

export type StatsCollector = {
  start(): void;
  stop(): void;
  sampleOnce(): Promise<boolean>;
  pruneOldSamples(): number;
  ioReadFailed(): StatsIoReadFailed;
};

/**
 * Periodically samples host and running-instance metrics into `metric_samples` and prunes rows older
 * than 30 days. Checks a `stopped` flag and generation counter after every await so an in-flight
 * process query can never write to a closed database during shutdown or across tests.
 */
export function createStatsCollector(options: StatsCollectorOptions = {}): StatsCollector {
  const metrics = options.metrics ?? sharedMetrics;
  // Network and disk counters are read only here, not in the 5-second live polling, so each value is the
  // average over one sample interval and no extra PowerShell starts while the home page is open.
  const io = options.io ?? createIoRateSampler();
  const now = options.now ?? (() => new Date());
  const db = options.db ?? getDb;
  const sampleIntervalMs = options.sampleIntervalMs ?? STATS_DEFAULTS.sampleIntervalMs;
  const pruneIntervalMs = options.pruneIntervalMs ?? STATS_DEFAULTS.pruneIntervalMs;
  const retentionMs = options.retentionMs ?? STATS_DEFAULTS.retentionMs;

  let sampleTimer: NodeJS.Timeout | null = null;
  let pruneTimer: NodeJS.Timeout | null = null;
  let stopped = false;
  let sampling = false;
  let runGeneration = 0;

  function persistSnapshot(snapshot: DashboardMetrics, ioRates: IoRates, sampledAt: string): void {
    const target = db();
    target.exec('BEGIN');
    try {
      target
        .prepare(
          `INSERT INTO metric_samples (
             sampled_at, instance_id, cpu_percent, memory_bytes,
             net_rx_bytes_per_sec, net_tx_bytes_per_sec, disk_read_bytes_per_sec, disk_write_bytes_per_sec
           )
           VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sampledAt,
          snapshot.cpuPercent,
          snapshot.memory.usedBytes,
          ioRates.netRxBytesPerSec,
          ioRates.netTxBytesPerSec,
          ioRates.diskReadBytesPerSec,
          ioRates.diskWriteBytesPerSec,
        );

      // Filter through `instances` so an instance deleted while metrics.get() was in flight does not trigger a FK error.
      const insertInstance = target.prepare(
        `INSERT INTO metric_samples (sampled_at, instance_id, cpu_percent, memory_bytes)
         SELECT ?, id, ?, ? FROM instances WHERE id = ?`,
      );
      for (const [instanceId, stats] of Object.entries(snapshot.instances)) {
        insertInstance.run(sampledAt, stats.cpuPercent, stats.memoryBytes, instanceId);
      }
      target.exec('COMMIT');
    } catch (error) {
      try {
        target.exec('ROLLBACK');
      } catch {
        /* Database may already have rolled back or closed */
      }
      throw error;
    }
  }

  async function sampleOnce(): Promise<boolean> {
    if (stopped || sampling) return false;
    sampling = true;
    const generation = runGeneration;
    try {
      // Settled separately: a slow or failed counter read only leaves the I/O columns NULL and never costs the CPU and memory row.
      const [snapshotResult, ioResult] = await Promise.allSettled([metrics.get(), io.sample(sampleIntervalMs * 2)]);
      if (stopped || runGeneration !== generation) return false;
      if (snapshotResult.status === 'rejected') throw snapshotResult.reason;
      const ioRates = ioResult.status === 'fulfilled' ? ioResult.value : EMPTY_IO_RATES;
      persistSnapshot(snapshotResult.value, ioRates, now().toISOString());
      return true;
    } catch (error) {
      if (!stopped && runGeneration === generation) {
        console.warn('Failed to write overview metric sample', error);
      }
      return false;
    } finally {
      sampling = false;
    }
  }

  function pruneOldSamples(): number {
    if (stopped) return 0;
    try {
      const cutoff = new Date(now().getTime() - retentionMs).toISOString();
      const result = db().prepare('DELETE FROM metric_samples WHERE sampled_at < ?').run(cutoff);
      return Number(result.changes);
    } catch (error) {
      if (!stopped) {
        console.warn('Failed to prune expired overview metric samples', error);
      }
      return 0;
    }
  }

  function stop(): void {
    stopped = true;
    runGeneration += 1;
    io.reset();
    if (sampleTimer) {
      clearInterval(sampleTimer);
      sampleTimer = null;
    }
    if (pruneTimer) {
      clearInterval(pruneTimer);
      pruneTimer = null;
    }
  }

  return {
    start() {
      stopped = false;
      if (sampleTimer) return;
      // Prime the CPU and I/O counter baselines without inserting a row so the first 5-minute sample already has values.
      void metrics.get().catch(() => {});
      void io.prime().catch(() => {});
      sampleTimer = setInterval(() => void sampleOnce(), sampleIntervalMs);
      sampleTimer.unref();
      pruneTimer = setInterval(() => pruneOldSamples(), pruneIntervalMs);
      pruneTimer.unref();
    },
    stop,
    sampleOnce,
    pruneOldSamples,
    ioReadFailed: () => io.readFailed(),
  };
}

export const statsCollector = createStatsCollector();

/** Stops background collectors and clears cached state (called on Fastify onClose and failed startup). */
export function resetStatsRuntime(): void {
  statsCollector.stop();
  diskUsageScanner.reset();
  sharedMetrics.reset();
}

type AnchoredSampleRow = {
  sampled_at: string;
  host_cpu: number | null;
  host_mem: number | null;
  host_net_rx: number | null;
  host_net_tx: number | null;
  host_disk_read: number | null;
  host_disk_write: number | null;
  instance_count: number | null;
  cpu_count: number | null;
  cpu_sum: number | null;
  mem_count: number | null;
  mem_sum: number | null;
};

type RunQueryRow = {
  instance_id: string;
  ready_at: string;
  ended_at: string | null;
  end_reason: InstanceRunEndReason | null;
};

type BucketAccumulator = {
  timestamp: string;
  hostCpuSum: number;
  hostCpuCount: number;
  hostMemSum: number;
  hostMemCount: number;
  instCpuSum: number;
  instCpuCount: number;
  instMemSum: number;
  instMemCount: number;
  netRx: RateAverage;
  netTx: RateAverage;
  diskRead: RateAverage;
  diskWrite: RateAverage;
};

type RateAverage = { sum: number; count: number };

function addRate(target: RateAverage, value: number | null): void {
  if (value === null || !Number.isFinite(value)) return;
  target.sum += Math.max(0, value);
  target.count += 1;
}

function averageRate(target: RateAverage): number | null {
  return target.count > 0 ? target.sum / target.count : null;
}

export type StatsOverviewOptions = {
  now?: () => Date;
  db?: () => DatabaseSync;
  processMetricsSupported?: boolean;
  ioMetricsSupported?: boolean;
  ioReadFailed?: StatsIoReadFailed;
  diskBreakdown?: StatsDiskBreakdown;
  host?: StatsHostInfo;
};

export function getStatsOverview(range: StatsRange, options: StatsOverviewOptions = {}): StatsOverview {
  const now = options.now ?? (() => new Date());
  const db = options.db ?? getDb;
  const processMetricsSupported = options.processMetricsSupported ?? isProcessMetricsSupported();
  const ioMetricsSupported = options.ioMetricsSupported ?? isIoMetricsSupported();
  const ioReadFailed = ioMetricsSupported
    ? (options.ioReadFailed ?? statsCollector.ioReadFailed())
    : { network: false, disk: false };

  const spec = RANGE_SPECS[range];
  const nowMs = now().getTime();
  const to = new Date(nowMs).toISOString();
  const from = new Date(nowMs - spec.rangeMs).toISOString();

  const lastSlotMs = Math.floor(nowMs / spec.bucketMs) * spec.bucketMs;
  const firstSlotMs = lastSlotMs - (spec.bucketCount - 1) * spec.bucketMs;
  const firstSlotIso = new Date(firstSlotMs).toISOString();

  const accumulators: BucketAccumulator[] = Array.from({ length: spec.bucketCount }, (_, index) => ({
    timestamp: new Date(firstSlotMs + index * spec.bucketMs).toISOString(),
    hostCpuSum: 0,
    hostCpuCount: 0,
    hostMemSum: 0,
    hostMemCount: 0,
    instCpuSum: 0,
    instCpuCount: 0,
    instMemSum: 0,
    instMemCount: 0,
    netRx: { sum: 0, count: 0 },
    netTx: { sum: 0, count: 0 },
    diskRead: { sum: 0, count: 0 },
    diskWrite: { sum: 0, count: 0 },
  }));

  const target = db();
  // Two-layer aggregation: anchor each timestamp on its host sample (instance_id IS NULL) and LEFT JOIN summed
  // instance rows at the same sampled_at. Timestamps with zero running instances count as 0 (when per-process
  // metrics are supported), while timestamps where running instances exist but all reported NULL are skipped.
  const sampleRows = target
    .prepare(
      `WITH inst AS (
         SELECT
           sampled_at,
           COUNT(*) AS instance_count,
           COUNT(cpu_percent) AS cpu_count,
           SUM(cpu_percent) AS cpu_sum,
           COUNT(memory_bytes) AS mem_count,
           SUM(memory_bytes) AS mem_sum
         FROM metric_samples
         WHERE sampled_at >= ? AND sampled_at <= ? AND instance_id IS NOT NULL
         GROUP BY sampled_at
       )
       SELECT
         h.sampled_at,
         h.cpu_percent AS host_cpu,
         h.memory_bytes AS host_mem,
         h.net_rx_bytes_per_sec AS host_net_rx,
         h.net_tx_bytes_per_sec AS host_net_tx,
         h.disk_read_bytes_per_sec AS host_disk_read,
         h.disk_write_bytes_per_sec AS host_disk_write,
         inst.instance_count,
         inst.cpu_count,
         inst.cpu_sum,
         inst.mem_count,
         inst.mem_sum
       FROM metric_samples h
       LEFT JOIN inst ON inst.sampled_at = h.sampled_at
       WHERE h.sampled_at >= ? AND h.sampled_at <= ? AND h.instance_id IS NULL
       ORDER BY h.sampled_at ASC`,
    )
    .all(firstSlotIso, to, firstSlotIso, to) as AnchoredSampleRow[];

  for (const row of sampleRows) {
    const sampleMs = Date.parse(row.sampled_at);
    if (!Number.isFinite(sampleMs) || sampleMs < firstSlotMs || sampleMs > nowMs) continue;
    const slotIndex = Math.floor((sampleMs - firstSlotMs) / spec.bucketMs);
    if (slotIndex < 0 || slotIndex >= spec.bucketCount) continue;
    const bucket = accumulators[slotIndex]!;

    if (row.host_cpu !== null) {
      bucket.hostCpuSum += row.host_cpu;
      bucket.hostCpuCount += 1;
    }
    if (row.host_mem !== null) {
      bucket.hostMemSum += row.host_mem;
      bucket.hostMemCount += 1;
    }
    addRate(bucket.netRx, row.host_net_rx);
    addRate(bucket.netTx, row.host_net_tx);
    addRate(bucket.diskRead, row.host_disk_read);
    addRate(bucket.diskWrite, row.host_disk_write);

    if (processMetricsSupported) {
      const instanceCount = row.instance_count ?? 0;
      if (instanceCount === 0) {
        bucket.instCpuCount += 1;
        bucket.instMemCount += 1;
      } else {
        if ((row.cpu_count ?? 0) > 0 && row.cpu_sum !== null) {
          bucket.instCpuSum += Math.min(100, Math.max(0, row.cpu_sum));
          bucket.instCpuCount += 1;
        }
        if ((row.mem_count ?? 0) > 0 && row.mem_sum !== null) {
          bucket.instMemSum += Math.max(0, row.mem_sum);
          bucket.instMemCount += 1;
        }
      }
    }
  }

  const buckets: StatsMetricBucket[] = accumulators.map((bucket) => ({
    timestamp: bucket.timestamp,
    hostCpuPercent: bucket.hostCpuCount > 0 ? Math.min(100, Math.max(0, bucket.hostCpuSum / bucket.hostCpuCount)) : null,
    hostMemoryBytes: bucket.hostMemCount > 0 ? Math.round(bucket.hostMemSum / bucket.hostMemCount) : null,
    instancesCpuPercent:
      bucket.instCpuCount > 0 ? Math.min(100, Math.max(0, bucket.instCpuSum / bucket.instCpuCount)) : null,
    instancesMemoryBytes: bucket.instMemCount > 0 ? Math.round(bucket.instMemSum / bucket.instMemCount) : null,
    hostNetRxBytesPerSec: averageRate(bucket.netRx),
    hostNetTxBytesPerSec: averageRate(bucket.netTx),
    hostDiskReadBytesPerSec: averageRate(bucket.diskRead),
    hostDiskWriteBytesPerSec: averageRate(bucket.diskWrite),
  }));

  const runRows = target
    .prepare(
      `SELECT instance_id, ready_at, ended_at, end_reason
       FROM instance_runs
       WHERE ready_at IS NOT NULL
         AND ready_at <= ?
         AND (ended_at IS NULL OR ended_at > ?)
       ORDER BY ready_at ASC, id ASC`,
    )
    .all(to, from) as RunQueryRow[];

  const runs: StatsInstanceRun[] = runRows.map((row) => ({
    instanceId: row.instance_id,
    readyAt: row.ready_at,
    endedAt: row.ended_at,
    endReason: row.end_reason,
  }));

  return {
    range,
    from,
    to,
    bucketSeconds: spec.bucketMs / 1000,
    processMetricsSupported,
    ioMetricsSupported,
    ioReadFailed,
    buckets,
    runs,
    host: options.host ?? getHostInfo(nowMs),
    diskBreakdown: options.diskBreakdown ?? diskUsageScanner.getSnapshot(),
  };
}
