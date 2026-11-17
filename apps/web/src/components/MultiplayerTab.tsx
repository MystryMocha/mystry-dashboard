import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
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
  uploadFrpRuntime,
} from '../api';
import { copyText } from '../clipboard';
import { errorMessage } from '../errors';
import { usePolling } from '../hooks/usePolling';
import { useI18n, type MessageKey } from '../i18n';
import { StatusPill, type StatusTone } from './StatusPill';
import { ConfirmDialog } from './ConfirmDialog';
import { RuntimeInstallCallout } from './RuntimeArchiveUpload';
import { FlashNote, JoinAddressStep, JoinSteps, MultiplayerLayout, OpenSwitch, useFlash, type GuideControl } from './MultiplayerLayout';

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
    endpointId: tunnel.endpointId ?? endpoints[0]?.id ?? '',
    mode: tunnel.mode,
    remotePort: String(tunnel.remotePort ?? tunnel.localPort),
    visitorBindPort: String(tunnel.visitorBindPort),
  };
}

/**
 * 实例 frp 穿透：只配置官方 frpc，不提供原始配置或可执行路径。
 * 还没有 frp 服务器时先显示添加表单；有了以后按「开关 → 让玩家加入 → 穿透设置 → 添加服务器」排。
 * 第一次要先选好服务器和穿透模式并保存，开关才能用，免得用没看过的默认值在 frp 服务器上开端口。
 */
