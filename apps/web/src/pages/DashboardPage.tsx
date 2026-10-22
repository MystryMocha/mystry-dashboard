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
import { HostMetricCards, MetricWidget, processMetric, useDashboardMetrics } from '../components/DashboardMetrics';
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
import {
  canStartInstance,
  canStopInstance,
  isLifecycleBusy,
  isProcessAlive,
} from '../instance-status';

type LoadState = 'loading' | 'loaded' | 'error';

function extractXmx(jvmArgs: string): string {
  const match = jvmArgs.match(/-Xmx(\w+)/i);
  return match ? match[1].toUpperCase() : '默认';
}

export function DashboardPage() {
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
  const [emptyName, setEmptyName] = useState('自定义 Jar 实例');
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
    ? `${metricsError}${metrics ? '，数据可能过期' : ''}`
    : metrics
      ? `更新于 ${new Date(metrics.sampledAt).toLocaleTimeString()}`
      : '正在读取监测数据…';

  return (
    <div className="page">
      <PageHeader
        title="实例总览"
        subtitle={loaded ? `共 ${instances.length} 个实例，${runningCount} 个正在运行` : '本机 Minecraft Java 服务端'}
        actions={
          <>
            <Link to="/deploy" className="btn btn-primary">
              <Plus size={16} aria-hidden="true" />
              一键部署
            </Link>
            <Link to="/import" className="btn">
              <FolderDown size={16} aria-hidden="true" />
              导入服务端
            </Link>
            <button type="button" className="btn" onClick={() => setEmptyOpen(true)}>
              <Zap size={16} aria-hidden="true" />
              创建空实例
            </button>
          </>
        }
      />

      <section className="widget-grid" aria-label="运行概况">
        <MetricWidget
          label="实例状态"
          icon={Activity}
          tone="green"
          value={loaded ? `${runningCount} / ${instances.length}` : '—'}
          unit="运行中"
          ratio={runningRatio}
          detail={
            <>
              已停止 {loaded ? stoppedCount : '—'} ·{' '}
              <button
                type="button"
                className={`link-button${abnormalCount > 0 ? ' is-danger' : ''}`}
                aria-pressed={abnormalOnly}
                onClick={() => setAbnormalOnly((value) => !value)}
              >
                异常 {loaded ? abnormalCount : '—'}{abnormalOnly ? ' · 显示全部' : ''}
              </button>
            </>
          }
        />
        <HostMetricCards metrics={metrics} error={metricsError} />
      </section>
      <div className={`metrics-status${metricsError ? ' is-error' : ''}`}>
        <span role="status">
          {metricsStatusText}
          {metrics && !metricsError && metrics.warnings.length > 0 ? ` · ${metrics.warnings.join(' · ')}` : ''}
        </span>
        <button type="button" className="link-button" disabled={metricsBusy} onClick={() => void refreshMetrics()}>
          <RefreshCw size={12} aria-hidden="true" className={metricsBusy ? 'spin' : undefined} />
          {metricsBusy ? '刷新中…' : metricsError ? '重试监测' : '刷新'}
        </button>
      </div>

      {actionError && <p className="callout callout-danger" role="alert">{actionError}</p>}
      {loadError && (
        <p className="callout callout-danger" role="alert">
          {loadError}
          {loaded ? ' 当前正在显示上次成功加载的实例数据。' : ''}
        </p>
      )}

      <section className="page-section" aria-labelledby="instance-list-title">
        <div className="section-header">
          <h2 className="section-title" id="instance-list-title">
            Minecraft 实例
            <span className="count-badge">{instances.length}</span>
          </h2>
          {abnormalOnly && <span className="section-note">仅显示异常实例</span>}
        </div>

        {loadState === 'loading' ? (
          <div className="page-loading" role="status">
            <span className="spinner" aria-hidden="true" />
            正在加载实例列表…
          </div>
        ) : loadState === 'error' ? (
          <div className="empty-state card" role="alert">
            <p>实例列表暂时不可用，请检查面板连接后重试。</p>
            <button className="btn" type="button" onClick={retryLoad}>
              重新加载
            </button>
          </div>
        ) : instances.length === 0 ? (
          <div className="empty-state card">
            <span className="empty-icon" aria-hidden="true"><Layers size={30} /></span>
            <h3>暂无 Minecraft 实例</h3>
            <p>你可以从「一键部署」下载官方核心，或从同机目录及 ZIP 包导入已有服务端。</p>
            <div className="empty-actions">
              <Link to="/deploy" className="btn btn-primary">
                <Plus size={16} aria-hidden="true" />
                部署第一个服务端
              </Link>
              <Link to="/import" className="btn">
                <FolderDown size={16} aria-hidden="true" />
                导入已有服务端
              </Link>
            </div>
          </div>
        ) : (
          <div className="instance-grid">
            {abnormalOnly && abnormalCount === 0 && <p className="muted">暂无异常实例。</p>}
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
                    <dt title="按整机逻辑核总容量计算">进程 CPU</dt>
                    <dd>{processMetric(inst, metrics, metricsError, 'cpu')}</dd>
                  </div>
                  <div className="inst-stat">
                    <dt title="服务器进程实际占用的内存，通常略高于设置的最大内存">进程内存</dt>
                    <dd>{processMetric(inst, metrics, metricsError, 'memory')}</dd>
                  </div>
                  <div className="inst-stat">
                    <dt>最大内存</dt>
                    <dd>{extractXmx(inst.jvmArgs)}</dd>
                  </div>
                  <div className="inst-stat">
                    <dt>Java 运行时</dt>
                    <dd>{inst.javaRuntimeId ? '专属环境' : '系统默认'}</dd>
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
                      启动
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
                      停止
                    </button>
                  )}
                  <Link to={`/instances/${inst.id}`} className="btn btn-tinted inst-manage">
                    进入管理
                    <ChevronRight size={15} aria-hidden="true" />
                  </Link>

                  <ActionMenu
                    items={[
                      {
                        key: 'restart',
                        label: '重启实例',
                        icon: <RotateCcw size={14} />,
                        disabled: busyId === inst.id || inst.requiresMigration || isLifecycleBusy(inst.status),
                        onSelect: () => setRestartTarget(inst),
                      },
                      {
                        key: 'force-stop',
                        label: '强制停止',
                        icon: <Power size={14} />,
                        disabled: busyId === inst.id || inst.requiresMigration || !isProcessAlive(inst.status),
                        onSelect: () => setForceStopTarget(inst),
                      },
                      {
                        key: 'delete',
                        label: '删除实例',
                        icon: <Trash2 size={14} />,
                        danger: true,
                        disabled: busyId === inst.id || (!inst.requiresMigration && isProcessAlive(inst.status)),
                        title:
                          !inst.requiresMigration && isProcessAlive(inst.status)
                            ? '实例仍在运行，请先停止后再删除'
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
        title="创建空实例"
        description={
          <>
            <p>将创建一个空的实例文件夹。创建后请在文件页上传服务端 jar 文件，并在「实例设置」中确认启动文件名。</p>
            <div className="field">
              <label htmlFor="empty-instance-name">实例名称</label>
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
        confirmLabel="创建并前往文件页"
        busy={emptyBusy}
        confirmDisabled={!emptyJvmValid}
        onConfirm={() => void confirmCreateEmpty()}
        onCancel={() => setEmptyOpen(false)}
      />

      {/* 重启确认 */}
      <ConfirmDialog
        open={restartTarget !== null}
        title={`重启实例「${restartTarget?.name ?? ''}」？`}
        description="重启会中断当前游戏进程并断开所有在线玩家，未保存的世界数据可能丢失。"
        confirmLabel="确认重启"
        busy={busyId === restartTarget?.id}
        onConfirm={() => void confirmRestart()}
        onCancel={() => setRestartTarget(null)}
      />

      {/* 强制停止确认 */}
      <ConfirmDialog
        open={forceStopTarget !== null}
        title={`强制停止实例「${forceStopTarget?.name ?? ''}」？`}
        description="强制停止会立即结束服务器进程，未保存的世界数据可能丢失甚至损坏。建议先尝试普通「停止」。"
        confirmLabel="确认强制停止"
        danger
        busy={busyId === forceStopTarget?.id}
        onConfirm={() => void confirmForceStop()}
        onCancel={() => setForceStopTarget(null)}
      />

      {/* 删除确认 */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title={deleteTarget?.requiresMigration ? `移除实例记录「${deleteTarget?.name ?? ''}」？` : `删除实例「${deleteTarget?.name ?? ''}」？`}
        description={
          deleteTarget?.requiresMigration
            ? '仅移除面板中的实例记录，不会删除旧目录中的任何文件。'
            : '将永久删除该实例目录及其全部文件（世界、配置、模组），此操作不可恢复。'
        }
        confirmLabel={deleteTarget?.requiresMigration ? '移除记录' : '永久删除'}
        danger
        busy={busyId === deleteTarget?.id}
        requireText={deleteTarget?.requiresMigration ? undefined : deleteTarget?.name}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
