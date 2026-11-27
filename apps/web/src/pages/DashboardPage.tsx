import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ChevronRight,
  FolderDown,
  Play,
  Plus,
  Power,
  RotateCcw,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import type { DashboardMetrics, InstanceInfo } from '@mystry/shared';
import { api, controlInstance, type InstanceAction } from '../api';
import {
  Meter,
  metricWarningTexts,
  processMetric,
  useDashboardMetrics,
} from '../components/DashboardMetrics';
import { ActionMenu } from '../components/ActionMenu';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { CoreIcon, coreDisplayName } from '../components/CoreIcon';
import { DeleteInstanceDialog } from '../components/DeleteInstanceDialog';
import { EulaCheckbox } from '../components/EulaCheckbox';
import { JavaRuntimeSelect } from '../components/JavaRuntimeSelect';
import { JvmSettingsEditor } from '../components/JvmSettingsEditor';
import { PageHeader } from '../components/PageHeader';
import { StartPaths } from '../components/StartPaths';
import { InstanceStatusPill } from '../components/StatusPill';
import { errorMessage } from '../errors';
import { useInstanceAction } from '../hooks/useInstanceAction';
import { usePolling } from '../hooks/usePolling';
import { useI18n, type I18n } from '../i18n';
import { instanceNameIssue } from '../validation';
import { hasIssue, rowState } from '../instance-attention';
import {
  canStartInstance,
  canStopInstance,
  isLifecycleBusy,
  isProcessAlive,
  isServerRunning,
} from '../instance-status';

type LoadState = 'loading' | 'loaded' | 'error';
type ListFilter = 'all' | 'running' | 'issues';

const XMX_UNITS: Record<string, number> = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

/** Parses -Xmx into bytes; returns null when unset or in an unrecognized format, and the caller shows "Default". */
function parseXmxBytes(jvmArgs: string): number | null {
  const match = jvmArgs.match(/-Xmx(\d+(?:\.\d+)?)([kmgt]?)\b/i);
  if (!match) return null;
  const bytes = Number(match[1]) * XMX_UNITS[match[2].toUpperCase()];
  return Number.isFinite(bytes) && bytes > 0 ? bytes : null;
}

function formatGib(bytes: number, fmt: I18n['fmt']): string {
  const gib = bytes / 1024 ** 3;
  // Whole GiB values (the common 2G, 4G) have no decimals; the rest keep one decimal place.
  return `${fmt.gib(bytes, Number.isInteger(gib) ? 0 : 1)} GiB`;
}

