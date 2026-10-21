import { useCallback, useEffect, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { NodeInfo } from '@mystry/shared';
import { api } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';

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
      setLoadError(err instanceof Error ? err.message : String(err));
      setLoadState((current) => (current === 'loaded' ? 'loaded' : 'error'));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

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
      await api(`/api/nodes/${target.id}`, { method: 'DELETE' });
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  const localNode = nodes.find((n) => n.isLocal);
  const remoteNodes = nodes.filter((n) => !n.isLocal);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div className="section-header">
        <div>
          <h1 className="page-title" style={{ margin: 0 }}>本机运行环境</h1>
          <p className="page-desc" style={{ margin: '4px 0 0' }}>
            运行面板和 Minecraft 服务器的这台电脑的基本信息。
          </p>
        </div>
      </div>

      {loadError && (
        <p className="error" role="alert">
          {loadError}
          {nodes.length > 0 ? ' 当前数据可能已过期，正在显示上次成功加载的节点数据。' : ''}
          <button className="btn" type="button" onClick={retryLoad}>重试加载</button>
        </p>
      )}

      {loadState === 'loading' && <p role="status">正在加载节点信息…</p>}
      {loadState === 'loaded' && !loadError && nodes.length === 0 && (
        <div className="form-card"><p>暂无节点。</p><button className="btn" type="button" onClick={retryLoad}>刷新节点</button></div>
      )}

      {localNode && (
        <div className="form-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border)', paddingBottom: '14px', flexWrap: 'wrap', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 12, height: 12, flexShrink: 0, borderRadius: '50%', background: loadError ? 'var(--warn)' : localNode.status === 'online' ? 'var(--ok)' : 'var(--text-muted)' }} />
              <span style={{ fontWeight: 700, fontSize: '1.1rem' }}>{localNode.name}</span>
            </div>
            <span className={`status-badge ${loadError ? 'starting' : localNode.status === 'online' ? 'running' : 'stopped'}`}>
              <ShieldCheck size={14} />
              {loadError ? '状态可能已过期' : statusLabel[localNode.status] || localNode.status}
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginTop: '6px' }}>
            <div className="inst-stat-item">
              <span className="inst-stat-label">操作系统</span>
              <span className="inst-stat-val">
                {localNode.hostInfo?.platform
                  ? platformLabel[localNode.hostInfo.platform] ?? localNode.hostInfo.platform
                  : '未知'}
              </span>
            </div>
            <div className="inst-stat-item">
              <span className="inst-stat-label">CPU 架构 / 核心</span>
              <span className="inst-stat-val">
                {localNode.hostInfo?.arch || '未知'}
                {localNode.hostInfo?.cpuCount ? ` · ${localNode.hostInfo.cpuCount} 线程` : ''}
              </span>
            </div>
            <div className="inst-stat-item">
              <span className="inst-stat-label">物理内存总量</span>
              <span className="inst-stat-val">
                {localNode.hostInfo?.totalMemMb
                  ? `${(localNode.hostInfo.totalMemMb / 1024).toFixed(1)} GB`
                  : '未知'}
              </span>
            </div>
            <div className="inst-stat-item">
              <span className="inst-stat-label">实例数量</span>
              <span className="inst-stat-val" style={{ color: 'var(--accent)' }}>
                {localNode.instanceCount} 个服务实例
              </span>
            </div>
          </div>
        </div>
      )}

      {remoteNodes.length > 0 && (
        <div className="panel">
          <h3 style={{ margin: '0 0 12px' }}>其他节点列表</h3>
          <table className="table">
            <thead>
              <tr>
                <th>名称</th>
                <th>类型</th>
                <th>状态</th>
                <th>实例数</th>
                <th>最近心跳</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {remoteNodes.map((node) => (
                <tr key={node.id}>
                  <td data-label="名称">{node.name}</td>
                  <td data-label="类型">远程节点</td>
                  <td data-label="状态">
                    <span className={`status-badge ${node.status === 'online' ? 'running' : 'stopped'}`}>
                      {statusLabel[node.status] || node.status}
                    </span>
                  </td>
                  <td data-label="实例数">{node.instanceCount}</td>
                  <td data-label="最近心跳" className="muted">
                    {node.lastSeenAt ? new Date(node.lastSeenAt).toLocaleString() : '—'}
                  </td>
                  <td data-label="操作">
                    <button
                      className="btn btn-danger"
                      type="button"
                      disabled={busyId === node.id || node.instanceCount > 0}
                      onClick={() => openDeleteDialog(node)}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
