import { useCallback, useId, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { PanelNetworkStatus, RemoteAccessStatus } from '@mystry/shared';
import { getRemoteAccess } from '../api';
import { errorMessage } from '../errors';
import { useDialogOpen } from '../hooks/useDialogOpen';
import { usePolling } from '../hooks/usePolling';
import { useI18n } from '../i18n';
import { RemoteAccessMode } from './RemoteAccessMode';
import { RemotePanelNetwork } from './RemotePanelNetwork';

type Tab = 'direct' | 'network';
type NetworkTab = 'builtIn' | 'installed';

/**
 * The "Open on other devices" dialog: direct access (same network or public) and virtual networking (the panel's built-in EasyTier, installed virtual networking software).
 * While open it reads the status periodically; the server re-enumerates interfaces every time, so address changes are followed here.
 */
export function RemoteAccessDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const dialogRef = useDialogOpen(true);
  const titleId = useId();
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<Tab | null>(null);
  const [networkTab, setNetworkTab] = useState<NetworkTab | null>(null);
  // While the user is acting, stale polling results must not overwrite the state just saved.
  const latestRequest = useRef(0);

  const applyStatus = useCallback((next: RemoteAccessStatus) => {
    latestRequest.current += 1;
    setStatus(next);
    setError('');
  }, []);

  const load = useCallback(async () => {
    const requestId = ++latestRequest.current;
    try {
      const next = await getRemoteAccess();
      if (requestId !== latestRequest.current) return;
      setStatus(next);
      setError('');
    } catch (err) {
      if (requestId === latestRequest.current) setError(errorMessage(err));
    }
  }, []);
  const waiting = status?.panelNetwork.state === 'installing' || status?.panelNetwork.state === 'starting';
  usePolling(load, waiting ? 2000 : 5000);

  async function refresh(): Promise<void> {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  // Direct access is shown by default; when only virtual networking is enabled it is shown by default. When an overlay interface is detected, the networking segment defaults to "installed virtual networking software".
  const networkOn = Boolean(status && (status.overlay.enabled || status.panelNetwork.enabled));
  const activeTab: Tab = tab ?? (status && !status.direct.enabled && networkOn && !status.managedByConfig ? 'network' : 'direct');
  const hasOverlayAdapter = Boolean(status?.interfaces.some((entry) => entry.kind === 'overlay'));
  const activeNetworkTab: NetworkTab = networkTab
    ?? (status?.panelNetwork.enabled ? 'builtIn' : status?.overlay.enabled || hasOverlayAdapter ? 'installed' : 'builtIn');

  const onNetwork = (next: PanelNetworkStatus): void => {
    if (status) applyStatus({ ...status, panelNetwork: next });
  };

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog remote-dialog"
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="confirm-dialog-panel">
        <div className="remote-dialog-header">
          <h2 id={titleId} className="confirm-dialog-title">{t('remoteAccess.title')}</h2>
          <button
            className="btn btn-icon btn-plain"
            type="button"
            title={t('remoteAccess.refresh')}
            aria-label={t('remoteAccess.refresh')}
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            <RefreshCw size={16} aria-hidden="true" className={refreshing ? 'is-spinning' : undefined} />
          </button>
        </div>
        <div className="confirm-dialog-body remote-dialog-body">
          {error && <p className="callout callout-danger" role="alert">{error}</p>}
          {!status && !error && (
            <div className="page-loading" role="status">
              <span className="spinner" aria-hidden="true" />
              {t('remoteAccess.loading')}
            </div>
          )}
          {status && (
            <>
              {!status.managedByConfig && (
                <div className="segmented remote-tabs" role="group" aria-label={t('remoteAccess.tab.label')}>
                  {(['direct', 'network'] as const).map((item) => (
                    <button
                      key={item}
                      type="button"
                      className={`segmented-item${activeTab === item ? ' active' : ''}`}
                      aria-pressed={activeTab === item}
                      onClick={() => setTab(item)}
                    >
                      {t(item === 'direct' ? 'remoteAccess.tab.direct' : 'remoteAccess.tab.network')}
                    </button>
                  ))}
                </div>
              )}
              {activeTab === 'direct' ? (
                <RemoteAccessMode key="direct" mode="direct" status={status} onStatus={applyStatus} />
              ) : (
                <>
                  <div className="segmented remote-tabs" role="group" aria-label={t('remoteAccess.networkTab.label')}>
                    {(['builtIn', 'installed'] as const).map((item) => (
                      <button
                        key={item}
                        type="button"
                        className={`segmented-item${activeNetworkTab === item ? ' active' : ''}`}
                        aria-pressed={activeNetworkTab === item}
                        onClick={() => setNetworkTab(item)}
                      >
                        {t(item === 'builtIn' ? 'remoteAccess.networkTab.builtIn' : 'remoteAccess.networkTab.installed')}
                      </button>
                    ))}
                  </div>
                  {activeNetworkTab === 'builtIn' ? (
                    <RemotePanelNetwork network={status.panelNetwork} onNetwork={onNetwork} />
                  ) : (
                    <RemoteAccessMode key="overlay" mode="overlay" status={status} onStatus={applyStatus} />
                  )}
                </>
              )}
            </>
          )}
        </div>
        <footer className="confirm-dialog-footer">
          <button className="btn" type="button" onClick={onClose}>{t('action.close')}</button>
        </footer>
      </div>
    </dialog>
  );
}
