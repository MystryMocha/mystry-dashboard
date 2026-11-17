import { useCallback, useId, useRef, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { LAN_CUSTOM_PEER_LIMIT, type InstanceLan, type LanRuntimeInfo, type LanStatus } from '@mystry/shared';
import { StatusPill, type StatusTone } from './StatusPill';
import { RuntimeArchiveUpload } from './RuntimeArchiveUpload';
import {
  fetchFriendLanInstructions,
  getInstanceLan,
  getLanRuntime,
  installLanRuntime,
  saveInstanceLan,
  uploadLanRuntime,
} from '../api';
import { DownloadSourceHint } from './DownloadSourceSection';
import { copyText } from '../clipboard';
import { errorMessage } from '../errors';
import { usePolling } from '../hooks/usePolling';
import { useI18n, type MessageKey } from '../i18n';

const STATUS_KEY: Record<LanStatus, MessageKey> = {
  disabled: 'multiplayer.status.disabled',
  stopped: 'multiplayer.status.stopped',
  starting: 'multiplayer.status.starting',
  running: 'multiplayer.status.running',
  error: 'multiplayer.status.error',
};

function statusTone(status: LanStatus): StatusTone {
  if (status === 'running') return 'running';
  if (status === 'starting') return 'starting';
  if (status === 'error') return 'crashed';
  return 'stopped';
}

/** 文本框里一行一个节点；空行忽略，格式由服务端校验。 */
function parsePeers(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}

/** 实例虚拟局域网。只开关官方 EasyTier 和中继节点，不提供原始配置或可执行路径。 */
export function LanSection({ instanceId }: { instanceId: string }) {
  const { t, tm } = useI18n();
  const peersId = useId();
  const [runtime, setRuntime] = useState<LanRuntimeInfo | null>(null);
  const [lan, setLan] = useState<InstanceLan | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [peersText, setPeersText] = useState('');
  const [useSharedPeers, setUseSharedPeers] = useState(true);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // 用户改过的字段不被轮询结果覆盖，保存后才重新跟随服务端。
  const enabledTouched = useRef(false);
  const peersTouched = useRef(false);

  const apply = useCallback((next: InstanceLan) => {
    setLan(next);
    if (!enabledTouched.current) setEnabled(next.enabled);
    if (!peersTouched.current) {
      setPeersText(next.peers.join('\n'));
      setUseSharedPeers(next.useSharedPeers);
    }
  }, []);

  const load = useCallback(async () => {
    const [nextRuntime, nextLan] = await Promise.all([
      getLanRuntime(),
      getInstanceLan(instanceId),
    ]);
    setRuntime(nextRuntime);
    apply(nextLan);
  }, [apply, instanceId]);

  const refresh = useCallback(() => {
    void load().catch((err: unknown) => setError(errorMessage(err)));
  }, [load]);

  usePolling(refresh, lan?.status === 'starting' ? 2000 : 5000);

  const peers = parsePeers(peersText);
  const tooManyPeers = peers.length > LAN_CUSTOM_PEER_LIMIT;

  async function save() {
    setBusy(true);
    try {
      const saved = await saveInstanceLan(instanceId, { enabled, peers, useSharedPeers });
      enabledTouched.current = false;
      peersTouched.current = false;
      apply(saved);
      setNotice(t('multiplayer.lan.saved'));
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
      setRuntime(await installLanRuntime());
      apply(await getInstanceLan(instanceId));
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
      setRuntime(await uploadLanRuntime(file));
      apply(await getInstanceLan(instanceId));
      setNotice(t('multiplayer.runtime.uploaded'));
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUploading(false);
      setBusy(false);
    }
  }

  async function friendText(): Promise<string> {
    return fetchFriendLanInstructions(instanceId);
  }

  async function copyFriend() {
    setBusy(true);
    try {
      if (!await copyText(await friendText())) throw new Error(t('multiplayer.copyFailed'));
      setNotice(t('multiplayer.lan.copied'));
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
      const blob = new Blob([await friendText()], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'friend-easytier.txt';
      link.click();
      URL.revokeObjectURL(url);
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="form-section">
      <p className="section-lead">{t('multiplayer.lan.intro')}</p>
      {error && <p className="callout callout-danger" role="alert">{error}</p>}
      {notice && <p className="callout">{notice}</p>}
      {runtime && !runtime.platformSupported && (
        <p className="callout callout-danger" role="alert">{t('multiplayer.lan.runtime.unsupported')}</p>
      )}
      {runtime?.platformSupported && !runtime.installed && (
        <div className="callout">
          <p>{t('multiplayer.lan.runtime.missing')}</p>
          <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void install()}>
            {t('multiplayer.lan.runtime.install')}
          </button>
          <DownloadSourceHint />
        </div>
      )}
      {runtime?.platformSupported && !runtime.installed && runtime.archive && (
        <RuntimeArchiveUpload archive={runtime.archive} busy={busy} uploading={uploading} onUpload={upload} />
      )}
      {runtime?.installed && (
        <p className="field-help">{t('multiplayer.lan.runtime.installed', { version: runtime.version })}</p>
      )}
      <div className="card form-card">
        <label className="checkbox-field">
          <input type="checkbox" checked={enabled} disabled={busy} onChange={(event) => { enabledTouched.current = true; setEnabled(event.target.checked); }} />
          <span>{t('multiplayer.lan.enable')}</span>
        </label>
        <p className="field-help">{t('multiplayer.lan.admin')}</p>
        <p className="field-help">{t('multiplayer.lan.firewall')}</p>
        <div className="callout callout-warning">
          <TriangleAlert size={18} aria-hidden="true" className="callout-icon" />
          <p>{t('multiplayer.lan.trust')}</p>
        </div>

        <div className="field">
          <label htmlFor={peersId}>{t('multiplayer.lan.peers.label')}</label>
          <textarea
            id={peersId}
            className="mono"
            rows={3}
            value={peersText}
            disabled={busy}
            placeholder="tcp://relay.example.com:11010"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-describedby={`${peersId}-help`}
            onChange={(event) => { peersTouched.current = true; setPeersText(event.target.value); }}
          />
          <p id={`${peersId}-help`} className="field-help">
            {t('multiplayer.lan.peers.help', { limit: LAN_CUSTOM_PEER_LIMIT })}
          </p>
          {tooManyPeers && (
            <p className="error" role="alert">
              {t('multiplayer.lan.peers.tooMany', { limit: LAN_CUSTOM_PEER_LIMIT })}
            </p>
          )}
        </div>
        <label className="checkbox-field">
          <input type="checkbox" checked={useSharedPeers} disabled={busy} onChange={(event) => { peersTouched.current = true; setUseSharedPeers(event.target.checked); }} />
          <span>{t('multiplayer.lan.peers.shared')}</span>
        </label>
        {lan && (
          <p className="field-help">
            {t('multiplayer.lan.peers.sharedHelp')}{' '}
            {lan.sharedPeers.map((peer, index) => (
              <span key={peer}>
                {index > 0 && ', '}
                <code>{peer}</code>
              </span>
            ))}
          </p>
        )}
        {!useSharedPeers && peers.length === 0 && (
          <p className="error" role="alert">{t('multiplayer.lan.peers.required')}</p>
        )}

        {lan?.detail && <p className="callout" role="status">{tm(lan.detail)}</p>}
        {lan?.warning && (
          <div className="callout callout-warning" role="status">
            <TriangleAlert size={18} aria-hidden="true" className="callout-icon" />
            <p>{tm(lan.warning)}</p>
          </div>
        )}
        {lan && (
          <div className="instance-meta">
            <StatusPill tone={statusTone(lan.status)}>{t(STATUS_KEY[lan.status])}</StatusPill>
            {lan.joinAddress && <span>{t('multiplayer.lan.join', { address: lan.joinAddress })}</span>}
          </div>
        )}
        {lan?.listenPort && lan.status === 'running' && (
          <p className="field-help">{t('multiplayer.lan.direct', { port: lan.listenPort })}</p>
        )}
        <div className="instance-actions">
          <button
            className={runtime?.platformSupported && !runtime.installed ? 'btn' : 'btn btn-primary'}
            type="button"
            disabled={busy || tooManyPeers || (!useSharedPeers && peers.length === 0)}
            onClick={() => void save()}
          >
            {t('multiplayer.lan.save')}
          </button>
          {lan?.enabled && (
            <>
              <button className="btn" type="button" disabled={busy} onClick={() => void copyFriend()}>{t('multiplayer.lan.copy')}</button>
              <button className="btn" type="button" disabled={busy} onClick={() => void downloadFriend()}>{t('multiplayer.lan.friend')}</button>
            </>
          )}
        </div>
        {lan?.enabled && <p className="field-help">{t('multiplayer.lan.friendHelp')}</p>}
      </div>
    </section>
  );
}
