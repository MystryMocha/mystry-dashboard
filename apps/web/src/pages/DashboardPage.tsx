import { useCallback, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Activity,
  FolderDown,
  Layers,
  Play,
  Plus,
  Power,
  RotateCcw,
  Server,
  Trash2,
  Zap,
} from 'lucide-react';
import type { InstanceInfo } from '@mystry/shared';
import { api, controlInstance, instanceApi, type InstanceAction } from '../api';
import { HostMetricCards, processMetric, useDashboardMetrics } from '../components/DashboardMetrics';
import { ActionMenu } from '../components/ActionMenu';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EulaCheckbox } from '../components/EulaCheckbox';
import { JavaRuntimeSelect } from '../components/JavaRuntimeSelect';
import { JvmSettingsEditor } from '../components/JvmSettingsEditor';
import { errorMessage } from '../errors';
import { useInstanceAction } from '../hooks/useInstanceAction';
import { usePolling } from '../hooks/usePolling';
import {
  canStartInstance,
  canStopInstance,
  instanceStatusLabel,
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <div className="metric-grid dashboard-metrics">
        <div className="metric-card">
          <div className="metric-header">
            <span>实例状态</span>
            <Activity size={18} style={{ color: 'var(--ok)' }} />
          </div>
          <div className="metric-value">
            {loadState === 'loaded' ? `${runningCount} / ${instances.length}` : '—'} <span className="metric-unit">运行中</span>
          </div>
          <div className="metric-bar">
            <div className="metric-bar-fill" style={{ width: `${runningRatio}%`, background: 'var(--ok)' }} />
          </div>
          <div className="metric-detail">已停止 {loadState === 'loaded' ? stoppedCount : '—'} · <button type="button" className="metric-filter" aria-pressed={abnormalOnly} onClick={() => setAbnormalOnly(value => !value)}>异常 {loadState === 'loaded' ? abnormalCount : '—'}{abnormalOnly ? ' · 显示全部' : ''}</button></div>
        </div>

        <HostMetricCards metrics={metrics} error={metricsError} />
      </div>
      <div className="metrics-status">
        <span role="status">{metricsError ? `${metricsError}${metrics ? '，数据可能过期' : ''}` : metrics ? `更新于 ${new Date(metrics.sampledAt).toLocaleTimeString()}` : '正在读取监测数据…'}{metrics && !metricsError && metrics.warnings.length > 0 ? ` · ${metrics.warnings.join(' · ')}` : ''}</span>
        <button type="button" className="metric-filter" disabled={metricsBusy} onClick={() => void refreshMetrics()}>{metricsBusy ? '刷新中…' : metricsError ? '重试监测' : '刷新'}</button>
      </div>

      {actionError && <p className="error" role="alert">{actionError}</p>}
      {loadError && (
        <p className="error" role="alert">
          {loadError}
          {loadState === 'loaded' ? ' 当前正在显示上次成功加载的实例数据。' : ''}
        </p>
      )}

      <div className="section-header">
        <div className="section-title">
          <span>Minecraft 实例列表</span>
          <span className="tag-badge">{instances.length} 个实例</span>
        </div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <Link to="/deploy" className="btn btn-primary">
            <Plus size={15} />
            一键部署
          </Link>
          <Link to="/import" className="btn">
            <FolderDown size={15} />
            导入服务端
          </Link>
          <button type="button" className="btn" onClick={() => setEmptyOpen(true)}>
            <Zap size={15} />
            创建空实例
          </button>
        </div>
      </div>

      {loadState === 'loading' ? (
        <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
          正在加载实例列表…
        </div>
      ) : loadState === 'error' ? (
        <div className="panel" role="alert" style={{ textAlign: 'center', padding: '32px' }}>
          <p className="muted">实例列表暂时不可用，请检查面板连接后重试。</p>
          <button className="btn btn-ghost" type="button" onClick={retryLoad} style={{ marginTop: '12px' }}>
            重新加载
          </button>
        </div>
      ) : instances.length === 0 ? (
        <div className="panel" style={{ textAlign: 'center', padding: '48px 24px' }}>
          <Layers size={40} style={{ color: 'var(--text-muted)', marginBottom: '12px' }} />
          <h3 style={{ fontSize: '1.1rem', margin: '0 0 8px' }}>暂无 Minecraft 实例</h3>
          <p className="muted" style={{ margin: '0 0 20px' }}>
            你可以从「一键部署」下载官方核心，或从同机目录及 ZIP 包导入已有服务端。
          </p>
          <div style={{ display: 'flex', justifyContent: 'center', gap: '12px' }}>
            <Link to="/deploy" className="btn btn-primary">
              <Plus size={15} />
              部署第一个服务端
            </Link>
            <Link to="/import" className="btn">
              <FolderDown size={15} />
              导入已有服务端
            </Link>
          </div>
        </div>
      ) : (
        <div className="instance-grid">
          {abnormalOnly && abnormalCount === 0 && <p className="muted">暂无异常实例。</p>}
          {instances.filter(inst => !abnormalOnly || inst.status === 'crashed' || inst.requiresMigration).map((inst) => (
            <div
              key={inst.id}
              className="instance-card"
            >
              <div className="inst-card-top">
                <div className="inst-card-info">
                  <div
                    className="inst-avatar"
                    style={{
                      color: inst.status === 'running' ? 'var(--accent)' : 'var(--text-muted)',
                      borderColor: inst.status === 'running' ? 'var(--accent)' : 'var(--border)',
                    }}
                  >
                    <Server size={22} />
                  </div>
                  <div className="inst-name-group">
                    <Link to={`/instances/${inst.id}`} className="inst-name" title={inst.name}>
                      {inst.name}
                    </Link>
                    <div className="inst-core-badge">
                      {inst.coreType.toUpperCase()} {inst.mcVersion ? `· ${inst.mcVersion}` : ''}
                    </div>
                  </div>
                </div>
                <span className={`status-badge ${inst.requiresMigration ? 'starting' : inst.status}`}>
                  {inst.requiresMigration ? '▲ 待迁移' : `● ${instanceStatusLabel[inst.status] || inst.status}`}
                </span>
              </div>

              <div className="inst-stat-row">
                <div className="inst-stat-item">
                  <span className="inst-stat-label" title="按整机逻辑核总容量计算">进程 CPU</span>
                  <span className="inst-stat-val">{processMetric(inst, metrics, metricsError, 'cpu')}</span>
                </div>
                <div className="inst-stat-item">
                  <span className="inst-stat-label" title="服务器进程实际占用的内存，通常略高于设置的最大内存">进程内存</span>
                  <span className="inst-stat-val">{processMetric(inst, metrics, metricsError, 'memory')}</span>
                </div>
                <div className="inst-stat-item">
                  <span className="inst-stat-label">最大内存</span>
                  <span className="inst-stat-val">{extractXmx(inst.jvmArgs)}</span>
                </div>
                <div className="inst-stat-item">
                  <span className="inst-stat-label">Java 运行时</span>
                  <span className="inst-stat-val">{inst.javaRuntimeId ? '专属环境' : '系统默认'}</span>
                </div>
              </div>

              <div className="inst-card-actions">
                {canStartInstance(inst.status) && (
                  <button
                    className="btn btn-ok"
                    type="button"
                    disabled={busyId === inst.id || inst.requiresMigration}
                    onClick={() => void act(inst.id, 'start')}
                  >
                    <Play size={14} />
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
                    <Power size={14} />
                    停止
                  </button>
                )}
                <Link to={`/instances/${inst.id}`} className="btn btn-primary">
                  进入管理
                </Link>

                <ActionMenu
                  items={[
                    {
                      key: 'restart',
                      label: '重启实例',
                      icon: <RotateCcw size={13} />,
                      disabled: busyId === inst.id || inst.requiresMigration || isLifecycleBusy(inst.status),
                      onSelect: () => setRestartTarget(inst),
                    },
                    {
                      key: 'force-stop',
                      label: '强制停止',
                      icon: <Power size={13} />,
                      disabled: busyId === inst.id || inst.requiresMigration || !isProcessAlive(inst.status),
                      onSelect: () => setForceStopTarget(inst),
                    },
                    {
                      key: 'delete',
                      label: '删除实例',
                      icon: <Trash2 size={13} />,
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
            </div>
          ))}
        </div>
      )}

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
