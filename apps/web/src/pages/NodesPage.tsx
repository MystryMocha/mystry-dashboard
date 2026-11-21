import { lazy, Suspense, useCallback, useRef, useState } from 'react';
import { ChevronRight, Monitor, MonitorSmartphone, ShieldCheck } from 'lucide-react';
import type { NodeInfo } from '@mystry/shared';
import { api } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { DownloadSourceSection } from '../components/DownloadSourceSection';
import { SessionDurationSection } from '../components/SessionDurationSection';
import { PageHeader } from '../components/PageHeader';
import { StatusPill } from '../components/StatusPill';
import { errorMessage } from '../errors';
import { usePolling } from '../hooks/usePolling';
import { useI18n, type MessageKey } from '../i18n';

// 弹窗连同二维码库只在点开时加载。
const RemoteAccessDialog = lazy(() =>
  import('../components/RemoteAccessDialog').then(({ RemoteAccessDialog }) => ({ default: RemoteAccessDialog })),
);

/** 服务端 db.ts 写入的内置本机节点默认名称。 */
const DEFAULT_LOCAL_NODE_NAME = '本机节点';

const statusLabel: Record<string, MessageKey> = {
  online: 'nodes.status.online',
  offline: 'nodes.status.offline',
};

/** Node.js 平台标识转成用户看得懂的系统名。 */
const platformLabel: Record<string, string> = {
  win32: 'Windows',
  linux: 'Linux',
  darwin: 'macOS',
};

type LoadState = 'loading' | 'loaded' | 'error';

export function NodesPage() {
  const { t, tp, fmt } = useI18n();
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<NodeInfo | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [remoteAccessOpen, setRemoteAccessOpen] = useState(false);
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
  const nodeStatusText = (status: string) => {
    const key = statusLabel[status];
    return key ? t(key) : status;
  };

  return (
    <div className="page">
      <PageHeader title={t('nav.machine')} subtitle={t('nodes.subtitle')} />

      {loadError && (
        <div className="callout callout-danger" role="alert">
          <p>
            {loadError}
            {nodes.length > 0 ? ` ${t('nodes.load.staleNotice')}` : ''}
          </p>
          <button className="btn btn-sm" type="button" onClick={retryLoad}>{t('nodes.load.retry')}</button>
        </div>
      )}

      {loadState === 'loading' && (
        <div className="page-loading" role="status">
          <span className="spinner" aria-hidden="true" />
          {t('nodes.load.loading')}
        </div>
      )}
      {loadState === 'loaded' && !loadError && nodes.length === 0 && (
        <div className="empty-state card">
          <span className="empty-icon" aria-hidden="true"><Monitor size={28} /></span>
          <p>{t('nodes.empty.body')}</p>
          <button className="btn" type="button" onClick={retryLoad}>{t('nodes.empty.refresh')}</button>
        </div>
      )}

      {localNode && (
        <section className="card about-card" aria-label={t('nodes.local.label')}>
          <div className="about-hero">
            <span className="about-icon" aria-hidden="true"><Monitor size={34} strokeWidth={1.6} /></span>
            <div className="about-title">
              {/* 服务端内置的默认名称按当前语言显示；用户改过的名称原样显示。 */}
              <h2>{localNode.name === DEFAULT_LOCAL_NODE_NAME ? t('nodes.local.defaultName') : localNode.name}</h2>
              <StatusPill
                tone={loadError ? 'warning' : localNode.status === 'online' ? 'running' : 'stopped'}
                icon={<ShieldCheck size={13} aria-hidden="true" />}
              >
                {loadError ? t('nodes.status.stale') : nodeStatusText(localNode.status)}
              </StatusPill>
            </div>
          </div>

          <dl className="list-group about-specs">
            <div className="list-row">
              <dt className="list-row-title">{t('nodes.spec.os')}</dt>
              <dd className="list-row-value">
                {localNode.hostInfo?.platform
                  ? platformLabel[localNode.hostInfo.platform] ?? localNode.hostInfo.platform
                  : t('common.unknown')}
              </dd>
            </div>
            <div className="list-row">
              <dt className="list-row-title">{t('nodes.spec.cpu')}</dt>
              <dd className="list-row-value">
                {localNode.hostInfo?.arch || t('common.unknown')}
                {localNode.hostInfo?.cpuCount ? ` · ${tp('nodes.spec.threads', localNode.hostInfo.cpuCount)}` : ''}
              </dd>
            </div>
            <div className="list-row">
              <dt className="list-row-title">{t('nodes.spec.memory')}</dt>
              <dd className="list-row-value">
                {localNode.hostInfo?.totalMemMb
                  ? `${fmt.fixed(localNode.hostInfo.totalMemMb / 1024, 1)} GiB`
                  : t('common.unknown')}
              </dd>
            </div>
            <div className="list-row">
              <dt className="list-row-title">{t('nodes.spec.instances')}</dt>
              <dd className="list-row-value is-accent">
                {tp('nodes.spec.instanceCount', localNode.instanceCount)}
              </dd>
            </div>
          </dl>
        </section>
      )}

      {localNode && (
        <section className="form-section remote-entry-section">
          <div className="list-group">
            <button type="button" className="list-row remote-entry-row" onClick={() => setRemoteAccessOpen(true)}>
              <MonitorSmartphone size={18} aria-hidden="true" className="remote-entry-icon" />
              <span className="list-row-text">
                <span className="list-row-title">{t('remoteAccess.entry')}</span>
                <span className="list-row-desc">{t('remoteAccess.entry.desc')}</span>
              </span>
              <ChevronRight size={16} aria-hidden="true" className="remote-entry-chevron" />
            </button>
          </div>
        </section>
      )}
      {remoteAccessOpen && (
        <Suspense fallback={null}>
          <RemoteAccessDialog onClose={() => setRemoteAccessOpen(false)} />
        </Suspense>
      )}

      <SessionDurationSection />

      <DownloadSourceSection />

      {remoteNodes.length > 0 && (
        <section className="form-section">
          <h2 className="form-section-title">{t('nodes.remote.title')}</h2>
          <ul className="list-group">
            {remoteNodes.map((node) => (
              <li key={node.id} className="list-row node-row">
                <div className="list-row-text">
                  <span className="list-row-title">{node.name}</span>
                  <span className="list-row-desc">
                    {tp('nodes.remote.desc', node.instanceCount, {
                      lastSeen: node.lastSeenAt ? fmt.dateTime(node.lastSeenAt) || '—' : '—',
                    })}
                  </span>
                </div>
                <div className="list-row-control">
                  <StatusPill tone={node.status === 'online' ? 'running' : 'stopped'}>
                    {nodeStatusText(node.status)}
                  </StatusPill>
                  <button
                    className="btn btn-danger btn-sm"
                    type="button"
                    disabled={busyId === node.id || node.instanceCount > 0}
                    onClick={() => openDeleteDialog(node)}
                  >
                    {t('action.delete')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title={t('nodes.delete.title', { name: deleteTarget?.name ?? '' })}
        description={<p>{t('nodes.delete.body')}</p>}
        error={deleteError}
        confirmLabel={t('nodes.delete.confirm')}
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