function ServerRow({
  inst,
  metrics,
  metricsError,
  busy,
  onAction,
  onRestart,
  onForceStop,
  onDelete,
}: {
  inst: InstanceInfo;
  metrics: DashboardMetrics | null;
  metricsError: string;
  busy: boolean;
  onAction: (action: InstanceAction) => void;
  onRestart: () => void;
  onForceStop: () => void;
  onDelete: () => void;
}) {
  const i18n = useI18n();
  const { t, fmt } = i18n;
  const state = rowState(inst, t);
  const live = isProcessAlive(inst.status);
  const hasOrphan = Boolean(inst.orphanProcess);
  const xmxBytes = parseXmxBytes(inst.jvmArgs);
  const memoryBytes = metrics?.instances[inst.id]?.memoryBytes ?? null;
  const coreName = coreDisplayName(inst.coreType, t);
  const Fix = state.fix?.icon;

  return (
    <li className="server-row">
      <CoreIcon coreType={inst.coreType} />
      <div className="server-id">
        {/* The name link's click area is spread across the whole row with a pseudo-element (except buttons), and the arrow at the end of the row hints that the row opens the instance. */}
        <Link to={`/instances/${inst.id}`} className="server-name" title={inst.name}>
          {inst.name}
        </Link>
        <span className="server-core">
          {coreName}
          {inst.mcVersion ? ` ${inst.mcVersion}` : ''}
        </span>
      </div>

      <div className="server-state">
        <div className="server-status-line">
          <InstanceStatusPill instance={inst} />
          {state.sentence && (
            <span className={`server-sentence${state.tone ? ` is-${state.tone}` : ''}`}>{state.sentence}</span>
          )}
        </div>
        {live ? (
          <dl className="server-figures">
            <div className="server-figure">
              <dt title={t('dashboard.row.cpu.hint')}>{t('dashboard.row.cpu')}</dt>
              <dd>{processMetric(inst, metrics, metricsError, 'cpu', i18n)}</dd>
            </div>
            <div className="server-figure server-figure-memory">
              <dt title={t('dashboard.row.memory.hint')}>{t('dashboard.row.memory')}</dt>
              <dd>
                <span>{processMetric(inst, metrics, metricsError, 'memory', i18n)}</span>
                {xmxBytes != null && (
                  <span className="server-cap">{t('dashboard.row.memoryCap', { max: formatGib(xmxBytes, fmt) })}</span>
                )}
              </dd>
              {xmxBytes != null && (
                <Meter ratio={memoryBytes != null ? (memoryBytes / xmxBytes) * 100 : null} />
              )}
            </div>
          </dl>
        ) : !inst.requiresMigration ? (
          <dl className="server-figures">
            <div className="server-figure">
              <dt>{t('dashboard.row.maxMemory')}</dt>
              <dd>{xmxBytes != null ? formatGib(xmxBytes, fmt) : t('common.default')}</dd>
            </div>
            <div className="server-figure">
              <dt>{t('dashboard.row.java')}</dt>
              <dd>{inst.javaRuntimeId ? t('dashboard.row.java.dedicated') : t('dashboard.row.java.system')}</dd>
            </div>
          </dl>
        ) : null}
      </div>

      <div className="server-actions">
        {state.fix && Fix && (
          <Link to={state.fix.to} className={`btn btn-tinted${state.fix.quiet ? ' server-next-quiet' : ''}`}>
            <Fix size={14} aria-hidden="true" />
            {state.fix.label}
          </Link>
        )}
        {!inst.requiresMigration && !hasOrphan && canStartInstance(inst.status) && (
          <button className="btn btn-ok" type="button" disabled={busy} onClick={() => onAction('start')}>
            <Play size={14} aria-hidden="true" />
            {t('action.start')}
          </button>
        )}
        {!inst.requiresMigration && canStopInstance(inst.status) && (
          <button className="btn btn-danger" type="button" disabled={busy} onClick={() => onAction('stop')}>
            <Power size={14} aria-hidden="true" />
            {t('action.stop')}
          </button>
        )}
        <ActionMenu
          items={[
            {
              key: 'restart',
              label: t('dashboard.row.menu.restart'),
              icon: <RotateCcw size={14} />,
              disabled: busy || inst.requiresMigration || hasOrphan || isLifecycleBusy(inst.status),
              onSelect: onRestart,
            },
            {
              key: 'force-stop',
              label: t('action.forceStop'),
              icon: <Power size={14} />,
              // A detached process is stopped from its instance page, which offers the stop the platform and the
              // inspection allow; the row links there.
              disabled: busy || inst.requiresMigration || !isProcessAlive(inst.status),
              onSelect: onForceStop,
            },
            {
              key: 'delete',
              label: t('dashboard.row.menu.delete'),
              icon: <Trash2 size={14} />,
              danger: true,
              disabled: busy || (!inst.requiresMigration && (isProcessAlive(inst.status) || hasOrphan)),
              title: !inst.requiresMigration && (isProcessAlive(inst.status) || hasOrphan) ? t('dashboard.row.menu.deleteRunning') : undefined,
              onSelect: onDelete,
            },
          ]}
        />
        <ChevronRight size={18} aria-hidden="true" className="server-chevron" />
      </div>
    </li>
  );
}

