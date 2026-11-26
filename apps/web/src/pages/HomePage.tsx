import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { STATS_RANGE_ENUM, type InstanceInfo, type StatsOverview, type StatsRange } from '@mystry/shared';
import { api, getStatsOverview } from '../api';
import { metricWarningTexts, useDashboardMetrics } from '../components/DashboardMetrics';
import { PageHeader } from '../components/PageHeader';
import { ActivityTimeline } from '../components/home/ActivityTimeline';
import { rangePhraseKey } from '../components/home/format';
import { MachineCard } from '../components/home/MachineCard';
import { ResourceTrendCard, type TrendMetric } from '../components/home/ResourceTrendCard';
import { StatusBlocks } from '../components/home/StatusBlocks';
import { errorMessage, isAbortError } from '../errors';
import { usePolling } from '../hooks/usePolling';
import { useI18n } from '../i18n';

// The dialog, together with the QR code library, is loaded only when opened.
const RemoteAccessDialog = lazy(() =>
  import('../components/RemoteAccessDialog').then(({ RemoteAccessDialog }) => ({ default: RemoteAccessDialog })),
);

type LoadState = 'loading' | 'loaded' | 'error';

const RANGE_STORAGE_KEY = 'mystry_home_range';
const HISTORY_POLL_INTERVAL_MS = 300_000;

function readSavedRange(): StatsRange {
  try {
    const saved = localStorage.getItem(RANGE_STORAGE_KEY);
    if (saved && (STATS_RANGE_ENUM as readonly string[]).includes(saved)) return saved as StatsRange;
  } catch {
    // Ignore storage failures in restricted or private browsing contexts.
  }
  return '7d';
}

