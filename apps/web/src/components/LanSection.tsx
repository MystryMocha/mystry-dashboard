import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { LAN_CUSTOM_PEER_LIMIT, type InstanceLan, type LanRuntimeInfo, type LanStatus } from '@mystry/shared';
import { StatusPill, type StatusTone } from './StatusPill';
import { RuntimeInstallCallout } from './RuntimeArchiveUpload';
import { FlashNote, JoinAddressStep, JoinSteps, MultiplayerLayout, OpenSwitch, useFlash, type GuideControl } from './MultiplayerLayout';
import {
  fetchFriendLanInstructions,
  getInstanceLan,
  getLanRuntime,
  installLanRuntime,
  saveInstanceLan,
  uploadLanRuntime,
} from '../api';
import { copyText } from '../clipboard';
import { errorMessage } from '../errors';
import { usePolling } from '../hooks/usePolling';
import { useI18n, type MessageKey } from '../i18n';
import { lanPeersIssue } from '../validation';

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

/** One peer per line in the text box; blank lines are ignored, and the format is validated by the server. */
function parsePeers(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}

/**
 * Instance virtual LAN. Only toggles the official EasyTier and relay peers; raw config or executable paths are not offered.
 * Main column order: install → switch (takes effect immediately) → let players join (three steps) → relay peers (collapsed by default) → direct connection port and version.
 * The switch and relay peers are saved separately: the switch carries the peers saved on the server, and saving peers carries the server's current switch state, so neither overwrites the other.
 */
