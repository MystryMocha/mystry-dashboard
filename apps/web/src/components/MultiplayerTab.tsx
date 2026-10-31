import { useCallback, useRef, useState } from 'react';
import type { FrpEndpoint, FrpRuntimeInfo, InstanceTunnel, TunnelMode, TunnelStatus } from '@mystry/shared';
import { FRP_TRANSPORTS } from '@mystry/shared';
import {
  createFrpEndpoint,
  deleteFrpEndpoint,
  fetchFriendTunnelConfig,
  getFrpRuntime,
  getInstanceTunnel,
  installFrpRuntime,
  listFrpEndpoints,
  saveInstanceTunnel,
} from '../api';
import { errorMessage } from '../errors';
import { usePolling } from '../hooks/usePolling';
import { useI18n, type MessageKey } from '../i18n';
import { StatusPill, type StatusTone } from './StatusPill';
import { ConfirmDialog } from './ConfirmDialog';

const STATUS_KEY: Record<TunnelStatus, MessageKey> = {
  disabled: 'multiplayer.status.disabled',
  stopped: 'multiplayer.status.stopped',
  starting: 'multiplayer.status.starting',
  running: 'multiplayer.status.running',
  error: 'multiplayer.status.error',
};

function statusTone(status: TunnelStatus): StatusTone {
  if (status === 'running') return 'running';
  if (status === 'starting') return 'starting';
  if (status === 'error') return 'crashed';
  return 'stopped';
}
interface EndpointDraft {
  name: string;
  serverAddr: string;
  serverPort: string;
  visitHost: string;
  transport: (typeof FRP_TRANSPORTS)[number];
  tls: boolean;
  token: string;
}

interface TunnelDraft {
  enabled: boolean;
  endpointId: string;
  mode: TunnelMode;
  remotePort: string;
  visitorBindPort: string;
}

const EMPTY_ENDPOINT: EndpointDraft = {
  name: '',
  serverAddr: '',
  serverPort: '7000',
  visitHost: '',
  transport: 'tcp',
  tls: true,
  token: '',
};

function tunnelDraft(tunnel: InstanceTunnel, endpoints: FrpEndpoint[]): TunnelDraft {
  return {
    enabled: tunnel.enabled,
    endpointId: tunnel.endpointId ?? endpoints[0]?.id ?? '',
    mode: tunnel.mode,
    remotePort: String(tunnel.remotePort ?? tunnel.localPort),
    visitorBindPort: String(tunnel.visitorBindPort),
  };
}

