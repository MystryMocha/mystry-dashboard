import { Fragment, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Server } from 'lucide-react';
import type { InstanceInfo, StatsOverview } from '@mystry/shared';
import { useI18n } from '../../i18n';
import { buildTimelineRows, formatAxisTick, formatRunDuration, rangePhraseKey } from './format';

type LoadState = 'loading' | 'loaded' | 'error';

interface ActivityTimelineProps {
  instances: InstanceInfo[];
  instancesLoadState: LoadState;
  overview: StatsOverview | null;
  historyLoading: boolean;
  historyError: string;
  onRetryInstances: () => void;
  onRetryHistory: () => void;
}

/**
 * Row 3 of the home dashboard: per-instance state timeline (ready runs in green, crashes as red bars) or the horizontal empty state when no instances exist.
 */
export function ActivityTimeline({
  instances,
  instancesLoadState,
  overview,
  historyLoading,
  historyError,
  onRetryInstances,
  onRetryHistory,
}: ActivityTimelineProps) {
  const i18n = useI18n();
  const { t, tp, fmt } = i18n;

  const rows = useMemo(() => {
    if (!overview || instancesLoadState !== 'loaded') return [];
    return buildTimelineRows(overview.runs, instances, overview.from, overview.to);
  }, [overview, instances, instancesLoadState]);

  const axisTicks = useMemo(() => {
    if (!overview) return [];
    const fromMs = Date.parse(overview.from);
    const toMs = Date.parse(overview.to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return [];
    const count = overview.range === '7d' ? 8 : overview.range === '30d' ? 7 : 5;
    return Array.from({ length: count }, (_, idx) => {
      const ratio = idx / (count - 1);
      return {
        key: idx,
        label: formatAxisTick(fromMs + ratio * (toMs - fromMs), overview.range, fmt),
      };
    });
  }, [overview, fmt]);

  const showLegend = instancesLoadState === 'loaded' && instances.length > 0 && rows.length > 0;
  const rangePhrase = overview ? t(rangePhraseKey(overview.range)) : '';

  return (
    <section className="form-section" aria-labelledby="home-activity-title">
      <div className="home-section-head">
        <h2 className="form-section-title" id="home-activity-title">{t('home.activity.title')}</h2>
        {showLegend && (
          <ul className="home-legend" aria-hidden="true">
            <li><span className="home-swatch is-green" />{t('home.activity.legend.running')}</li>
            <li><span className="home-swatch is-red" />{t('home.activity.legend.crashed')}</li>
          </ul>
        )}
      </div>

      {instancesLoadState === 'loading' ? (
        <div className="home-panel home-timeline-panel">
          <div className="home-panel-state" role="status">
            <span className="spinner spinner-sm" aria-hidden="true" />
            <span>{t('common.loading')}</span>
          </div>
        </div>
      ) : instancesLoadState === 'error' ? (
        <div className="home-panel home-timeline-panel">
          <div className="home-panel-state is-error" role="alert">
            <span>{t('error.instances.load')}</span>
            <button type="button" className="link-button" onClick={onRetryInstances}>{t('action.retry')}</button>
          </div>
        </div>
      ) : instances.length === 0 ? (
        <div className="home-empty-panel">
          <div className="home-empty-lead">
            <span className="home-empty-icon" aria-hidden="true">
              <Server size={20} />
            </span>
            <div className="home-empty-text">
              <h3 className="home-empty-title">{t('empty.instances.title')}</h3>
              <p className="home-empty-body">{t('empty.instances.body')}</p>
            </div>
          </div>
          <div className="home-empty-actions">
            <Link to="/deploy" className="btn btn-primary">{t('nav.deploy')}</Link>
            <Link to="/import" className="btn">{t('nav.import')}</Link>
          </div>
        </div>
      ) : historyLoading && !overview ? (
        <div className="home-panel home-timeline-panel">
          <div className="home-panel-state" role="status">
            <span className="spinner spinner-sm" aria-hidden="true" />
            <span>{t('common.loading')}</span>
          </div>
        </div>
      ) : historyError && !overview ? (
        <div className="home-panel home-timeline-panel">
          <div className="home-panel-state is-error" role="alert">
            <span>{t('home.history.error')}</span>
            <button type="button" className="link-button" onClick={onRetryHistory}>{t('action.retry')}</button>
          </div>
        </div>
      ) : rows.length === 0 ? (
        <div className="home-panel home-timeline-panel">
          <div className="home-panel-state">
            <span>{t('home.activity.empty')}</span>
          </div>
        </div>
      ) : (
        <div className="home-panel home-timeline-panel">
          <div className="home-tl-grid">
            <ul className="home-tl-list">
              {rows.map((row) => {
                const duration = formatRunDuration(row.totalMs, i18n);
                const accessibleLabel = row.crashes > 0
                  ? tp('home.activity.rowLabelWithCrashes', row.crashes, {
                    name: row.name,
                    range: rangePhrase,
                    duration,
                  })
                  : t('home.activity.rowLabel', {
                    name: row.name,
                    range: rangePhrase,
                    duration,
                  });
                return (
                  <li key={row.instanceId} className="home-tl-item">
                    <Link
                      to={`/instances/${row.instanceId}`}
                      className="home-tl-row"
                      aria-label={accessibleLabel}
                    >
                      <span className="home-tl-name" aria-hidden="true" title={row.name}>{row.name}</span>
                      <span className="home-tl-track" aria-hidden="true">
                        {row.segments.map((seg) => {
                          const clampedWidthPct = Math.min(seg.widthPct, Math.max(0, 100 - seg.leftPct));
                          return (
                            <Fragment key={seg.key}>
                              <span
                                className="home-tl-run"
                                style={{
                                  left: `clamp(0%, ${seg.leftPct.toFixed(4)}%, calc(100% - 2px))`,
                                  width: `max(${clampedWidthPct.toFixed(4)}%, 2px)`,
                                }}
                              />
                              {seg.crashPct != null && (
                                <span
                                  className="home-tl-crash"
                                  style={{
                                    left: `clamp(0px, calc(${seg.crashPct.toFixed(4)}% - 1.5px), calc(100% - 3px))`,
                                  }}
                                />
                              )}
                            </Fragment>
                          );
                        })}
                      </span>
                      <span className="home-tl-duration" aria-hidden="true">{duration}</span>
                      <ChevronRight size={16} aria-hidden="true" className="home-chevron" />
                    </Link>
                  </li>
                );
              })}
            </ul>

            <div className="home-tl-axis" aria-hidden="true">
              <div className="home-tl-ticks">
                {axisTicks.map((tick) => (
                  <span key={tick.key}>{tick.label}</span>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
