import { useEffect, useMemo, useRef, useState } from 'react';
import type { StatsOverview } from '@mystry/shared';
import { useI18n } from '../../i18n';
import {
  extractBucketValues,
  formatAxisTick,
  formatBucketTooltipTime,
  formatCapacity,
  memoryAxisSpec,
  rangePhraseKey,
  splitSeriesRuns,
} from './format';

export type TrendMetric = 'cpu' | 'memory';

interface ResourceTrendCardProps {
  overview: StatsOverview | null;
  loading: boolean;
  error: string;
  metric: TrendMetric;
  onMetricChange: (metric: TrendMetric) => void;
  onRetry: () => void;
}

const DEFAULT_PLOT_WIDTH = 560;
const DEFAULT_PLOT_HEIGHT = 176;

/**
 * Hand-written SVG trend chart for host and instance CPU / memory over the selected range.
 * Breaks lines and area fills cleanly at null offline gaps, draws dots for isolated samples, and follows sidebar resize via ResizeObserver.
 */
export function ResourceTrendCard({
  overview,
  loading,
  error,
  metric,
  onMetricChange,
  onRetry,
}: ResourceTrendCardProps) {
  const { t, fmt } = useI18n();
  const plotRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: DEFAULT_PLOT_WIDTH, height: DEFAULT_PLOT_HEIGHT });
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const buckets = overview?.buckets ?? [];
  const showInstances = Boolean(overview?.processMetricsSupported);

  const chartData = useMemo(() => {
    if (!overview || buckets.length === 0) return null;
    const hostRaw = extractBucketValues(buckets, metric, 'host');
    const instRaw = showInstances ? extractBucketValues(buckets, metric, 'instances') : [];

    const hostNonNull = hostRaw.filter((v): v is number => v != null && Number.isFinite(v));
    const instNonNull = instRaw.filter((v): v is number => v != null && Number.isFinite(v));
    if (hostNonNull.length === 0 && instNonNull.length === 0) return null;

    if (metric === 'cpu') {
      return {
        yMax: 100,
        yTicks: [0, 50, 100],
        formatTick: (value: number) => fmt.percent(value, 0),
        formatValue: (value: number) => fmt.percent(value, 1),
        hostValues: hostRaw,
        instValues: instRaw,
        hostRuns: splitSeriesRuns(hostRaw),
        instRuns: splitSeriesRuns(instRaw),
        hostLatest: hostNonNull.at(-1) ?? null,
        hostPeak: hostNonNull.length > 0 ? Math.max(...hostNonNull) : null,
        instLatest: instNonNull.at(-1) ?? null,
        instPeak: instNonNull.length > 0 ? Math.max(...instNonNull) : null,
        unitScale: 1,
      };
    }

    const peakBytes = Math.max(0, ...hostNonNull, ...instNonNull);
    const axis = memoryAxisSpec(overview.host.totalMemoryBytes, peakBytes, fmt);
    const hostScaled = hostRaw.map((v) => (v != null ? v / axis.unitBytes : null));
    const instScaled = instRaw.map((v) => (v != null ? v / axis.unitBytes : null));

    return {
      yMax: axis.maxUnit,
      yTicks: axis.ticks,
      formatTick: axis.formatTick,
      formatValue: (bytes: number) => formatCapacity(bytes, fmt),
      hostValues: hostScaled,
      instValues: instScaled,
      hostRuns: splitSeriesRuns(hostScaled),
      instRuns: splitSeriesRuns(instScaled),
      hostLatest: hostNonNull.at(-1) ?? null,
      hostPeak: hostNonNull.length > 0 ? Math.max(...hostNonNull) : null,
      instLatest: instNonNull.at(-1) ?? null,
      instPeak: instNonNull.length > 0 ? Math.max(...instNonNull) : null,
      unitScale: axis.unitBytes,
    };
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
  const margin = { top: 10, right: 12, bottom: 24, left: metric === 'memory' ? 54 : 42 };
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
    if (!overview || !chartData || chartData.hostLatest == null || chartData.hostPeak == null) {
      return t('home.trend.title');
    }
    const metricName = metric === 'cpu' ? t('home.stat.cpu') : t('home.stat.memory');
    const rangeText = t(rangePhraseKey(overview.range));
    if (showInstances && chartData.instLatest != null && chartData.instPeak != null) {
      return t('home.trend.summarySplit', {
        metric: metricName,
        range: rangeText,
        latest: chartData.formatValue(chartData.hostLatest),
        peak: chartData.formatValue(chartData.hostPeak),
        instLatest: chartData.formatValue(chartData.instLatest),
        instPeak: chartData.formatValue(chartData.instPeak),
      });
    }
    return t('home.trend.summary', {
      metric: metricName,
      range: rangeText,
      latest: chartData.formatValue(chartData.hostLatest),
      peak: chartData.formatValue(chartData.hostPeak),
    });
  }, [overview, chartData, metric, showInstances, t]);

  const hoveredBucket = hoverIndex != null && buckets[hoverIndex] ? buckets[hoverIndex] : null;
  const hoverX = hoverIndex != null ? xFor(hoverIndex) : null;
  const flipTooltipLeft = hoverX != null && hoverX > margin.left + plotWidth * 0.58;

  return (
    <section className="form-section" aria-labelledby="home-trend-title">
      <div className="home-section-head">
        <h2 className="form-section-title" id="home-trend-title">{t('home.trend.title')}</h2>
        <div className="segmented home-metric-tabs" role="group" aria-label={t('home.trend.metricLabel')}>
          <button
            type="button"
            className={`segmented-item${metric === 'cpu' ? ' active' : ''}`}
            aria-pressed={metric === 'cpu'}
            onClick={() => onMetricChange('cpu')}
          >
            {t('home.stat.cpu')}
          </button>
          <button
            type="button"
            className={`segmented-item${metric === 'memory' ? ' active' : ''}`}
            aria-pressed={metric === 'memory'}
            onClick={() => onMetricChange('memory')}
          >
            {t('home.stat.memory')}
          </button>
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
            <span>{t('home.trend.collecting')}</span>
          </div>
        ) : (
          <>
            <ul className="home-legend" aria-hidden="true">
              <li><span className="home-line-key is-context" />{t('home.breakdown.all')}</li>
              {showInstances && <li><span className="home-line-key is-s1" />{t('home.breakdown.instances')}</li>}
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

                {chartData.hostRuns.map((run, idx) => {
                  if (run.points.length === 1) {
                    const pt = run.points[0]!;
                    return (
                      <circle
                        key={`h-dot-${idx}`}
                        className="home-chart-dot is-context"
                        cx={xFor(pt.index)}
                        cy={yFor(pt.value, chartData.yMax)}
                        r={3}
                      />
                    );
                  }
                  const d = run.points
                    .map((pt, k) => `${k === 0 ? 'M' : 'L'}${xFor(pt.index).toFixed(1)},${yFor(pt.value, chartData.yMax).toFixed(1)}`)
                    .join('');
                  return <path key={`h-line-${idx}`} className="home-chart-line is-context" d={d} />;
                })}

                {showInstances && chartData.instRuns.map((run, idx) => {
                  if (run.points.length === 1) {
                    const pt = run.points[0]!;
                    return (
                      <circle
                        key={`i-dot-${idx}`}
                        className="home-chart-dot is-s1"
                        cx={xFor(pt.index)}
                        cy={yFor(pt.value, chartData.yMax)}
                        r={3}
                      />
                    );
                  }
                  const d = run.points
                    .map((pt, k) => `${k === 0 ? 'M' : 'L'}${xFor(pt.index).toFixed(1)},${yFor(pt.value, chartData.yMax).toFixed(1)}`)
                    .join('');
                  const first = run.points[0]!;
                  const last = run.points[run.points.length - 1]!;
                  const baseY = yFor(0, chartData.yMax).toFixed(1);
                  const areaD = `${d}L${xFor(last.index).toFixed(1)},${baseY}L${xFor(first.index).toFixed(1)},${baseY}Z`;
                  return (
                    <g key={`i-run-${idx}`}>
                      <path className="home-chart-area is-s1" d={areaD} />
                      <path className="home-chart-line is-s1" d={d} />
                    </g>
                  );
                })}

                {hoverIndex != null && hoverX != null && (
                  <g className="home-chart-hover" aria-hidden="true">
                    <line
                      className="home-chart-crosshair"
                      x1={hoverX}
                      x2={hoverX}
                      y1={margin.top}
                      y2={margin.top + plotHeight}
                    />
                    {chartData.hostValues[hoverIndex] != null && (
                      <circle
                        className="home-chart-dot is-context"
                        cx={hoverX}
                        cy={yFor(chartData.hostValues[hoverIndex]!, chartData.yMax)}
                        r={4}
                      />
                    )}
                    {showInstances && chartData.instValues[hoverIndex] != null && (
                      <circle
                        className="home-chart-dot is-s1"
                        cx={hoverX}
                        cy={yFor(chartData.instValues[hoverIndex]!, chartData.yMax)}
                        r={4}
                      />
                    )}
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
                    <div>
                      <dt><span className="home-swatch is-context" aria-hidden="true" />{t('home.breakdown.all')}</dt>
                      <dd>
                        {metric === 'cpu'
                          ? (hoveredBucket.hostCpuPercent != null ? fmt.percent(hoveredBucket.hostCpuPercent, 1) : '—')
                          : (hoveredBucket.hostMemoryBytes != null ? formatCapacity(hoveredBucket.hostMemoryBytes, fmt) : '—')}
                      </dd>
                    </div>
                    {showInstances && (
                      <div>
                        <dt><span className="home-swatch is-s1" aria-hidden="true" />{t('home.breakdown.instances')}</dt>
                        <dd>
                          {metric === 'cpu'
                            ? (hoveredBucket.instancesCpuPercent != null ? fmt.percent(hoveredBucket.instancesCpuPercent, 1) : '—')
                            : (hoveredBucket.instancesMemoryBytes != null ? formatCapacity(hoveredBucket.instancesMemoryBytes, fmt) : '—')}
                        </dd>
                      </div>
                    )}
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
