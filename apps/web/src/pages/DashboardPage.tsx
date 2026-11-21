import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ChevronRight,
  FolderDown,
  PackageOpen,
  Play,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  Settings,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  Users,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { DashboardMetrics, InstanceInfo } from '@mystry/shared';
import { api, controlInstance, type InstanceAction } from '../api';
import {
  HostMeters,
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
import { InstanceStatusPill } from '../components/StatusPill';
import { errorMessage } from '../errors';
import { useInstanceAction } from '../hooks/useInstanceAction';
import { usePolling } from '../hooks/usePolling';
import { useI18n, type I18n, type MessageKey } from '../i18n';
import { instanceNameIssue } from '../validation';
import {
  canStartInstance,
  canStopInstance,
  isLifecycleBusy,
  isProcessAlive,
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

/** Instances that need the user's attention: crashed, pending migration, last start failed for a recognizable reason, or the chosen Java is no longer available. */
function hasIssue(inst: InstanceInfo): boolean {
  return inst.requiresMigration || inst.status === 'crashed' || (canStartInstance(inst.status) && !!inst.startIssue);
}

type RowState = {
  sentence: string | null;
  tone: 'ok' | 'warn' | 'danger' | null;
  fix: { to: string; label: string; icon: LucideIcon } | null;
};

/** The sentence after the status, and the one step most worth taking for this row. */
function rowState(inst: InstanceInfo, t: I18n['t']): RowState {
  const page = `/instances/${inst.id}`;
  if (inst.requiresMigration) {
    return {
      sentence: t('dashboard.row.migration'),
      tone: 'warn',
      fix: { to: page, label: t('dashboard.row.action.migrate'), icon: PackageOpen },
    };
  }
  const issue = canStartInstance(inst.status) ? inst.startIssue ?? null : null;
  if (issue?.kind === 'eula') {
    return {
      sentence: t('dashboard.row.eula'),
      tone: 'warn',
      fix: { to: page, label: t('dashboard.row.action.reviewEula'), icon: TriangleAlert },
    };
  }
  if (issue?.kind === 'java-unavailable') {
    return {
      sentence: t('instance.startIssue.javaUnavailable.title'),
      tone: 'warn',
      fix: { to: `${page}/settings`, label: t('instance.startIssue.java.openSettings'), icon: Settings },
    };
  }
  if (issue) {
    return {
      sentence: issue.requiredJava != null
        ? t('instance.startIssue.java.title', { java: issue.requiredJava })
        : t('instance.startIssue.java.titleUnknown'),
      tone: 'warn',
      fix: { to: `${page}/settings`, label: t('instance.startIssue.java.openSettings'), icon: Settings },
    };
  }
  switch (inst.status) {
    case 'crashed':
      return {
        sentence: t('dashboard.row.crashed'),
        tone: 'danger',
        fix: { to: page, label: t('dashboard.row.action.console'), icon: SquareTerminal },
      };
    case 'starting':
      return { sentence: t('dashboard.row.loading'), tone: null, fix: null };
    case 'running':
      return inst.ready
        ? {
          sentence: t('dashboard.row.ready'),
          tone: 'ok',
          fix: { to: `/multiplayer?instance=${encodeURIComponent(inst.id)}`, label: t('instance.ready.action'), icon: Users },
        }
        : { sentence: t('dashboard.row.loading'), tone: null, fix: null };
    case 'stopping':
      return { sentence: t('dashboard.row.stopping'), tone: null, fix: null };
    default:
      return { sentence: null, tone: null, fix: null };
  }
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
                <Meter ratio={memoryBytes != null ? (memoryBytes / xmxBytes) * 100 : null} tone="accent" />
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
          <Link to={state.fix.to} className="btn btn-tinted">
            <Fix size={14} aria-hidden="true" />
            {state.fix.label}
          </Link>
        )}
        {!inst.requiresMigration && canStartInstance(inst.status) && (
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
              disabled: busy || inst.requiresMigration || isLifecycleBusy(inst.status),
              onSelect: onRestart,
            },
            {
              key: 'force-stop',
              label: t('action.forceStop'),
              icon: <Power size={14} />,
              disabled: busy || inst.requiresMigration || !isProcessAlive(inst.status),
              onSelect: onForceStop,
            },
            {
              key: 'delete',
              label: t('dashboard.row.menu.delete'),
              icon: <Trash2 size={14} />,
              danger: true,
              disabled: busy || (!inst.requiresMigration && isProcessAlive(inst.status)),
              title: !inst.requiresMigration && isProcessAlive(inst.status) ? t('dashboard.row.menu.deleteRunning') : undefined,
              onSelect: onDelete,
            },
          ]}
        />
        <ChevronRight size={18} aria-hidden="true" className="server-chevron" />
      </div>
    </li>
  );
}

