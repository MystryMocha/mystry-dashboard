import type { InstanceInfo, StatsInstanceRun, StatsMetricBucket, StatsRange } from '@mystry/shared';
import type { Formatters, I18n, MessageKey } from '../../i18n';

const GIB = 1024 ** 3;
const TIB = 1024 ** 4;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export function rangePhraseKey(range: StatsRange): MessageKey {
  if (range === '24h') return 'home.range.phrase.24h';
  if (range === '30d') return 'home.range.phrase.30d';
  return 'home.range.phrase.7d';
}

/** Formats a byte count in GiB (or TiB at 1024 GiB and above) with a space before the unit. */
export function formatCapacity(bytes: number, fmt: Formatters): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (safe >= TIB) {
    const tib = safe / TIB;
    return `${fmt.fixed(tib, tib >= 100 ? 0 : 1)} TiB`;
  }
  const gib = safe / GIB;
  return `${fmt.fixed(gib, gib >= 100 ? 0 : 1)} GiB`;
}

/** Formats a used / total byte pair sharing one unit so status blocks stay concise on narrow columns. */
export function formatCapacityPair(usedBytes: number, totalBytes: number, fmt: Formatters): string {
  const safeTotal = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : 0;
  const safeUsed = Number.isFinite(usedBytes) && usedBytes > 0 ? usedBytes : 0;
  const useTib = safeTotal >= TIB;
  const unitSize = useTib ? TIB : GIB;
  const unitLabel = useTib ? 'TiB' : 'GiB';
  const used = safeUsed / unitSize;
  const total = safeTotal / unitSize;
  const usedDigits = used >= 100 ? 0 : 1;
  const totalDigits = total >= 100 ? 0 : 1;
  return `${fmt.fixed(used, usedDigits)} / ${fmt.fixed(total, totalDigits)} ${unitLabel}`;
}

/** Formats cumulative run duration in tiers so brief runs never round down to 0 hours. */
export function formatRunDuration(durationMs: number, { t, tp }: Pick<I18n, 't' | 'tp'>): string {
  const safe = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
  if (safe < MINUTE_MS) return t('home.duration.lessThanMinute');
  if (safe < HOUR_MS) return tp('home.duration.minutes', Math.max(1, Math.floor(safe / MINUTE_MS)));
  return tp('home.duration.hours', Math.max(1, Math.round(safe / HOUR_MS)));
}

/** Formats host uptime derived from bootedAt against the server snapshot timestamp. */
export function formatUptime(bootedAt: string, referenceMs: number, { t, tp }: Pick<I18n, 't' | 'tp'>): string {
  const bootMs = Date.parse(bootedAt);
  if (!Number.isFinite(bootMs)) return '—';
  const elapsedMs = Math.max(0, referenceMs - bootMs);
  if (elapsedMs < MINUTE_MS) return t('home.duration.lessThanMinute');
  if (elapsedMs < HOUR_MS) {
    return tp('home.duration.minutes', Math.max(1, Math.floor(elapsedMs / MINUTE_MS)));
  }
  if (elapsedMs < DAY_MS) {
    const hours = Math.floor(elapsedMs / HOUR_MS);
    const minutes = Math.floor((elapsedMs % HOUR_MS) / MINUTE_MS);
    if (minutes === 0) return tp('home.duration.hours', hours);
    return t('home.uptime.hoursMinutes', {
      hours: tp('home.duration.hours', hours),
      minutes: tp('home.duration.minutes', minutes),
    });
  }
  const days = Math.floor(elapsedMs / DAY_MS);
  const hours = Math.floor((elapsedMs % DAY_MS) / HOUR_MS);
  if (hours === 0) return tp('home.uptime.days', days);
  return t('home.uptime.daysHours', {
    days: tp('home.uptime.days', days),
    hours: tp('home.duration.hours', hours),
  });
}

const HOUR_MIN: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
const MONTH_DAY: Intl.DateTimeFormatOptions = { month: 'numeric', day: 'numeric' };
const TOOLTIP_DATE_TIME: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };

export function formatAxisTick(timestampMs: number, range: StatsRange, fmt: Formatters): string {
  return fmt.dateTime(timestampMs, range === '24h' ? HOUR_MIN : MONTH_DAY);
}

export function formatBucketTooltipTime(iso: string, range: StatsRange, fmt: Formatters): string {
  return fmt.dateTime(iso, range === '24h' ? HOUR_MIN : TOOLTIP_DATE_TIME);
}