/** 实例联机：只配置官方 frpc，不提供原始配置或可执行路径。 */
export function MultiplayerTab({ instanceId }: { instanceId: string }) {
  const { t, tm } = useI18n();
  const [endpoints, setEndpoints] = useState<FrpEndpoint[]>([]);
  const [runtime, setRuntime] = useState<FrpRuntimeInfo | null>(null);
  const [tunnel, setTunnel] = useState<InstanceTunnel | null>(null);
  const [endpointDraft, setEndpointDraft] = useState<EndpointDraft>(EMPTY_ENDPOINT);
  const [draft, setDraft] = useState<TunnelDraft | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const loadError = useRef(false);
  const refresh = useCallback(async () => {
    try {
      const [nextEndpoints, nextRuntime, nextTunnel] = await Promise.all([
        listFrpEndpoints(),
        getFrpRuntime(),
        getInstanceTunnel(instanceId),
      ]);
      setEndpoints(nextEndpoints);
      setRuntime(nextRuntime);
      setTunnel(nextTunnel);
      setDraft((current) => current ?? tunnelDraft(nextTunnel, nextEndpoints));
      if (loadError.current) {
        loadError.current = false;
        setError('');
      }
    } catch (err) {
      loadError.current = true;
      setError(errorMessage(err));
    }
  }, [instanceId]);

  usePolling(refresh);

  async function saveEndpoint() {
    const port = Number(endpointDraft.serverPort);
    if (!Number.isInteger(port)) return;
    setBusy(true);
    setNotice('');
    try {
      const created = await createFrpEndpoint({
        name: endpointDraft.name,
        serverAddr: endpointDraft.serverAddr,
        serverPort: port,
        visitHost: endpointDraft.visitHost,
        transport: endpointDraft.transport,
        tls: endpointDraft.tls,
        token: endpointDraft.token,
      });
      setEndpointDraft(EMPTY_ENDPOINT);
      setError('');
      setDraft((current) => current ? { ...current, endpointId: created.id } : current);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeEndpoint() {
    if (!draft?.endpointId) return;
    setBusy(true);
    setConfirmDelete(false);
    try {
      await deleteFrpEndpoint(draft.endpointId);
      setDraft((current) => current ? { ...current, endpointId: '' } : current);
      setError('');
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveTunnel() {
    if (!draft) return;
    const remotePort = Number(draft.remotePort);
    const visitorBindPort = Number(draft.visitorBindPort);
    setBusy(true);
    setNotice('');
    try {
      const saved = await saveInstanceTunnel(instanceId, {
        enabled: draft.enabled,
        endpointId: draft.endpointId,
        mode: draft.mode,
        ...(draft.mode === 'public' ? { remotePort } : {}),
        visitorBindPort,
      });
      setTunnel(saved);
      setDraft(tunnelDraft(saved, endpoints));
      setNotice(t('multiplayer.saved'));
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function friendText(): Promise<string> {
    return fetchFriendTunnelConfig(instanceId);
  }

  async function copyFriend() {
    setBusy(true);
    try {
      await navigator.clipboard.writeText(await friendText());
      setNotice(t('multiplayer.tunnel.copied'));
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function downloadFriend() {
    setBusy(true);
    try {
      const text = await friendText();
      const url = URL.createObjectURL(new Blob([text], { type: 'application/toml' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'friend-frpc.toml';
      link.click();
      URL.revokeObjectURL(url);
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function install() {
    setBusy(true);
    try {
      setRuntime(await installFrpRuntime());
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const needsClient = Boolean(runtime?.platformSupported && !runtime.installed);
  const serverIsNext = !needsClient && endpoints.length === 0;

  return (
    <div className="form-stack settings-workspace">
      <p className="section-lead">{t('multiplayer.intro')}</p>
      {error && <p className="callout callout-danger" role="alert">{error}</p>}
      {notice && <p className="callout">{notice}</p>}
      {runtime && !runtime.platformSupported && (
        <p className="callout callout-danger" role="alert">{t('multiplayer.runtime.unsupported')}</p>
      )}
      {runtime?.platformSupported && !runtime.installed && (
        <div className="callout">
          <p>{t('multiplayer.runtime.missing')}</p>
          <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void install()}>
            {t('multiplayer.runtime.install')}
          </button>
        </div>
      )}
      {runtime?.installed && (
        <p className="field-help">{t('multiplayer.runtime.installed', { version: runtime.version })}</p>
      )}

      <section className="form-section">
        <h3 className="form-section-title">{t('multiplayer.section.server')}</h3>
        <div className="card form-card">
          <div className="field">
            <label htmlFor="frp-name">{t('multiplayer.endpoint.name')}</label>
            <input id="frp-name" value={endpointDraft.name} disabled={busy} onChange={(event) => setEndpointDraft({ ...endpointDraft, name: event.target.value })} />
          </div>
          <div className="grid grid-2">
            <div className="field">
              <label htmlFor="frp-address">{t('multiplayer.endpoint.address')}</label>
              <input id="frp-address" value={endpointDraft.serverAddr} disabled={busy} onChange={(event) => setEndpointDraft({ ...endpointDraft, serverAddr: event.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="frp-port">{t('multiplayer.endpoint.port')}</label>
              <input id="frp-port" inputMode="numeric" value={endpointDraft.serverPort} disabled={busy} onChange={(event) => setEndpointDraft({ ...endpointDraft, serverPort: event.target.value })} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="frp-visit">{t('multiplayer.endpoint.visitHost')}</label>
            <input id="frp-visit" value={endpointDraft.visitHost} disabled={busy} onChange={(event) => setEndpointDraft({ ...endpointDraft, visitHost: event.target.value })} />
            <p className="field-help">{t('multiplayer.endpoint.visitHostHelp')}</p>
          </div>
          <div className="field">
            <label htmlFor="frp-transport">{t('multiplayer.endpoint.transport')}</label>
            <select id="frp-transport" value={endpointDraft.transport} disabled={busy} onChange={(event) => setEndpointDraft({ ...endpointDraft, transport: event.target.value as EndpointDraft['transport'] })}>
              {FRP_TRANSPORTS.map((transport) => <option key={transport} value={transport}>{transport}</option>)}
            </select>
          </div>
          <label className="checkbox-field">
            <input type="checkbox" checked={endpointDraft.tls} disabled={busy} onChange={(event) => setEndpointDraft({ ...endpointDraft, tls: event.target.checked })} />
            <span>{t('multiplayer.endpoint.tls')}</span>
          </label>
          <div className="field">
            <label htmlFor="frp-token">{t('multiplayer.endpoint.token')}</label>
            <input id="frp-token" type="password" autoComplete="off" value={endpointDraft.token} disabled={busy} onChange={(event) => setEndpointDraft({ ...endpointDraft, token: event.target.value })} />
          </div>
          <button className={serverIsNext ? 'btn btn-primary' : 'btn'} type="button" disabled={busy} onClick={() => void saveEndpoint()}>
            {t('multiplayer.endpoint.save')}
          </button>
        </div>
      </section>

      <section className="form-section">
        <h3 className="form-section-title">{t('multiplayer.section.access')}</h3>
        {!draft || endpoints.length === 0 ? (
          <p className="field-help">{t('multiplayer.endpoint.empty')}</p>
        ) : (
          <div className="card form-card">
            <div className="field">
              <label htmlFor="frp-endpoint">{t('multiplayer.section.server')}</label>
              <select id="frp-endpoint" value={draft.endpointId} disabled={busy} onChange={(event) => setDraft({ ...draft, endpointId: event.target.value })}>
                {endpoints.map((endpoint) => (
                  <option key={endpoint.id} value={endpoint.id}>{endpoint.name}</option>
                ))}
              </select>
            </div>
            <label className="checkbox-field">
              <input type="checkbox" checked={draft.enabled} disabled={busy} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />
              <span>{t('multiplayer.tunnel.enable')}</span>
            </label>
            <div className="grid grid-2">
              <div className="field">
                <label htmlFor="frp-mode">{t('multiplayer.tunnel.mode')}</label>
                <select id="frp-mode" value={draft.mode} disabled={busy} onChange={(event) => setDraft({ ...draft, mode: event.target.value as TunnelMode })}>
                  <option value="public">{t('multiplayer.tunnel.mode.public')}</option>
                  <option value="stcp">{t('multiplayer.tunnel.mode.stcp')}</option>
                  <option value="xtcp">{t('multiplayer.tunnel.mode.xtcp')}</option>
                </select>
              </div>
              {draft.mode === 'public' ? (
                <div className="field">
                  <label htmlFor="frp-remote">{t('multiplayer.tunnel.remotePort')}</label>
                  <input id="frp-remote" inputMode="numeric" value={draft.remotePort} disabled={busy} onChange={(event) => setDraft({ ...draft, remotePort: event.target.value })} />
                </div>
              ) : (
                <div className="field">
                  <label htmlFor="frp-visitor">{t('multiplayer.tunnel.visitorPort')}</label>
                  <input id="frp-visitor" inputMode="numeric" value={draft.visitorBindPort} disabled={busy} onChange={(event) => setDraft({ ...draft, visitorBindPort: event.target.value })} />
                </div>
              )}
            </div>
            <p className="field-help">{draft.mode === 'public' ? t('multiplayer.help.public') : t('multiplayer.help.intranet')}</p>
            {tunnel && (
              <div className="instance-meta">
                <StatusPill tone={statusTone(tunnel.status)}>{t(STATUS_KEY[tunnel.status])}</StatusPill>
                {tunnel.joinAddress && <span>{t('multiplayer.tunnel.join', { address: tunnel.joinAddress })}</span>}
              </div>
            )}
            {tunnel?.detail && <p className="callout" role="status">{tm(tunnel.detail)}</p>}
            <div className="instance-actions">
              <button className={!needsClient && !serverIsNext ? 'btn btn-primary' : 'btn'} type="button" disabled={busy || draft.endpointId.length === 0} onClick={() => void saveTunnel()}>
                {t('multiplayer.tunnel.save')}
              </button>
              <button className="btn btn-plain is-danger" type="button" disabled={busy || draft.endpointId.length === 0} onClick={() => setConfirmDelete(true)}>
                {t('multiplayer.endpoint.delete')}
              </button>
              {tunnel && tunnel.enabled && tunnel.mode !== 'public' && (
                <>
                  <button className="btn" type="button" disabled={busy} onClick={() => void copyFriend()}>{t('multiplayer.tunnel.copy')}</button>
                  <button className="btn" type="button" disabled={busy} onClick={() => void downloadFriend()}>{t('multiplayer.tunnel.friend')}</button>
                </>
              )}
            </div>
            {tunnel && tunnel.enabled && tunnel.mode !== 'public' && (
              <p className="field-help">{t('multiplayer.tunnel.friendHelp')}</p>
            )}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={confirmDelete}
        title={t('multiplayer.endpoint.deleteTitle')}
        description={t('multiplayer.endpoint.deleteBody')}
        confirmLabel={t('multiplayer.endpoint.delete')}
        danger
        busy={busy}
        onConfirm={() => void removeEndpoint()}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