/** When there are no instances yet: one row for each of the three ways to add one, explaining which situation each suits. */
function StartPaths({ onCreateEmpty }: { onCreateEmpty: () => void }) {
  const { t } = useI18n();
  const paths: Array<{ key: string; icon: LucideIcon; title: MessageKey; desc: MessageKey; to?: string }> = [
    { key: 'deploy', icon: Plus, title: 'nav.deploy', desc: 'dashboard.empty.deploy.desc', to: '/deploy' },
    { key: 'import', icon: FolderDown, title: 'nav.import', desc: 'dashboard.empty.import.desc', to: '/import' },
    { key: 'empty', icon: Zap, title: 'dashboard.action.createEmpty', desc: 'dashboard.empty.createEmpty.desc' },
  ];
  return (
    <div className="start-paths card">
      <div className="start-paths-head">
        <h3>{t('empty.instances.title')}</h3>
        <p>{t('dashboard.empty.lead')}</p>
      </div>
      <ul className="start-path-list">
        {paths.map((path) => {
          const Icon = path.icon;
          const body = (
            <>
              <span className="start-path-icon" aria-hidden="true"><Icon size={18} /></span>
              <span className="start-path-text">
                <span className="start-path-title">{t(path.title)}</span>
                <span className="start-path-desc">{t(path.desc)}</span>
              </span>
              <ChevronRight size={16} aria-hidden="true" className="start-path-chevron" />
            </>
          );
          return (
            <li key={path.key}>
              {path.to ? (
                <Link to={path.to} className="start-path">{body}</Link>
              ) : (
                <button type="button" className="start-path" onClick={onCreateEmpty}>{body}</button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
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

  const runningCount = instances.filter((i) => i.status === 'running').length;
  const issueCount = instances.filter(hasIssue).length;
  const loaded = loadState === 'loaded';
  const visibleInstances = instances.filter((inst) =>
    filter === 'all' || (filter === 'running' ? inst.status === 'running' : hasIssue(inst)));
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
  const metricsStatusText = metricsError
    ? (metrics ? t('dashboard.metrics.errorStale', { error: metricsError }) : metricsError)
    : metrics
      ? t('dashboard.metrics.updatedAt', { time: fmt.time(metrics.sampledAt) })
      : t('dashboard.metrics.loading');
  // The "updated at" timestamp that changes every 5 seconds stays out of the live region; screen readers announce only errors, warning changes and recovery from an error.
  const metricsAnnouncement = metricsError
    ? metricsStatusText
    : [
      metricsRecoveredAt ? t('dashboard.metrics.updatedAt', { time: fmt.time(metricsRecoveredAt) }) : '',
      metricsWarningText,
    ].filter(Boolean).join(' · ');

  return (
    <div className="page overview-page">
      <PageHeader
        title={t('nav.overview')}
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

      <section className="host-strip" aria-labelledby="host-strip-title">
        <h2 className="host-strip-title" id="host-strip-title">{t('dashboard.host.title')}</h2>
        <HostMeters metrics={metrics} error={metricsError} />
        <div className={`metrics-status${metricsError ? ' is-error' : ''}`}>
          <span>{metricsStatusText}</span>
          <span className="visually-hidden" role="status">{metricsAnnouncement}</span>
          <button type="button" className="link-button" disabled={metricsBusy} onClick={() => void refreshMetrics(true)}>
            <RefreshCw size={12} aria-hidden="true" className={metricsBusy ? 'spin' : undefined} />
            {metricsBusy
              ? t('dashboard.metrics.refreshing')
              : metricsError
                ? t('dashboard.metrics.retry')
                : t('action.refresh')}
          </button>
        </div>
        {/* Warnings get a row of their own: squeezing them into the status column on the right would truncate the three usage bars. */}
        {metricsWarningText && (
          <p className="host-strip-warning">
            <TriangleAlert size={14} aria-hidden="true" />
            {metricsWarningText}
          </p>
        )}
      </section>

      {actionError &&<p className="callout callout-danger" role="alert">{actionError}</p>}
      {loadError && (
        <p className="callout callout-danger" role="alert">
          {loadError}
          {loaded ? ` ${t('dashboard.load.staleNotice')}` : ''}
        </p>
      )}

      <section className="page-section server-section" aria-labelledby="instance-list-title">
        <div className="section-header">
          <h2 className="section-title" id="instance-list-title">{t('dashboard.list.title')}</h2>
          {loaded && instances.length > 0 && (
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
          )}
        </div>

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

      {/* Create empty instance dialog */}
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

      {/* Restart confirmation */}
      <ConfirmDialog
        open={restartTarget !== null}
        title={t('dashboard.restart.title', { name: restartTarget?.name ?? '' })}
        description={t('dashboard.restart.body')}
        confirmLabel={t('dashboard.restart.confirm')}
        busy={busyId === restartTarget?.id}
        onConfirm={() => void confirmRestart()}
        onCancel={() => setRestartTarget(null)}
      />

      {/* Force stop confirmation */}
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
