import { useCallback, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Activity,
  ChevronRight,
  FolderDown,
  Layers,
  Play,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  Trash2,
  Zap,
} from 'lucide-react';
import type { InstanceInfo } from '@mystry/shared';
import { api, controlInstance, instanceApi, type InstanceAction } from '../api';
import {
  HostMetricCards,
  MetricWidget,
  metricWarningText,
  processMetric,
  useDashboardMetrics,
} from '../components/DashboardMetrics';
import { ActionMenu } from '../components/ActionMenu';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { CoreIcon } from '../components/CoreIcon';
import { EulaCheckbox } from '../components/EulaCheckbox';
import { JavaRuntimeSelect } from '../components/JavaRuntimeSelect';
import { JvmSettingsEditor } from '../components/JvmSettingsEditor';
import { PageHeader } from '../components/PageHeader';
import { InstanceStatusPill } from '../components/StatusPill';
import { errorMessage } from '../errors';
import { useInstanceAction } from '../hooks/useInstanceAction';
import { usePolling } from '../hooks/usePolling';
import { useI18n } from '../i18n';
import {
  canStartInstance,
  canStopInstance,
  isLifecycleBusy,
  isProcessAlive,
} from '../instance-status';

type LoadState = 'loading' | 'loaded' | 'error';

/** 未设置 -Xmx 时返回 null，由调用方显示「默认」。 */
function extractXmx(jvmArgs: string): string | null {
  const match = jvmArgs.match(/-Xmx(\w+)/i);
  return match ? match[1].toUpperCase() : null;
}

