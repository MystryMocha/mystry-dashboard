import { useEffect, useMemo, useRef, useState } from 'react';
import type { StatsOverview } from '@mystry/shared';
import { useI18n, type Formatters, type MessageKey } from '../../i18n';
import {
  extractBucketValues,
  formatAxisTick,
  formatBucketTooltipTime,
  formatCapacity,
  formatRate,
  memoryAxisSpec,
  rangePhraseKey,
  rateAxisSpec,
  splitSeriesRuns,
  type SeriesRun,
  type TrendSeriesField,
} from './format';

export type TrendMetric = 'cpu' | 'memory' | 'network' | 'disk';

interface ResourceTrendCardProps {
  overview: StatsOverview | null;
  loading: boolean;
  error: string;
  metric: TrendMetric;
  onMetricChange: (metric: TrendMetric) => void;
  onRetry: () => void;
}

type SeriesTone = 'is-context' | 'is-s1' | 'is-s2';

interface SeriesSpec {
  field: TrendSeriesField;
  label: MessageKey;
  tone: SeriesTone;
  /** Only the instance share of CPU and memory gets a filled area; two overlapping I/O areas would muddy each other. */
  area: boolean;
}

interface ChartSeries extends SeriesSpec {
  raw: Array<number | null>;
  scaled: Array<number | null>;
  runs: SeriesRun[];
  latest: number | null;
  peak: number | null;
}

const DEFAULT_PLOT_WIDTH = 560;
const DEFAULT_PLOT_HEIGHT = 176;

const METRIC_LABELS: Record<TrendMetric, MessageKey> = {
  cpu: 'home.stat.cpu',
  memory: 'home.stat.memory',
  network: 'home.trend.network',
  disk: 'home.trend.diskIo',
};

/** Space for the widest Y tick label of each metric ("100%", "32 GiB", "1,000 KiB/s"). */
const LEFT_MARGIN: Record<TrendMetric, number> = { cpu: 42, memory: 54, network: 72, disk: 72 };

function seriesFor(metric: TrendMetric, showInstances: boolean): SeriesSpec[] {
  switch (metric) {
    case 'network':
      return [
        { field: 'hostNetRxBytesPerSec', label: 'home.trend.download', tone: 'is-s1', area: false },
        { field: 'hostNetTxBytesPerSec', label: 'home.trend.upload', tone: 'is-s2', area: false },
      ];
    case 'disk':
      return [
        { field: 'hostDiskReadBytesPerSec', label: 'home.trend.read', tone: 'is-s1', area: false },
        { field: 'hostDiskWriteBytesPerSec', label: 'home.trend.write', tone: 'is-s2', area: false },
      ];
    case 'memory':
      return [
        { field: 'hostMemoryBytes', label: 'home.breakdown.all', tone: 'is-context', area: false },
        ...(showInstances ? [{ field: 'instancesMemoryBytes', label: 'home.breakdown.instances', tone: 'is-s1', area: true } as const] : []),
      ];
    default:
      return [
        { field: 'hostCpuPercent', label: 'home.breakdown.all', tone: 'is-context', area: false },
        ...(showInstances ? [{ field: 'instancesCpuPercent', label: 'home.breakdown.instances', tone: 'is-s1', area: true } as const] : []),
      ];
  }
}

function axisFor(metric: TrendMetric, overview: StatsOverview, peak: number, fmt: Formatters) {
  if (metric === 'cpu') {
    return {
      yMax: 100,
      yTicks: [0, 50, 100],
      unitScale: 1,
      formatTick: (value: number) => fmt.percent(value, 0),
      formatValue: (value: number) => fmt.percent(value, 1),
    };
  }
  if (metric === 'memory') {
    const axis = memoryAxisSpec(overview.host.totalMemoryBytes, peak, fmt);
    return {
      yMax: axis.maxUnit,
      yTicks: axis.ticks,
      unitScale: axis.unitBytes,
      formatTick: axis.formatTick,
      formatValue: (bytes: number) => formatCapacity(bytes, fmt),
    };
  }
  const axis = rateAxisSpec(peak, fmt);
  return {
    yMax: axis.maxUnit,
    yTicks: axis.ticks,
    unitScale: axis.unitBytes,
    formatTick: axis.formatTick,
    formatValue: (bytesPerSec: number) => formatRate(bytesPerSec, fmt),
  };
}