export function MultiplayerTab({ instanceId, guide }: { instanceId: string; guide: GuideControl }) {
  const { t, tm } = useI18n();
  const [endpoints, setEndpoints] = useState<FrpEndpoint[]>([]);
  const [runtime, setRuntime] = useState<FrpRuntimeInfo | null>(null);
  const [tunnel, setTunnel] = useState<InstanceTunnel | null>(null);
  const [endpointDraft, setEndpointDraft] = useState<EndpointDraft>(EMPTY_ENDPOINT);
  const [draft, setDraft] = useState<TunnelDraft | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // 复制加入说明 / 玩家配置的结果显示在按钮下面。
  const [copied, showCopied] = useFlash();
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [adding, setAdding] = useState(false);
  // 穿透设置折叠区：第一次读到时，已经开放就收起，没开放就展开。
  const [settingsOpen, setSettingsOpen] = useState<boolean | null>(null);
  useEffect(() => {
    if (tunnel && settingsOpen === null) setSettingsOpen(!tunnel.enabled);
  }, [tunnel, settingsOpen]);
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
      setAdding(false);
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

  async function toggleTunnel(next: boolean) {
    if (!tunnel?.endpointId) return;
    setBusy(true);
    setNotice('');
    try {
      // 用服务端已保存的穿透设置开关，不带上下面表单里还没保存的改动。
      setTunnel(await saveInstanceTunnel(instanceId, {
        enabled: next,
        endpointId: tunnel.endpointId,
        mode: tunnel.mode,
        ...(tunnel.mode === 'public' && tunnel.remotePort != null ? { remotePort: tunnel.remotePort } : {}),
        visitorBindPort: tunnel.visitorBindPort,
      }));
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveTunnel() {
    if (!draft) return;
    // 第一次保存（还没选定过服务器）就是「保存并开放」：用户已经看过表单里的端口和模式，不用再回顶部开开关。
    const openNow = !tunnel?.endpointId && Boolean(runtime?.installed);
    const remotePort = Number(draft.remotePort);
    const visitorBindPort = Number(draft.visitorBindPort);
    setBusy(true);
    setNotice('');
    try {
      // 之后开关单独保存；这里只改穿透设置，开没开沿用服务端当前状态。
      const saved = await saveInstanceTunnel(instanceId, {
        enabled: openNow || (tunnel?.enabled ?? false),
        endpointId: draft.endpointId,
        mode: draft.mode,
        ...(draft.mode === 'public' ? { remotePort } : {}),
        visitorBindPort,
      });
      setTunnel(saved);
      setDraft(tunnelDraft(saved, endpoints));
      if (openNow) setSettingsOpen(false);
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
      if (!await copyText(await friendText())) throw new Error(t('multiplayer.copyFailed'));
      showCopied(t('multiplayer.tunnel.copied'));
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

  async function upload(file: File) {
    setBusy(true);
    setUploading(true);
    try {
      setRuntime(await uploadFrpRuntime(file));
      setTunnel(await getInstanceTunnel(instanceId));
      setNotice(t('multiplayer.runtime.uploaded'));
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUploading(false);
      setBusy(false);
    }
  }

  const needsClient = Boolean(runtime?.platformSupported && !runtime.installed);
  const installed = Boolean(runtime?.installed);
  const serverIsNext = !needsClient && endpoints.length === 0;
  const hasEndpoints = Boolean(draft) && endpoints.length > 0;
  // 还没有服务器时直接展开添加表单；已有服务器时收起，点「添加 frp 服务器」才展开。
  const showEndpointForm = !hasEndpoints || adding;
  // 穿透设置还没保存过（没有选定服务器）时不显示开关，保存按钮就是「保存并开放」。
  const configured = Boolean(tunnel?.endpointId);
  // 第一次读取完成前不知道有没有 frp 服务器，两种排列都先不画，免得添加表单闪一下再换成穿透设置。
  const loading = tunnel === null && !error;

  const guideContent = (
    <>
      <h3>{t('multiplayer.guide.frp.modes')}</h3>
      <ul>
        <li>{t('multiplayer.guide.frp.public')}</li>
        <li>{t('multiplayer.guide.frp.stcp')}</li>
        <li>{t('multiplayer.guide.frp.xtcp')}</li>
      </ul>
    </>
  );

  // 公网端口模式玩家直接连地址，只有一步；STCP / XTCP 要先把玩家配置发过去。
  const joinSteps = tunnel && (tunnel.mode === 'public'
    ? [<JoinAddressStep address={tunnel.joinAddress} />]
    : [
      <>
        <p>{t('multiplayer.tunnel.step.send')}</p>
        <div className="instance-actions">
          <button className={installed ? 'btn btn-primary' : 'btn'} type="button" disabled={busy} onClick={() => void copyFriend()}>{t('multiplayer.tunnel.copy')}</button>
          <button className="btn" type="button" disabled={busy} onClick={() => void downloadFriend()}>{t('multiplayer.tunnel.friend')}</button>
        </div>
        <p className="field-help">{t('multiplayer.tunnel.friendHelp')}</p>
        <FlashNote text={copied} />
      </>,
      <p>{t('multiplayer.tunnel.step.run')}</p>,
      <JoinAddressStep address={tunnel.joinAddress} />,
    ]);

  // 穿透设置的字段：第一次直接展开在页面上，保存过以后放进折叠区。
  const settingsFields = draft && (
    <>
      <div className="field">
        <label htmlFor="frp-endpoint">{t('multiplayer.section.server')}</label>
        {/* 删除的是下拉框里选中的服务器，按钮放在它旁边。 */}
        <div className="remote-host-row">
          <select id="frp-endpoint" value={draft.endpointId} disabled={busy} onChange={(event) => setDraft({ ...draft, endpointId: event.target.value })}>
            {endpoints.map((endpoint) => (
              <option key={endpoint.id} value={endpoint.id}>{endpoint.name}</option>
            ))}
          </select>
          <button className="btn btn-plain is-danger" type="button" disabled={busy || draft.endpointId.length === 0} onClick={() => setConfirmDelete(true)}>
            {t('multiplayer.endpoint.delete')}
          </button>
        </div>
      </div>
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
      <div className="instance-actions">
        <button className={!configured && installed ? 'btn btn-primary' : 'btn'} type="button" disabled={busy || draft.endpointId.length === 0} onClick={() => void saveTunnel()}>
          {t(!configured && installed ? 'multiplayer.tunnel.saveOpen' : 'multiplayer.tunnel.save')}
        </button>
      </div>
    </>
  );

  const endpointForm = (
    <div className="card form-card">
      <div className="grid grid-2">
        <div className="field">
          <label htmlFor="frp-name">{t('multiplayer.endpoint.name')}</label>
          <input id="frp-name" value={endpointDraft.name} disabled={busy} onChange={(event) => setEndpointDraft({ ...endpointDraft, name: event.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="frp-visit">{t('multiplayer.endpoint.visitHost')}</label>
          <input id="frp-visit" value={endpointDraft.visitHost} disabled={busy} aria-describedby="frp-visit-help" onChange={(event) => setEndpointDraft({ ...endpointDraft, visitHost: event.target.value })} />
          <p className="field-help" id="frp-visit-help">{t('multiplayer.endpoint.visitHostHelp')}</p>
        </div>
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
      <div className="grid grid-2">
        <div className="field">
          <label htmlFor="frp-transport">{t('multiplayer.endpoint.transport')}</label>
          <select id="frp-transport" value={endpointDraft.transport} disabled={busy} onChange={(event) => setEndpointDraft({ ...endpointDraft, transport: event.target.value as EndpointDraft['transport'] })}>
            {FRP_TRANSPORTS.map((transport) => <option key={transport} value={transport}>{transport}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="frp-token">{t('multiplayer.endpoint.token')}</label>
          <input id="frp-token" type="password" autoComplete="off" value={endpointDraft.token} disabled={busy} onChange={(event) => setEndpointDraft({ ...endpointDraft, token: event.target.value })} />
        </div>
      </div>
      <label className="checkbox-field">
        <input type="checkbox" checked={endpointDraft.tls} disabled={busy} onChange={(event) => setEndpointDraft({ ...endpointDraft, tls: event.target.checked })} />
        <span>{t('multiplayer.endpoint.tls')}</span>
      </label>
      <div className="instance-actions">
        <button className={serverIsNext ? 'btn btn-primary' : 'btn'} type="button" disabled={busy} onClick={() => void saveEndpoint()}>
          {t('multiplayer.endpoint.save')}
        </button>
        {hasEndpoints && (
          <button className="btn btn-plain" type="button" disabled={busy} onClick={() => { setAdding(false); setEndpointDraft(EMPTY_ENDPOINT); }}>
            {t('action.cancel')}
          </button>
        )}
      </div>
    </div>
  );

  const endpointSection = (
    <section className="form-section">
      <h3 className="form-section-title">{t(hasEndpoints ? 'multiplayer.endpoint.add' : 'multiplayer.section.server')}</h3>
      {showEndpointForm ? endpointForm : (
        <div className="card form-card">
          <div className="instance-actions">
            <button className="btn" type="button" disabled={busy} onClick={() => setAdding(true)}>
              <Plus size={15} aria-hidden="true" />
              {t('multiplayer.endpoint.add')}
            </button>
          </div>
        </div>
      )}
    </section>
  );

  return (
    <MultiplayerLayout guide={guideContent} control={guide}>
      <p className="section-lead">{t('multiplayer.intro')}</p>
      {error && <p className="callout callout-danger" role="alert">{error}</p>}
      {notice && <p className="callout" role="status">{notice}</p>}
      {runtime && !runtime.platformSupported && (
        <p className="callout callout-danger" role="alert">{t('multiplayer.runtime.unsupported')}</p>
      )}
      {runtime?.platformSupported && !runtime.installed && (
        <RuntimeInstallCallout
          missing={t('multiplayer.runtime.missing')}
          installLabel={t('multiplayer.runtime.install')}
          archive={runtime.archive}
          busy={busy}
          uploading={uploading}
          onInstall={() => void install()}
          onUpload={upload}
        />
      )}
      {loading && <p className="field-help" role="status">{t('common.loading')}</p>}

      {!loading && !hasEndpoints && endpointSection}

      {hasEndpoints && tunnel && configured && (installed || tunnel.enabled) && (
        <OpenSwitch
          checked={tunnel.enabled}
          disabled={busy}
          status={tunnel.status !== 'disabled' && <StatusPill tone={statusTone(tunnel.status)}>{t(STATUS_KEY[tunnel.status])}</StatusPill>}
          onChange={(next) => void toggleTunnel(next)}
        />
      )}
      {hasEndpoints && tunnel?.detail && <p className="callout" role="status">{tm(tunnel.detail)}</p>}

      {hasEndpoints && tunnel?.enabled && joinSteps && <JoinSteps steps={joinSteps} />}

      {/* 第一次：穿透设置就是这一屏的主任务，直接展开；保存过以后收进折叠区，添加服务器也放在里面。 */}
      {hasEndpoints && !configured && (
        <section className="form-section">
          <h3 className="form-section-title">{t('multiplayer.section.access')}</h3>
          <div className="card form-card">{settingsFields}</div>
        </section>
      )}
      {hasEndpoints && !configured && endpointSection}
      {hasEndpoints && configured && (
        <details className="disclosure multiplayer-settings" open={settingsOpen ?? false} onToggle={(event) => setSettingsOpen(event.currentTarget.open)}>
          <summary>{t('multiplayer.section.access')}</summary>
          {settingsFields}
          {/* 添加服务器和上面的保存是两件事，单独成组，展开后有自己的标题。 */}
          <div className="multiplayer-add">
            {showEndpointForm ? (
              <section className="form-section">
                <h3 className="form-section-title">{t('multiplayer.endpoint.add')}</h3>
                {endpointForm}
              </section>
            ) : (
              <div className="instance-actions">
                <button className="btn" type="button" disabled={busy} onClick={() => setAdding(true)}>
                  <Plus size={15} aria-hidden="true" />
                  {t('multiplayer.endpoint.add')}
                </button>
              </div>
            )}
          </div>
        </details>
      )}

      {installed && runtime && (
        <div className="instance-meta multiplayer-meta">
          <span>{t('multiplayer.runtime.installed', { version: runtime.version })}</span>
        </div>
      )}

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
    </MultiplayerLayout>
  );
}