export function DashboardPage() {
  const i18n = useI18n();
  const { t, tp, fmt } = i18n;
  const navigate = useNavigate();
  const { metrics, error: metricsError, busy: metricsBusy, refresh: refreshMetrics } = useDashboardMetrics();
  const [abnormalOnly, setAbnormalOnly] = useState(false);
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
  // EULA 必须由用户主动勾选同意，不预先替用户同意。
  const [emptyEula, setEmptyEula] = useState(false);
  const [emptyJavaRuntimeId, setEmptyJavaRuntimeId] = useState<string | null>(null);
  const [emptyJavaMajor, setEmptyJavaMajor] = useState<number | null>(null);
  const [emptyJvmValid, setEmptyJvmValid] = useState(true);
  const [emptyBusy, setEmptyBusy] = useState(false);

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

  const { busyId, error: actionError, setError: setActionError, run } = useInstanceAction(load);

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

  async function confirmDelete() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    await run(target.id, () => api(instanceApi(target.id), { method: 'DELETE' }));
  }

  async function confirmCreateEmpty() {
    setEmptyBusy(true);
    setActionError('');
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
      setActionError(errorMessage(err));
    } finally {
      setEmptyBusy(false);
    }
  }

  const runningCount = instances.filter((i) => i.status === 'running').length;
  const stoppedCount = instances.filter((i) => i.status === 'stopped').length;
  const abnormalCount = instances.filter((i) => i.status === 'crashed' || i.requiresMigration).length;
  const runningRatio = instances.length > 0 ? (runningCount / instances.length) * 100 : 0;
  const loaded = loadState === 'loaded';
  const visibleInstances = instances.filter((inst) => !abnormalOnly || inst.status === 'crashed' || inst.requiresMigration);

  const metricsStatusText = metricsError
    ? (metrics ? t('dashboard.metrics.errorStale', { error: metricsError }) : metricsError)
    : metrics
      ? t('dashboard.metrics.updatedAt', { time: fmt.time(metrics.sampledAt) })
      : t('dashboard.metrics.loading');
  const abnormalLabel = loaded ? abnormalCount : '—';

  return (
    <div className="page">
      <PageHeader
        title={t('nav.overview')}
        subtitle={
          loaded
            ? tp('dashboard.subtitle.summary', instances.length, { running: runningCount })
            : t('dashboard.subtitle.default')
        }
        actions={
          <>
            <Link to="/deploy" className="btn btn-primary">
              <Plus size={16} aria-hidden="true" />
              {t('nav.deploy')}
            </Link>
            <Link to="/import" className="btn">
              <FolderDown size={16} aria-hidden="true" />
              {t('nav.import')}
            </Link>
            <button type="button" className="btn" onClick={() => setEmptyOpen(true)}>
              <Zap size={16} aria-hidden="true" />
              {t('dashboard.action.createEmpty')}
            </button>
          </>
        }
      />

      <section className="widget-grid" aria-label={t('dashboard.widgets.label')}>
        <MetricWidget
          label={t('dashboard.widget.instances.label')}
          icon={Activity}
          tone="green"
          value={loaded ? `${runningCount} / ${instances.length}` : '—'}
          unit={t('instance.status.running')}
          ratio={runningRatio}
          detail={
            <>
              {t('dashboard.widget.instances.stopped', { count: loaded ? stoppedCount : '—' })} ·{' '}
              <button
                type="button"
                className={`link-button${abnormalCount > 0 ? ' is-danger' : ''}`}
                aria-pressed={abnormalOnly}
                onClick={() => setAbnormalOnly((value) => !value)}
              >
                {abnormalOnly
                  ? t('dashboard.widget.instances.abnormalShowAll', { count: abnormalLabel })
                  : t('dashboard.widget.instances.abnormal', { count: abnormalLabel })}
              </button>
            </>
          }
        />
        <HostMetricCards metrics={metrics} error={metricsError} />
      </section>
      <div className={`metrics-status${metricsError ? ' is-error' : ''}`}>
        <span role="status">
          {metricsStatusText}
          {metrics && !metricsError && metrics.warnings.length > 0
            ? ` · ${metrics.warnings.map((warning) => metricWarningText(warning, t)).join(' · ')}`
            : ''}
        </span>
        <button type="button" className="link-button" disabled={metricsBusy} onClick={() => void refreshMetrics()}>
          <RefreshCw size={12} aria-hidden="true" className={metricsBusy ? 'spin' : undefined} />
          {metricsBusy
            ? t('dashboard.metrics.refreshing')
            : metricsError
              ? t('dashboard.metrics.retry')
              : t('action.refresh')}
        </button>
      </div>

      {actionError && <p className="callout callout-danger" role="alert">{actionError}</p>}
      {loadError && (
        <p className="callout callout-danger" role="alert">
          {loadError}
          {loaded ? ` ${t('dashboard.load.staleNotice')}` : ''}
        </p>
      )}

      <section className="page-section" aria-labelledby="instance-list-title">
        <div className="section-header">
          <h2 className="section-title" id="instance-list-title">
            {t('dashboard.list.title')}
            <span className="count-badge">{instances.length}</span>
          </h2>
          {abnormalOnly && <span className="section-note">{t('dashboard.list.abnormalOnly')}</span>}
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
          <div className="empty-state card">
            <span className="empty-icon" aria-hidden="true"><Layers size={30} /></span>
            <h3>{t('empty.instances.title')}</h3>
            <p>{t('empty.instances.body')}</p>
            <div className="empty-actions">
              <Link to="/deploy" className="btn btn-primary">
                <Plus size={16} aria-hidden="true" />
                {t('dashboard.empty.deployFirst')}
              </Link>
              <Link to="/import" className="btn">
                <FolderDown size={16} aria-hidden="true" />
                {t('dashboard.empty.importExisting')}
              </Link>
            </div>
          </div>
        ) : (
          <div className="instance-grid">
            {abnormalOnly && abnormalCount === 0 && <p className="muted">{t('dashboard.list.noAbnormal')}</p>}
            {visibleInstances.map((inst) => (
              <article key={inst.id} className={`instance-card status-${inst.requiresMigration ? 'warning' : inst.status}`}>
                <div className="inst-card-top">
                  <CoreIcon coreType={inst.coreType} />
                  <div className="inst-name-group">
                    <Link to={`/instances/${inst.id}`} className="inst-name" title={inst.name}>
                      {inst.name}
                    </Link>
                    <div className="inst-core-badge">
                      {inst.coreType.toUpperCase()} {inst.mcVersion ? `· ${inst.mcVersion}` : ''}
                    </div>
                  </div>
                  <InstanceStatusPill instance={inst} />
                </div>

                <dl className="inst-stats">
                  <div className="inst-stat">
                    <dt title={t('dashboard.card.processCpu.hint')}>{t('dashboard.card.processCpu')}</dt>
                    <dd>{processMetric(inst, metrics, metricsError, 'cpu', i18n)}</dd>
                  </div>
                  <div className="inst-stat">
                    <dt title={t('dashboard.card.processMemory.hint')}>{t('dashboard.card.processMemory')}</dt>
                    <dd>{processMetric(inst, metrics, metricsError, 'memory', i18n)}</dd>
                  </div>
                  <div className="inst-stat">
                    <dt>{t('dashboard.card.maxMemory')}</dt>
                    <dd>{extractXmx(inst.jvmArgs) ?? t('common.default')}</dd>
                  </div>
                  <div className="inst-stat">
                    <dt>{t('dashboard.card.javaRuntime')}</dt>
                    <dd>
                      {inst.javaRuntimeId
                        ? t('dashboard.card.javaRuntime.dedicated')
                        : t('dashboard.card.javaRuntime.system')}
                    </dd>
                  </div>
                </dl>

                <div className="inst-card-actions">
                  {canStartInstance(inst.status) && (
                    <button
                      className="btn btn-ok"
                      type="button"
                      disabled={busyId === inst.id || inst.requiresMigration}
                      onClick={() => void act(inst.id, 'start')}
                    >
                      <Play size={14} aria-hidden="true" />
                      {t('action.start')}
                    </button>
                  )}
                  {canStopInstance(inst.status) && (
                    <button
                      className="btn btn-danger"
                      type="button"
                      disabled={busyId === inst.id || inst.requiresMigration}
                      onClick={() => void act(inst.id, 'stop')}
                    >
                      <Power size={14} aria-hidden="true" />
                      {t('action.stop')}
                    </button>
                  )}
                  <Link to={`/instances/${inst.id}`} className="btn btn-tinted inst-manage">
                    {t('dashboard.card.manage')}
                    <ChevronRight size={15} aria-hidden="true" />
                  </Link>

                  <ActionMenu
                    items={[
                      {
                        key: 'restart',
                        label: t('dashboard.card.menu.restart'),
                        icon: <RotateCcw size={14} />,
                        disabled: busyId === inst.id || inst.requiresMigration || isLifecycleBusy(inst.status),
                        onSelect: () => setRestartTarget(inst),
                      },
                      {
                        key: 'force-stop',
                        label: t('action.forceStop'),
                        icon: <Power size={14} />,
                        disabled: busyId === inst.id || inst.requiresMigration || !isProcessAlive(inst.status),
                        onSelect: () => setForceStopTarget(inst),
                      },
                      {
                        key: 'delete',
                        label: t('dashboard.card.menu.delete'),
                        icon: <Trash2 size={14} />,
                        danger: true,
                        disabled: busyId === inst.id || (!inst.requiresMigration && isProcessAlive(inst.status)),
                        title:
                          !inst.requiresMigration && isProcessAlive(inst.status)
                            ? t('dashboard.card.menu.deleteRunning')
                            : undefined,
                        onSelect: () => setDeleteTarget(inst),
                      },
                    ]}
                  />
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* 创建空实例弹窗 */}
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
                onChange={(e) => setEmptyName(e.target.value)}
              />
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
        confirmDisabled={!emptyJvmValid}
        onConfirm={() => void confirmCreateEmpty()}
        onCancel={() => setEmptyOpen(false)}
      />

      {/* 重启确认 */}
      <ConfirmDialog
        open={restartTarget !== null}
        title={t('dashboard.restart.title', { name: restartTarget?.name ?? '' })}
        description={t('dashboard.restart.body')}
        confirmLabel={t('dashboard.restart.confirm')}
        busy={busyId === restartTarget?.id}
        onConfirm={() => void confirmRestart()}
        onCancel={() => setRestartTarget(null)}
      />

      {/* 强制停止确认 */}
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

      {/* 删除确认 */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title={
          deleteTarget?.requiresMigration
            ? t('dashboard.removeRecord.title', { name: deleteTarget?.name ?? '' })
            : t('dashboard.delete.title', { name: deleteTarget?.name ?? '' })
        }
        description={
          deleteTarget?.requiresMigration
            ? t('dashboard.removeRecord.body')
            : t('dashboard.delete.body')
        }
        confirmLabel={deleteTarget?.requiresMigration ? t('dashboard.removeRecord.confirm') : t('action.deletePermanently')}
        danger
        busy={busyId === deleteTarget?.id}
        requireText={deleteTarget?.requiresMigration ? undefined : deleteTarget?.name}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
