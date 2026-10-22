import { useCallback, useRef, useState } from 'react';
import { Monitor, ShieldCheck } from 'lucide-react';
import type { NodeInfo } from '@mystry/shared';
import { api } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { PageHeader } from '../components/PageHeader';
import { StatusPill } from '../components/StatusPill';
import { errorMessage } from '../errors';
import { usePolling } from '../hooks/usePolling';

const statusLabel: Record<string, string> = {
  online: '在线',
  offline: '离线',
};

/** Node.js 平台标识转成用户看得懂的系统名。 */
const platformLabel: Record<string, string> = {
  win32: 'Windows',
  linux: 'Linux',
  darwin: 'macOS',
};

type LoadState = 'loading' | 'loaded' | 'error';

export function NodesPage() {
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<NodeInfo | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const latestLoadRequestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++latestLoadRequestRef.current;
    try {
      const result = await api<NodeInfo[]>('/api/nodes');
      if (requestId !== latestLoadRequestRef.current) return;
      setNodes(result);
      setLoadState('loaded');
      setLoadError('');
    } catch (err) {
      if (requestId !== latestLoadRequestRef.current) return;
      setLoadError(errorMessage(err));
      setLoadState((current) => (current === 'loaded' ? 'loaded' : 'error'));
    }
  }, []);
  usePolling(load);

  function retryLoad(): void {
    setLoadError('');
    setLoadState('loading');
    void load();
  }

  function openDeleteDialog(node: NodeInfo): void {
    setDeleteError('');
    setDeleteTarget(node);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setBusyId(target.id);
    setDeleteError('');
    try {
      await api(`/api/nodes/${encodeURIComponent(target.id)}`, { method: 'DELETE' });
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setDeleteError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  const localNode = nodes.find((n) => n.isLocal);
  const remoteNodes = nodes.filter((n) => !n.isLocal);

  return (
    <div className="page">
      <PageHeader title="本机环境" subtitle="运行面板和 Minecraft 服务器的这台电脑的基本信息。" />

      {loadError && (
        <div className="callout callout-danger" role="alert">
          <p>
            {loadError}
            {nodes.length > 0 ? ' 当前数据可能已过期，正在显示上次成功加载的节点数据。' : ''}
          </p>
          <button className="btn btn-sm" type="button" onClick={retryLoad}>重试加载</button>
        </div>
      )}

      {loadState === 'loading' && (
        <div className="page-loading" role="status">
          <span className="spinner" aria-hidden="true" />
          正在加载节点信息…
        </div>
      )}
      {loadState === 'loaded' && !loadError && nodes.length === 0 && (
        <div className="empty-state card">
          <span className="empty-icon" aria-hidden="true"><Monitor size={28} /></span>
          <p>暂无节点。</p>
          <button className="btn" type="button" onClick={retryLoad}>刷新节点</button>
        </div>
      )}

      {localNode && (
        <section className="card about-card" aria-label="本机信息">
          <div className="about-hero">
            <span className="about-icon" aria-hidden="true"><Monitor size={34} strokeWidth={1.6} /></span>
            <div className="about-title">
              <h2>{localNode.name}</h2>
              <StatusPill
                tone={loadError ? 'warning' : localNode.status === 'online' ? 'running' : 'stopped'}
                icon={<ShieldCheck size={13} aria-hidden="true" />}
              >
                {loadError ? '状态可能已过期' : statusLabel[localNode.status] || localNode.status}
              </StatusPill>
            </div>
          </div>

          <dl className="list-group about-specs">
            <div className="list-row">
              <dt className="list-row-title">操作系统</dt>
              <dd className="list-row-value">
                {localNode.hostInfo?.platform
                  ? platformLabel[localNode.hostInfo.platform] ?? localNode.hostInfo.platform
                  : '未知'}
              </dd>
            </div>
            <div className="list-row">
              <dt className="list-row-title">CPU 架构 / 核心</dt>
              <dd className="list-row-value">
                {localNode.hostInfo?.arch || '未知'}
                {localNode.hostInfo?.cpuCount ? ` · ${localNode.hostInfo.cpuCount} 线程` : ''}
              </dd>
            </div>
            <div className="list-row">
              <dt className="list-row-title">物理内存总量</dt>
              <dd className="list-row-value">
                {localNode.hostInfo?.totalMemMb
                  ? `${(localNode.hostInfo.totalMemMb / 1024).toFixed(1)} GiB`
                  : '未知'}
              </dd>
            </div>
            <div className="list-row">
              <dt className="list-row-title">实例数量</dt>
              <dd className="list-row-value is-accent">
                {localNode.instanceCount} 个服务实例
              </dd>
            </div>
          </dl>
        </section>
      )}

      {remoteNodes.length > 0 && (
        <section className="form-section">
          <h2 className="form-section-title">其他节点列表</h2>
          <ul className="list-group">
            {remoteNodes.map((node) => (
              <li key={node.id} className="list-row node-row">
                <div className="list-row-text">
                  <span className="list-row-title">{node.name}</span>
                  <span className="list-row-desc">
                    远程节点 · {node.instanceCount} 个实例 · 最近心跳{' '}
                    {node.lastSeenAt ? new Date(node.lastSeenAt).toLocaleString() : '—'}
                  </span>
                </div>
                <div className="list-row-control">
                  <StatusPill tone={node.status === 'online' ? 'running' : 'stopped'}>
                    {statusLabel[node.status] || node.status}
                  </StatusPill>
                  <button
                    className="btn btn-danger btn-sm"
                    type="button"
                    disabled={busyId === node.id || node.instanceCount > 0}
                    onClick={() => openDeleteDialog(node)}
                  >
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title={`删除节点「${deleteTarget?.name ?? ''}」？`}
        description={
          <>
            <p>仅可删除没有关联实例的远程节点。删除后无法恢复。</p>
            {deleteError && <p className="error" role="alert">{deleteError}</p>}
          </>
        }
        confirmLabel="确认删除"
        danger
        busy={busyId === deleteTarget?.id}
        onConfirm={() => void confirmDelete()}
        onCancel={() => {
          setDeleteTarget(null);
          setDeleteError('');
        }}
      />
    </div>
  );
}