export function LanSection({ instanceId, guide }: { instanceId: string; guide: GuideControl }) {
  const { t, tm } = useI18n();
  const peersId = useId();
  const [runtime, setRuntime] = useState<LanRuntimeInfo | null>(null);
  const [lan, setLan] = useState<InstanceLan | null>(null);
  const [peersText, setPeersText] = useState('');
  const [useSharedPeers, setUseSharedPeers] = useState(true);
  const [relayOpen, setRelayOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // The result of copying the join instructions / player config is shown below the button.
  const [copied, showCopied] = useFlash();
  // Relay peers the user has edited are not overwritten by polling results, and follow the server again only after saving.
  const peersTouched = useRef(false);
  const relayInitialized = useRef(false);

  const apply = useCallback((next: InstanceLan) => {
    setLan(next);
    if (!peersTouched.current) {
      setPeersText(next.peers.join('\n'));
      setUseSharedPeers(next.useSharedPeers);
    }
  }, []);

  // When relay peers have been changed (own peers entered, or community peers turned off) it is expanded by default, so a collapsed area does not hide settings already in effect.
  useEffect(() => {
    if (!lan || relayInitialized.current) return;
    relayInitialized.current = true;
    setRelayOpen(lan.peers.length > 0 || !lan.useSharedPeers);
  }, [lan]);

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
  // The peer format matches the server; when non-compliant the save button is disabled and the offending one is pointed out.
  const peersIssue = lanPeersIssue(peers);

  async function toggle(next: boolean) {
    if (!lan) return;
    setBusy(true);
    setNotice('');
    try {
      apply(await saveInstanceLan(instanceId, { enabled: next, peers: lan.peers, useSharedPeers: lan.useSharedPeers }));
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function savePeers() {
    if (!lan) return;
    setBusy(true);
    try {
      const saved = await saveInstanceLan(instanceId, { enabled: lan.enabled, peers, useSharedPeers });
      peersTouched.current = false;
      apply(saved);
      // Peers are written into the join instructions, so a change while it is on means they have to be sent again.
      setNotice(t(saved.enabled ? 'multiplayer.lan.peers.savedResend' : 'multiplayer.lan.peers.saved'));
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
      showCopied(t('multiplayer.lan.copied'));
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

  const installed = Boolean(runtime?.installed);
  const ready = installed || Boolean(lan?.enabled);
  const needsAdmin = Boolean(runtime?.needsAdmin);
  // Without administrator rights EasyTier never gets its adapter, and EasyTier only starts with the game, so a stopped server would still look fine.
  // Until it actually runs, the join steps would only hand players instructions that cannot work.
  const canInvite = Boolean(lan?.enabled) && lan?.status !== 'error' && !(needsAdmin && lan?.status !== 'running');
  // The warning above already says what to do, so the same failure from the client is not repeated below the switch.
  const detail = lan?.detail && !(needsAdmin && lan.detail.key === 'server.lan.needsAdminWindows') ? lan.detail : null;
  const guideContent = (
    <>
      <h3>{t('multiplayer.guide.troubleshoot')}</h3>
      <ul>
        <li>{t('multiplayer.lan.firewall')}</li>
        <li>{t('multiplayer.guide.lan.relay')}</li>
      </ul>
    </>
  );

  return (
    <MultiplayerLayout guide={guideContent} control={guide}>
      <p className="section-lead">{t('multiplayer.lan.intro')}</p>
      {error && <p className="callout callout-danger" role="alert">{error}</p>}
      {notice && <p className="callout" role="status">{notice}</p>}
      {needsAdmin && (
        <div className="callout callout-warning" role="status">
          <TriangleAlert size={18} aria-hidden="true" className="callout-icon" />
          <p>{t('multiplayer.lan.adminRequired')}</p>
        </div>
      )}
      {runtime && !runtime.platformSupported && (
        <p className="callout callout-danger" role="alert">{t('multiplayer.lan.runtime.unsupported')}</p>
      )}
      {runtime?.platformSupported && !runtime.installed && (
        <RuntimeInstallCallout
          missing={t('multiplayer.lan.runtime.missing')}
          installLabel={t('multiplayer.lan.runtime.install')}
          archive={runtime.archive}
          busy={busy}
          uploading={uploading}
          onInstall={() => void install()}
          onUpload={upload}
        />
      )}

      {/* Without EasyTier installed only the install prompt is left, and the switch and relay peers appear once it is installed; one that is already on can still be turned off. */}
      {lan && ready && (
        <OpenSwitch
          checked={lan.enabled}
          disabled={busy}
          status={lan.status !== 'disabled' && <StatusPill tone={statusTone(lan.status)}>{t(STATUS_KEY[lan.status])}</StatusPill>}
          description={t('multiplayer.lan.admin')}
          onChange={(next) => void toggle(next)}
        />
      )}
      {detail && (lan?.status === 'error'
        ? <p className="callout callout-danger" role="alert">{tm(detail)}</p>
        : <p className="callout" role="status">{tm(detail)}</p>)}
      {lan?.warning && (
        <div className="callout callout-warning" role="status">
          <TriangleAlert size={18} aria-hidden="true" className="callout-icon" />
          <p>{tm(lan.warning)}</p>
        </div>
      )}

      {lan && canInvite && (
        <JoinSteps
          steps={[
            <>
              <p>{t('multiplayer.lan.step.send')}</p>
              <div className="instance-actions">
                <button className={installed ? 'btn btn-primary' : 'btn'} type="button" disabled={busy} onClick={() => void copyFriend()}>{t('multiplayer.lan.copy')}</button>
                <button className="btn" type="button" disabled={busy} onClick={() => void downloadFriend()}>{t('multiplayer.lan.friend')}</button>
              </div>
              <p className="field-help">{t('multiplayer.lan.friendHelp')}</p>
              <FlashNote text={copied} />
            </>,
            <p>{t('multiplayer.lan.step.run')}</p>,
            <JoinAddressStep address={lan.joinAddress} />,
          ]}
        />
      )}

      {lan && ready && (
        <details className="disclosure multiplayer-relay" open={relayOpen} onToggle={(event) => setRelayOpen(event.currentTarget.open)}>
          <summary>{t('multiplayer.lan.peers.title')}</summary>
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
            {peersIssue && <p className="error">{t(peersIssue.key, peersIssue.params)}</p>}
          </div>
          <label className="checkbox-field">
            <input type="checkbox" checked={useSharedPeers} disabled={busy} onChange={(event) => { peersTouched.current = true; setUseSharedPeers(event.target.checked); }} />
            <span>{t('multiplayer.lan.peers.shared')}</span>
          </label>
          <p className="field-help">
            {t('multiplayer.lan.peers.sharedHelp')}{' '}
            {lan.sharedPeers.map((peer, index) => (
              <span key={peer}>
                {index > 0 && ', '}
                <code>{peer}</code>
              </span>
            ))}
          </p>
          {!useSharedPeers && peers.length === 0 && (
            <p className="error" role="alert">{t('multiplayer.lan.peers.required')}</p>
          )}
          <div className="instance-actions">
            <button
              className="btn"
              type="button"
              disabled={busy || tooManyPeers || peersIssue !== null || (!useSharedPeers && peers.length === 0)}
              onClick={() => void savePeers()}
            >
              {t('multiplayer.lan.peers.save')}
            </button>
          </div>
        </details>
      )}

      {lan && (installed || (lan.listenPort && lan.status === 'running')) && (
        <div className="instance-meta multiplayer-meta">
          {lan.listenPort && lan.status === 'running' && <span>{t('multiplayer.lan.direct', { port: lan.listenPort })}</span>}
          {runtime?.installed && <span>{t('multiplayer.lan.runtime.installed', { version: runtime.version })}</span>}
        </div>
      )}
    </MultiplayerLayout>
  );
}