export function HomePage() {
  const i18n = useI18n();
  const { t, tp } = i18n;
  const [range, setRange] = useState<StatsRange>(readSavedRange);
  const [metric, setMetric] = useState<TrendMetric>('cpu');
  const [instances, setInstances] = useState<InstanceInfo[]>([]);
  const [instancesLoadState, setInstancesLoadState] = useState<LoadState>('loading');
  const [overview, setOverview] = useState<StatsOverview | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState('');
  const [remoteAccessOpen, setRemoteAccessOpen] = useState(false);

  const latestInstancesRequestRef = useRef(0);
  const latestOverviewRequestRef = useRef(0);
  const overviewAbortRef = useRef<AbortController | null>(null);
  const prevSignatureRef = useRef<string | null>(null);

  const { metrics, error: metricsError, busy: metricsBusy, refresh: refreshMetrics } = useDashboardMetrics();

  const loadInstances = useCallback(async () => {
    const requestId = ++latestInstancesRequestRef.current;
    try {
      const result = await api<InstanceInfo[]>('/api/instances');
      if (requestId !== latestInstancesRequestRef.current) return;
      setInstances(result);
      setInstancesLoadState('loaded');
    } catch {
      if (requestId !== latestInstancesRequestRef.current) return;
      setInstancesLoadState((current) => (current === 'loaded' ? 'loaded' : 'error'));
    }
  }, []);
  usePolling(loadInstances);

  const loadOverview = useCallback(async () => {
    const requestId = ++latestOverviewRequestRef.current;
    overviewAbortRef.current?.abort();
    const controller = new AbortController();
    overviewAbortRef.current = controller;
    setHistoryLoading(true);
    try {
      const result = await getStatsOverview(range, controller.signal);
      if (requestId !== latestOverviewRequestRef.current) return;
      setOverview(result);
      setHistoryError('');
      setHistoryLoading(false);
    } catch (err) {
      if (isAbortError(err) || requestId !== latestOverviewRequestRef.current) return;
      setHistoryError(errorMessage(err));
      // Drop stale data from a different range so switching ranges on failure does not display mismatched charts.
      setOverview((current) => (current?.range === range ? current : null));
      setHistoryLoading(false);
    }
  }, [range]);
  usePolling(loadOverview, HISTORY_POLL_INTERVAL_MS);

  useEffect(() => () => {
    overviewAbortRef.current?.abort();
  }, []);

  // Re-fetch history immediately whenever an instance changes status, finishes starting, is renamed or is deleted.
  const instanceSignature = useMemo(() => {
    if (instancesLoadState !== 'loaded') return null;
    return instances
      .map((inst) => `${inst.id}:${inst.status}:${inst.ready ? 1 : 0}:${inst.name}`)
      .sort()
      .join('|');
  }, [instances, instancesLoadState]);

  useEffect(() => {
    if (instanceSignature === null) return;
    if (prevSignatureRef.current === null) {
      prevSignatureRef.current = instanceSignature;
      return;
    }
    if (prevSignatureRef.current !== instanceSignature) {
      prevSignatureRef.current = instanceSignature;
      void loadOverview();
    }
  }, [instanceSignature, loadOverview]);

  function handleRangeChange(next: StatsRange) {
    if (next === range) return;
    setRange(next);
    try {
      localStorage.setItem(RANGE_STORAGE_KEY, next);
    } catch {
      // Ignore storage failures in restricted or private browsing contexts.
    }
  }

  function retryInstances() {
    setInstancesLoadState('loading');
    void loadInstances();
  }

  function retryHistory() {
    setHistoryError('');
    setHistoryLoading(true);
    void loadOverview();
  }

  const runningCount = instances.filter((inst) => inst.status === 'running').length;
  const activeOverview = overview?.range === range ? overview : null;
  const crashCount = activeOverview
    ? activeOverview.runs.filter((run) => run.endReason === 'crashed').length
    : 0;

  // Before overview loads (or when history fails), fall back to whether live metrics report unavailable per-process state.
  const processMetricsSupported = overview != null
    ? overview.processMetricsSupported
    : !Object.values(metrics?.instances ?? {}).some((sample) => sample.state === 'unavailable');

  const warningText = metrics && !metricsError ? metricWarningTexts(metrics, i18n.tm).join(' · ') : '';

  let subtitle: React.ReactNode = undefined;
  if (instancesLoadState === 'error') {
    subtitle = (
      <span className="home-status-error" role="alert">
        <span>{t('error.instances.load')}</span>
        <button type="button" className="link-button" onClick={retryInstances}>{t('action.retry')}</button>
      </span>
    );
  } else if (instancesLoadState === 'loaded' && instances.length > 0) {
    subtitle = (
      <span className="overview-status">
        {tp('home.status.running', runningCount)}
        {crashCount > 0 && (
          <span className="overview-status-issues">
            {tp('home.status.crashes', crashCount, { range: t(rangePhraseKey(range)) })}
          </span>
        )}
      </span>
    );
  }

  return (
    <div className="page home-page">
      <PageHeader
        title={t('nav.home')}
        subtitle={subtitle}
        actions={
          <div className="segmented home-range-switch" role="group" aria-label={t('home.range.label')}>
            {STATS_RANGE_ENUM.map((item) => (
              <button
                key={item}
                type="button"
                className={`segmented-item${range === item ? ' active' : ''}`}
                aria-pressed={range === item}
                onClick={() => handleRangeChange(item)}
              >
                {t(`home.range.${item}`)}
              </button>
            ))}
          </div>
        }
      />

      {metricsError && (
        <p className="overview-metrics-line is-error" role="alert">
          <span>{metrics ? t('dashboard.metrics.errorStale', { error: metricsError }) : metricsError}</span>
          <button type="button" className="link-button" disabled={metricsBusy} onClick={() => void refreshMetrics(true)}>
            {metricsBusy ? t('dashboard.metrics.refreshing') : t('dashboard.metrics.retry')}
          </button>
        </p>
      )}
      {/* Routine 5-second samples stay out of the live region; only a monitoring error or host warning is announced. */}
      <span className="visually-hidden" role="status">
        {metricsError ? (metrics ? t('dashboard.metrics.errorStale', { error: metricsError }) : metricsError) : warningText}
      </span>

      <StatusBlocks
        instances={instances}
        instancesLoadState={instancesLoadState}
        metrics={metrics}
        metricsError={metricsError}
        processMetricsSupported={processMetricsSupported}
        diskBreakdown={overview?.diskBreakdown ?? null}
      />

      <div className="home-pair">
        <ResourceTrendCard
          overview={activeOverview}
          loading={historyLoading}
          error={historyError}
          metric={metric}
          onMetricChange={setMetric}
          onRetry={retryHistory}
        />
        <MachineCard
          overview={overview}
          loading={historyLoading}
          error={historyError}
          onRetry={retryHistory}
          onOpenRemoteAccess={() => setRemoteAccessOpen(true)}
        />
      </div>

      <ActivityTimeline
        instances={instances}
        instancesLoadState={instancesLoadState}
        overview={activeOverview}
        historyLoading={historyLoading}
        historyError={historyError}
        onRetryInstances={retryInstances}
        onRetryHistory={retryHistory}
      />

      {remoteAccessOpen && (
        <Suspense fallback={null}>
          <RemoteAccessDialog onClose={() => setRemoteAccessOpen(false)} />
        </Suspense>
      )}
    </div>
  );
}