/** Picks an even Y-axis ceiling in GiB or TiB so the midpoint tick is always a clean number. */
export function memoryAxisSpec(totalMemoryBytes: number, peakBytes: number, fmt: Formatters): {
  unitBytes: number;
  maxUnit: number;
  ticks: number[];
  formatTick: (value: number) => string;
} {
  const ceilingBytes = Math.max(totalMemoryBytes, peakBytes, GIB);
  const useTib = ceilingBytes >= TIB;
  const unitBytes = useTib ? TIB : GIB;
  const unitLabel = useTib ? 'TiB' : 'GiB';
  const raw = ceilingBytes / unitBytes;

  let maxUnit: number;
  if (raw <= 2) maxUnit = 2;
  else if (raw <= 4) maxUnit = 4;
  else if (raw <= 8) maxUnit = 8;
  else if (raw <= 16) maxUnit = 16;
  else if (raw <= 32) maxUnit = 32;
  else if (raw <= 64) maxUnit = 64;
  else if (raw <= 128) maxUnit = 128;
  else {
    const step = raw <= 512 ? 32 : 64;
    maxUnit = Math.ceil(raw / step) * step;
  }

  return {
    unitBytes,
    maxUnit,
    ticks: [0, maxUnit / 2, maxUnit],
    formatTick: (value) => `${fmt.number(value)} ${unitLabel}`,
  };
}

export interface TimelineSegment {
  key: string;
  leftPct: number;
  widthPct: number;
  crashPct: number | null;
}

export interface TimelineRowData {
  instanceId: string;
  name: string;
  totalMs: number;
  crashes: number;
  segments: TimelineSegment[];
}

/** Groups ready runs by instance, clips them to [from, to], drops instances that never ran in range, and sorts by runtime descending. */
export function buildTimelineRows(
  runs: StatsInstanceRun[],
  instances: InstanceInfo[],
  fromIso: string,
  toIso: string,
): TimelineRowData[] {
  const fromMs = Date.parse(fromIso);
  const toMs = Date.parse(toIso);
  const spanMs = toMs - fromMs;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || spanMs <= 0) return [];

  const nameById = new Map(instances.map((inst) => [inst.id, inst.name]));
  const grouped = new Map<string, TimelineRowData>();

  runs.forEach((run, index) => {
    const name = nameById.get(run.instanceId);
    if (!name) return;
    const rawStart = Date.parse(run.readyAt);
    const rawEnd = run.endedAt ? Date.parse(run.endedAt) : toMs;
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) return;
    if (rawStart >= toMs || rawEnd < fromMs) return;

    const startMs = Math.max(fromMs, rawStart);
    const endMs = Math.max(startMs, Math.min(toMs, rawEnd));
    const durationMs = endMs - startMs;

    const crashedInRange = run.endReason === 'crashed' && run.endedAt != null && rawEnd >= fromMs && rawEnd <= toMs;
    const leftPct = ((startMs - fromMs) / spanMs) * 100;
    const widthPct = (durationMs / spanMs) * 100;
    const crashPct = crashedInRange ? ((rawEnd - fromMs) / spanMs) * 100 : null;

    let entry = grouped.get(run.instanceId);
    if (!entry) {
      entry = { instanceId: run.instanceId, name, totalMs: 0, crashes: 0, segments: [] };
      grouped.set(run.instanceId, entry);
    }
    entry.totalMs += durationMs;
    if (crashedInRange) entry.crashes += 1;
    entry.segments.push({
      key: `${run.instanceId}-${run.readyAt}-${index}`,
      leftPct,
      widthPct,
      crashPct,
    });
  });

  return [...grouped.values()].sort((a, b) => b.totalMs - a.totalMs || a.name.localeCompare(b.name));
}

export interface SeriesRun {
  points: Array<{ index: number; value: number }>;
}

/** Splits a nullable bucket series into contiguous runs so SVG lines and areas break cleanly across offline gaps. */
export function splitSeriesRuns(values: Array<number | null>): SeriesRun[] {
  const runs: SeriesRun[] = [];
  let current: Array<{ index: number; value: number }> = [];
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (value != null && Number.isFinite(value)) {
      current.push({ index: i, value });
    } else if (current.length > 0) {
      runs.push({ points: current });
      current = [];
    }
  }
  if (current.length > 0) runs.push({ points: current });
  return runs;
}

export function extractBucketValues(
  buckets: StatsMetricBucket[],
  metric: 'cpu' | 'memory',
  kind: 'host' | 'instances',
): Array<number | null> {
  if (metric === 'cpu') {
    return buckets.map((bucket) => (kind === 'host' ? bucket.hostCpuPercent : bucket.instancesCpuPercent));
  }
  return buckets.map((bucket) => (kind === 'host' ? bucket.hostMemoryBytes : bucket.instancesMemoryBytes));
}