function isFiniteValue(value: number | null): value is number {
  return value != null && Number.isFinite(value);
}

/**
 * Hand-written SVG trend chart for host and instance CPU / memory, and host network and disk I/O, over the selected range.
 * Breaks lines and area fills cleanly at null offline gaps, draws dots for isolated samples, and follows sidebar resize via ResizeObserver.
 */
export function ResourceTrendCard({
  overview,
  loading,
  error,
  metric: requestedMetric,
  onMetricChange,
  onRetry,
}: ResourceTrendCardProps) {
  const { t, fmt } = useI18n();
  const plotRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: DEFAULT_PLOT_WIDTH, height: DEFAULT_PLOT_HEIGHT });
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const buckets = overview?.buckets ?? [];
  const showInstances = Boolean(overview?.processMetricsSupported);
  // Assume support until the first response so the tabs do not appear a moment after the page loads.
  const ioSupported = overview ? overview.ioMetricsSupported : true;
  const metrics: TrendMetric[] = ioSupported ? ['cpu', 'memory', 'network', 'disk'] : ['cpu', 'memory'];
  const metric = metrics.includes(requestedMetric) ? requestedMetric : 'cpu';

  const chartData = useMemo(() => {
    if (!overview || buckets.length === 0) return null;
    const specs = seriesFor(metric, showInstances);
    const raws = specs.map((spec) => extractBucketValues(buckets, spec.field));
    const present = raws.map((raw) => raw.filter(isFiniteValue));
    if (present.every((values) => values.length === 0)) return null;

    const peakAll = Math.max(0, ...present.flat());
    const axis = axisFor(metric, overview, peakAll, fmt);
    const series: ChartSeries[] = specs.map((spec, index) => {
      const raw = raws[index]!;
      const values = present[index]!;
      const scaled = raw.map((value) => (isFiniteValue(value) ? value / axis.unitScale : null));
      return {
        ...spec,
        raw,
        scaled,
        runs: splitSeriesRuns(scaled),
        latest: values.at(-1) ?? null,
        peak: values.length > 0 ? Math.max(...values) : null,
      };
    });
    return { ...axis, series };
  }, [overview, buckets, metric, showInstances, fmt]);

  const hasChart = Boolean(chartData);

  useEffect(() => {
    if (!hasChart) return;
    const node = plotRef.current;
    if (!node) return;
    const measure = () => {
      const width = node.clientWidth;
      const height = node.clientHeight;
      if (width > 0 && height > 0) {
        setSize((current) => (current.width === width && current.height === height ? current : { width, height }));
      }
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasChart]);

  useEffect(() => {
    setHoverIndex(null);
  }, [overview, metric]);

  const width = size.width;
  const height = size.height;
  const margin = { top: 10, right: 12, bottom: 24, left: LEFT_MARGIN[metric] };
  const plotWidth = Math.max(1, width - margin.left - margin.right);
  const plotHeight = Math.max(1, height - margin.top - margin.bottom);

  const xFor = (index: number) => {
    if (buckets.length <= 1) return margin.left + plotWidth / 2;
    return margin.left + (index / (buckets.length - 1)) * plotWidth;
  };
  const yFor = (value: number, yMax: number) => {
    const ratio = yMax > 0 ? Math.max(0, Math.min(1, value / yMax)) : 0;
    return margin.top + plotHeight - ratio * plotHeight;
  };

  function handlePointer(event: React.PointerEvent<HTMLDivElement>) {
    if (!chartData || buckets.length === 0 || !plotRef.current) return;
    const rect = plotRef.current.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, (localX - margin.left) / plotWidth));
    const index = buckets.length <= 1 ? 0 : Math.round(ratio * (buckets.length - 1));
    setHoverIndex(index);
  }

  const xTicks = useMemo(() => {
    if (!overview) return [];
    const fromMs = Date.parse(overview.from);
    const toMs = Date.parse(overview.to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return [];
    const count = plotWidth < 340 ? 3 : 5;
    return Array.from({ length: count }, (_, idx) => {
      const ratio = idx / (count - 1);
      return {
        key: idx,
        x: margin.left + ratio * plotWidth,
        anchor: (idx === 0 ? 'start' : idx === count - 1 ? 'end' : 'middle') as 'start' | 'middle' | 'end',
        label: formatAxisTick(fromMs + ratio * (toMs - fromMs), overview.range, fmt),
      };
    });
  }, [overview, plotWidth, margin.left, fmt]);

  const summaryLabel = useMemo(() => {
    const [first, second] = chartData?.series ?? [];
    if (!overview || !chartData || !first) return t('home.trend.title');
    const metricName = t(METRIC_LABELS[metric]);
    const rangeText = t(rangePhraseKey(overview.range));
    const format = chartData.formatValue;
    // Either I/O line can be empty on its own (a counter that reset), and the other one is still drawn.
    if (metric === 'network' || metric === 'disk') {
      const show = (value: number | null | undefined) => (value != null ? format(value) : '—');
      return t('home.trend.summaryPair', {
        metric: metricName,
        range: rangeText,
        first: t(first.label),
        firstLatest: show(first.latest),
        firstPeak: show(first.peak),
        second: second ? t(second.label) : '',
        secondLatest: show(second?.latest),
        secondPeak: show(second?.peak),
      });
    }
    if (first.latest == null || first.peak == null) return t('home.trend.title');
    if (second && second.latest != null && second.peak != null) {
      return t('home.trend.summarySplit', {
        metric: metricName,
        range: rangeText,
        latest: format(first.latest),
        peak: format(first.peak),
        instLatest: format(second.latest),
        instPeak: format(second.peak),
      });
    }
    return t('home.trend.summary', {
      metric: metricName,
      range: rangeText,
      latest: format(first.latest),
      peak: format(first.peak),
    });
  }, [overview, chartData, metric, t]);

  // With no history to draw, a failed counter read must not look like data that is still on its way.
  const emptyMessage: MessageKey =
    metric === 'network' && overview?.ioReadFailed.network ? 'home.trend.networkUnavailable'
      : metric === 'disk' && overview?.ioReadFailed.disk ? 'home.trend.diskIoUnavailable'
        : 'home.trend.collecting';

  const hoveredBucket = hoverIndex != null && buckets[hoverIndex] ? buckets[hoverIndex] : null;
  const hoverX = hoverIndex != null ? xFor(hoverIndex) : null;
  const flipTooltipLeft = hoverX != null && hoverX > margin.left + plotWidth * 0.58;

  return (
    <section className="form-section" aria-labelledby="home-trend-title">
      <div className="home-section-head">
        <h2 className="form-section-title" id="home-trend-title">{t('home.trend.title')}</h2>
        <div className="segmented home-metric-tabs" role="group" aria-label={t('home.trend.metricLabel')}>
          {metrics.map((item) => (
            <button
              key={item}
              type="button"
              className={`segmented-item${metric === item ? ' active' : ''}`}
              aria-pressed={metric === item}
              onClick={() => onMetricChange(item)}
            >
              {t(METRIC_LABELS[item])}
            </button>
          ))}
        </div>
      </div>

      <div className="home-panel home-trend-panel">
        {loading && !overview ? (
          <div className="home-panel-state" role="status">
            <span className="spinner spinner-sm" aria-hidden="true" />
            <span>{t('common.loading')}</span>
          </div>
        ) : error && !overview ? (
          <div className="home-panel-state is-error" role="alert">
            <span>{t('home.history.error')}</span>
            <button type="button" className="link-button" onClick={onRetry}>{t('action.retry')}</button>
          </div>
        ) : !chartData ? (
          <div className="home-panel-state" role="status">
            <span>{t(emptyMessage)}</span>
          </div>
        ) : (
          <>
            <ul className="home-legend" aria-hidden="true">
              {chartData.series.map((series) => (
                <li key={series.field}><span className={`home-line-key ${series.tone}`} />{t(series.label)}</li>
              ))}
            </ul>

            <div
              ref={plotRef}
              className="home-plot"
              onPointerMove={handlePointer}
              onPointerDown={handlePointer}
              onPointerLeave={() => setHoverIndex(null)}
            >
              <svg width={width} height={height} role="img" aria-label={summaryLabel}>
                {chartData.yTicks.map((tick) => {
                  const yPos = yFor(tick, chartData.yMax);
                  return (
                    <g key={tick}>
                      <line
                        className={tick === 0 ? 'home-chart-axis' : 'home-chart-grid'}
                        x1={margin.left}
                        x2={width - margin.right}
                        y1={yPos}
                        y2={yPos}
                      />
                      <text className="home-chart-tick" x={margin.left - 8} y={yPos + 4} textAnchor="end">
                        {chartData.formatTick(tick)}
                      </text>
                    </g>
                  );
                })}

                {xTicks.map((tick) => (
                  <text key={tick.key} className="home-chart-tick" x={tick.x} y={height - 5} textAnchor={tick.anchor}>
                    {tick.label}
                  </text>
                ))}

                {chartData.series.map((series) => series.runs.map((run, idx) => {
                  if (run.points.length === 1) {
                    const pt = run.points[0]!;
                    return (
                      <circle
                        key={`${series.field}-dot-${idx}`}
                        className={`home-chart-dot ${series.tone}`}
                        cx={xFor(pt.index)}
                        cy={yFor(pt.value, chartData.yMax)}
                        r={3}
                      />
                    );
                  }
                  const d = run.points
                    .map((pt, k) => `${k === 0 ? 'M' : 'L'}${xFor(pt.index).toFixed(1)},${yFor(pt.value, chartData.yMax).toFixed(1)}`)
                    .join('');
                  if (!series.area) {
                    return <path key={`${series.field}-line-${idx}`} className={`home-chart-line ${series.tone}`} d={d} />;
                  }
                  const first = run.points[0]!;
                  const last = run.points[run.points.length - 1]!;
                  const baseY = yFor(0, chartData.yMax).toFixed(1);
                  const areaD = `${d}L${xFor(last.index).toFixed(1)},${baseY}L${xFor(first.index).toFixed(1)},${baseY}Z`;
                  return (
                    <g key={`${series.field}-run-${idx}`}>
                      <path className={`home-chart-area ${series.tone}`} d={areaD} />
                      <path className={`home-chart-line ${series.tone}`} d={d} />
                    </g>
                  );
                }))}

                {hoverIndex != null && hoverX != null && (
                  <g className="home-chart-hover" aria-hidden="true">
                    <line
                      className="home-chart-crosshair"
                      x1={hoverX}
                      x2={hoverX}
                      y1={margin.top}
                      y2={margin.top + plotHeight}
                    />
                    {chartData.series.map((series) => {
                      const value = series.scaled[hoverIndex];
                      return value != null ? (
                        <circle
                          key={series.field}
                          className={`home-chart-dot ${series.tone}`}
                          cx={hoverX}
                          cy={yFor(value, chartData.yMax)}
                          r={4}
                        />
                      ) : null;
                    })}
                  </g>
                )}
              </svg>

              {hoveredBucket && hoverX != null && overview && (
                <div
                  className="home-chart-tooltip"
                  style={flipTooltipLeft ? { right: Math.max(8, width - hoverX + 10) } : { left: Math.max(8, hoverX + 10) }}
                >
                  <div className="home-chart-tooltip-time">
                    {formatBucketTooltipTime(hoveredBucket.timestamp, overview.range, fmt)}
                  </div>
                  <dl className="home-chart-tooltip-dl">
                    {chartData.series.map((series) => {
                      const value = series.raw[hoverIndex!] ?? null;
                      return (
                        <div key={series.field}>
                          <dt><span className={`home-swatch ${series.tone}`} aria-hidden="true" />{t(series.label)}</dt>
                          <dd>{isFiniteValue(value) ? chartData.formatValue(value) : '—'}</dd>
                        </div>
                      );
                    })}
                  </dl>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
