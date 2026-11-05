import { useCallback, useRef, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import type { InstanceLan, LanRuntimeInfo, LanStatus } from '@mystry/shared';
import { StatusPill, type StatusTone } from './StatusPill';
import {
  fetchFriendLanInstructions,
  getInstanceLan,
  getLanRuntime,
  installLanRuntime,
  saveInstanceLan,
} from '../api';
import { DownloadSourceHint } from './DownloadSourceSection';
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

/** 实例虚拟局域网。只开关官方 EasyTier，不提供原始配置或可执行路径。 */
export function LanSection({ instanceId }: { instanceId: string }) {
  const { t, tm } = useI18n();
  const [runtime, setRuntime] = useState<LanRuntimeInfo | null>(null);
  const [lan, setLan] = useState<InstanceLan | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const enabledTouched = useRef(false);

  const load = useCallback(async () => {
    const [nextRuntime, nextLan] = await Promise.all([
      getLanRuntime(),
      getInstanceLan(instanceId),
    ]);
    setRuntime(nextRuntime);
    setLan(nextLan);
    if (!enabledTouched.current) setEnabled(nextLan.enabled);
  }, [instanceId]);

  const refresh = useCallback(() => {
    void load().catch((err: unknown) => setError(errorMessage(err)));
  }, [load]);

  usePolling(refresh, lan?.status === 'starting' ? 2000 : 5000);

  async function save() {
    setBusy(true);
    try {
      const saved = await saveInstanceLan(instanceId, { enabled });
      setLan(saved);
      enabledTouched.current = false;
      setEnabled(saved.enabled);
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
      setLan(await getInstanceLan(instanceId));
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function friendText(): Promise<string> {
    return fetchFriendLanInstructions(instanceId);
  }

  async function copyFriend() {
    setBusy(true);
    try {
      await navigator.clipboard.writeText(await friendText());
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
      {runtime?.installed && (
        <p className="field-help">{t('multiplayer.lan.runtime.installed', { version: runtime.version })}</p>
      )}
      <div className="card form-card">
        <label className="checkbox-field">
          <input type="checkbox" checked={enabled} disabled={busy} onChange={(event) => { enabledTouched.current = true; setEnabled(event.target.checked); }} />
          <span>{t('multiplayer.lan.enable')}</span>
        </label>
        <p className="field-help">{t('multiplayer.lan.admin')}</p>
        <div className="callout callout-warning">
          <TriangleAlert size={18} aria-hidden="true" className="callout-icon" />
          <p>{t('multiplayer.lan.trust')}</p>
        </div>
        {lan?.detail && <p className="callout" role="status">{tm(lan.detail)}</p>}
        {lan && (
          <div className="instance-meta">
            <StatusPill tone={statusTone(lan.status)}>{t(STATUS_KEY[lan.status])}</StatusPill>
            {lan.joinAddress && <span>{t('multiplayer.lan.join', { address: lan.joinAddress })}</span>}
          </div>
        )}
        <div className="instance-actions">
          <button className={runtime?.platformSupported && !runtime.installed ? 'btn' : 'btn btn-primary'} type="button" disabled={busy} onClick={() => void save()}>
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