export function DashboardPage() {
  const i18n = useI18n();
  const { t, tp, fmt } = i18n;
  const navigate = useNavigate();
  const { metrics, error: metricsError, busy: metricsBusy, refresh: refreshMetrics } = useDashboardMetrics();
  const [filter, setFilter] = useState<ListFilter>('all');
  const [instances, setInstances] = useState<InstanceInfo[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState('');
  const latestLoadRequestRef = useRef(0);
  const [restartTarget, setRestartTarget] = useState<InstanceInfo | null>(null);
  const [forceStopTarget, setForceStopTarget] = useState<InstanceInfo | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<InstanceInfo | null>(null);
  const [emptyOpen, setEmptyOpen] = useState(false);
  const [emptyName, setEmptyName] = useState(() => t('dashboard.createEmpty.defaultName'));
  const [emptyJvm, setEmptyJvm] = useState('-Xms1G -Xmx2G');
  // The EULA must be checked by the user; it is never accepted on the user's behalf in advance.
  const [emptyEula, setEmptyEula] = useState(false);
  const [emptyJavaRuntimeId, setEmptyJavaRuntimeId] = useState<string | null>(null);
  const [emptyJavaMajor, setEmptyJavaMajor] = useState<number | null>(null);
  const [emptyJvmValid, setEmptyJvmValid] = useState(true);
  const [emptyBusy, setEmptyBusy] = useState(false);
  const [emptyError, setEmptyError] = useState('');
  // When monitoring recovers from a failure, that sample time is recorded so screen readers announce "recovered" once; routine refreshes do not change it.
  const [metricsRecoveredAt, setMetricsRecoveredAt] = useState<string | null>(null);
  const previousMetricsErrorRef = useRef(metricsError);

  const load = useCallback(async () => {
    const requestId = ++latestLoadRequestRef.current;
    try {
      const result = await api<InstanceInfo[]>('/api/instances');
      if (requestId !== latestLoadRequestRef.current) return;
      setInstances(result);
      setLoadState('loaded');
      setLoadError('');
    } catch (err) {
      if (requestId !== latestLoadRequestRef.current) return;
      setLoadError(errorMessage(err));
      setLoadState((current) => (current === 'loaded' ? 'loaded' : 'error'));
    }
  }, []);
  usePolling(load);

  const { busyId, error: actionError, run } = useInstanceAction(load);

  function retryLoad(): void {
    setLoadError('');
    setLoadState('loading');
    void load();
  }

  function act(id: string, action: InstanceAction, options?: { force?: boolean }) {
    return run(id, () => controlInstance(id, action, options));
  }

  async function confirmRestart() {
    if (!restartTarget) return;
    const target = restartTarget;
    setRestartTarget(null);
    await act(target.id, 'restart');
  }

  async function confirmForceStop() {
    if (!forceStopTarget) return;
    const target = forceStopTarget;
    setForceStopTarget(null);
    await act(target.id, 'stop', { force: true });
  }

  const emptyNameIssue = instanceNameIssue(emptyName);

  async function confirmCreateEmpty() {
    if (emptyNameIssue) return;
    setEmptyBusy(true);
    setEmptyError('');
    try {
      const inst = await api<InstanceInfo>('/api/instances', {
        method: 'POST',
        json: {
          name: emptyName,
          coreType: 'custom',
          jvmArgs: emptyJvm,
          acceptEula: emptyEula,
          javaRuntimeId: emptyJavaRuntimeId,
        },
      });
      setEmptyOpen(false);
      navigate(`/instances/${inst.id}/files`);
    } catch (err) {
      // While the dialog is still open the rest of the page is inert, so the error must be shown inside the dialog to be seen and announced.
      setEmptyError(errorMessage(err));
    } finally {
      setEmptyBusy(false);
    }
  }

  const runningCount = instances.filter(isServerRunning).length;
  const issueCount = instances.filter(hasIssue).length;
  const loaded = loadState === 'loaded';
  // Instances that need attention come first; the sort is stable, so the server's order holds within each group.
  const visibleInstances = instances
    .filter((inst) => filter === 'all' || (filter === 'running' ? isServerRunning(inst) : hasIssue(inst)))
    .sort((a, b) => Number(hasIssue(b)) - Number(hasIssue(a)));
  const filters: Array<{ key: ListFilter; label: string; count: number }> = [
    { key: 'all', label: t('dashboard.filter.all'), count: instances.length },
    { key: 'running', label: t('instance.status.running'), count: runningCount },
    { key: 'issues', label: t('dashboard.filter.issues'), count: issueCount },
  ];

  useEffect(() => {
    if (metricsError) setMetricsRecoveredAt(null);
    else if (previousMetricsErrorRef.current && metrics) setMetricsRecoveredAt(metrics.sampledAt);
    previousMetricsErrorRef.current = metricsError;
  }, [metricsError, metrics]);

  const metricsWarningText = metrics && !metricsError && metrics.warnings.length > 0
    ? metricWarningTexts(metrics, i18n.tm).join(' · ')
    : '';
  const metricsErrorText = metricsError
    ? (metrics ? t('dashboard.metrics.errorStale', { error: metricsError }) : metricsError)
    : '';
  // Routine samples every 5 seconds stay out of the live region; screen readers announce only errors, warning changes and recovery from an error.
  const metricsAnnouncement = metricsError
    ? metricsErrorText
    : [
      metricsRecoveredAt ? t('dashboard.metrics.updatedAt', { time: fmt.time(metricsRecoveredAt) }) : '',
      metricsWarningText,
    ].filter(Boolean).join(' · ');

  return (
    <div className="page overview-page">
      <PageHeader
        title={t('nav.instances')}
        // With instances, the description line is the current status: large text says how many are running, followed by a red sentence when something needs attention, replacing separate stat cards.
        subtitle={
          loaded && instances.length > 0 ? (
            <span className="overview-status">
              {tp('dashboard.subtitle.summary', instances.length, { running: runningCount })}
              {issueCount > 0 && (
                <span className="overview-status-issues">{tp('dashboard.subtitle.issues', issueCount)}</span>
              )}
            </span>
          ) : undefined
        }
        // With no instances yet, the three ways to add one in the list area are the entry, so the top does not repeat a set of buttons; nothing is drawn while loading either, so buttons do not flash on an empty panel and vanish.
        actions={loadState === 'loading' || (loaded && instances.length === 0) ? undefined : (
          <>
            {/* On phones these two entries are provided by the bottom tab bar, and are hidden on narrow screens (overview-nav-action). */}
            <Link to="/deploy" className="btn btn-primary overview-nav-action">
              <Plus size={16} aria-hidden="true" />
              {t('nav.deploy')}
            </Link>
            <Link to="/import" className="btn overview-nav-action">
              <FolderDown size={16} aria-hidden="true" />
              {t('nav.import')}
            </Link>
            <button type="button" className="btn btn-plain" onClick={() => setEmptyOpen(true)}>
              {t('dashboard.action.createEmpty')}
            </button>
          </>
        )}
      />

      <span className="visually-hidden" role="status">{metricsAnnouncement}</span>

      {actionError &&<p className="callout callout-danger" role="alert">{actionError}</p>}
      {loadError && (
        <p className="callout callout-danger" role="alert">
          {loadError}
          {loaded ? ` ${t('dashboard.load.staleNotice')}` : ''}
        </p>
      )}

      <section className="page-section server-section" aria-labelledby="instance-list-title">
        {/* The page title and the status sentence already introduce the list; the heading stays for screen readers only. */}
        <h2 className="visually-hidden" id="instance-list-title">{t('dashboard.list.title')}</h2>
        {loaded && instances.length > 0 && (
          <div className="section-header">
            <div className="segmented server-filter" role="group" aria-label={t('dashboard.filter.label')}>
              {filters.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`segmented-item${filter === item.key ? ' active' : ''}`}
                  aria-pressed={filter === item.key}
                  onClick={() => setFilter(item.key)}
                >
                  {item.label}{' '}
                  <span className={`segmented-count${item.key === 'issues' && item.count > 0 ? ' is-danger' : ''}`}>
                    {item.count}
                  </span>
                </button>
              ))}
            </div>
            {/* Host usage lives on the home page; here it only surfaces when something is wrong. Row CPU and memory come from the same samples, so a failure and its retry stay on this page. */}
            {metricsError ? (
              <p className="overview-metrics-line is-error">
                <span>{metricsErrorText}</span>
                <button type="button" className="link-button" disabled={metricsBusy} onClick={() => void refreshMetrics(true)}>
                  {metricsBusy ? t('dashboard.metrics.refreshing') : t('dashboard.metrics.retry')}
                </button>
              </p>
            ) : metricsWarningText ? (
              <p className="overview-metrics-line is-warning">
                <TriangleAlert size={14} aria-hidden="true" />
                <span>{metricsWarningText}</span>
                <Link to="/" className="link">{t('dashboard.metrics.viewUsage')}</Link>
              </p>
            ) : null}
          </div>
        )}

        {loadState === 'loading' ? (
          <div className="page-loading" role="status">
            <span className="spinner" aria-hidden="true" />
            {t('dashboard.list.loading')}
          </div>
        ) : loadState === 'error' ? (
          <div className="empty-state card" role="alert">
            <p>{t('error.instances.load')}</p>
            <button className="btn" type="button" onClick={retryLoad}>
              {t('action.reload')}
            </button>
          </div>
        ) : instances.length === 0 ? (
          <StartPaths onCreateEmpty={() => setEmptyOpen(true)} />
        ) : visibleInstances.length === 0 ? (
          <p className="server-list-empty">
            {filter === 'running' ? t('dashboard.list.noRunning') : t('dashboard.list.noIssues')}
          </p>
        ) : (
          <ul className="server-list">
            {visibleInstances.map((inst) => (
              <ServerRow
                key={inst.id}
                inst={inst}
                metrics={metrics}
                metricsError={metricsError}
                busy={busyId === inst.id}
                onAction={(action) => void act(inst.id, action)}
                onRestart={() => setRestartTarget(inst)}
                onForceStop={() => setForceStopTarget(inst)}
                onDelete={() => setDeleteTarget(inst)}
              />
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={emptyOpen}
        title={t('dashboard.action.createEmpty')}
        description={
          <>
            <p>{t('dashboard.createEmpty.body')}</p>
            <div className="field">
              <label htmlFor="empty-instance-name">{t('dashboard.createEmpty.name')}</label>
              <input
                id="empty-instance-name"
                value={emptyName}
                disabled={emptyBusy}
                aria-invalid={emptyNameIssue ? true : undefined}
                aria-describedby={emptyNameIssue ? 'empty-instance-name-error' : undefined}
                onChange={(e) => setEmptyName(e.target.value)}
              />
              {emptyNameIssue && <p className="error" id="empty-instance-name-error">{t(emptyNameIssue.key, emptyNameIssue.params)}</p>}
            </div>
            <JavaRuntimeSelect
              value={emptyJavaRuntimeId}
              onChange={setEmptyJavaRuntimeId}
              mcVersion={null}
              disabled={emptyBusy}
              onResolvedMajorChange={setEmptyJavaMajor}
            />
            <JvmSettingsEditor
              value={emptyJvm}
              onChange={setEmptyJvm}
              coreType="custom"
              javaMajor={emptyJavaMajor}
              disabled={emptyBusy}
              useRecommendedDefault
              onValidityChange={setEmptyJvmValid}
            />
            <EulaCheckbox checked={emptyEula} disabled={emptyBusy} onChange={setEmptyEula} />
          </>
        }
        confirmLabel={t('dashboard.createEmpty.confirm')}
        busy={emptyBusy}
        error={emptyError}
        confirmDisabled={!emptyJvmValid || emptyNameIssue !== null}
        onConfirm={() => void confirmCreateEmpty()}
        onCancel={() => {
          setEmptyOpen(false);
          setEmptyError('');
        }}
      />

      <ConfirmDialog
        open={restartTarget !== null}
        title={t('dashboard.restart.title', { name: restartTarget?.name ?? '' })}
        description={t('dashboard.restart.body')}
        confirmLabel={t('dashboard.restart.confirm')}
        busy={busyId === restartTarget?.id}
        onConfirm={() => void confirmRestart()}
        onCancel={() => setRestartTarget(null)}
      />

      <ConfirmDialog
        open={forceStopTarget !== null}
        title={t('dashboard.forceStop.title', { name: forceStopTarget?.name ?? '' })}
        description={t('dashboard.forceStop.body')}
        confirmLabel={t('dashboard.forceStop.confirm')}
        danger
        busy={busyId === forceStopTarget?.id}
        onConfirm={() => void confirmForceStop()}
        onCancel={() => setForceStopTarget(null)}
      />

      {/* Delete confirmation: the request is sent from the dialog, and on success it closes and the list refreshes. */}
      <DeleteInstanceDialog
        instance={deleteTarget}
        onDeleted={() => {
          setDeleteTarget(null);
          void load();
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
