import { useId, useRef, useState } from 'react';
import { Copy, ExternalLink, TriangleAlert } from 'lucide-react';
import {
  EASYTIER_VERSION,
  LAN_CUSTOM_PEER_LIMIT,
  type PanelNetworkJoinInfo,
  type PanelNetworkState,
  type PanelNetworkStatus,
} from '@mystry/shared';
import { getPanelNetworkJoinInfo, resetPanelNetworkSecret, savePanelNetwork } from '../api';
import { copyText } from '../clipboard';
import { errorMessage } from '../errors';
import { useI18n, type MessageKey } from '../i18n';
import { lanPeersIssue } from '../validation';
import { QrCode } from './QrCode';
import { StatusPill, type StatusTone } from './StatusPill';

const STATE_KEY: Record<PanelNetworkState, MessageKey> = {
  stopped: 'remoteAccess.net.state.stopped',
  installing: 'remoteAccess.net.state.installing',
  starting: 'remoteAccess.net.state.starting',
  running: 'remoteAccess.net.state.running',
  error: 'remoteAccess.net.state.error',
};

function stateTone(state: PanelNetworkState): StatusTone {
  if (state === 'running') return 'running';
  if (state === 'installing' || state === 'starting') return 'starting';
  if (state === 'error') return 'crashed';
  return 'stopped';
}

type Platform = 'android' | 'ios' | 'computer';
const PLATFORMS: readonly Platform[] = ['android', 'ios', 'computer'];
const PLATFORM_KEY: Record<Platform, MessageKey> = {
  android: 'remoteAccess.net.platform.android',
  ios: 'remoteAccess.net.platform.ios',
  computer: 'remoteAccess.net.platform.computer',
};

const CONNECTION_KEY = {
  direct: 'remoteAccess.net.devices.direct',
  relay: 'remoteAccess.net.devices.relay',
  unknown: 'remoteAccess.net.devices.unknown',
} as const satisfies Record<string, MessageKey>;

/** One peer per line in the text box; blank lines are ignored, and the format is validated by the server. */
function parsePeers(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}

/** The secret is displayed in groups of 4 characters so it is easy to type by reading; what is copied is still the original without spaces. */
function groupSecret(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, '$1 ');
}

/** The equivalent command line for another computer. The whitelist keeps only one unused port, so that computer cannot be accessed by devices on the same network. */
function joinCommand(join: PanelNetworkJoinInfo): string {
  return [
    'easytier-core',
    '--dhcp',
    `--network-name "${join.networkName}"`,
    `--network-secret "${join.networkSecret}"`,
    '--no-listener=true',
    '--private-mode=true',
    '--tcp-whitelist 1',
    '--udp-whitelist 1',
    '--rpc-portal 0',
    ...join.peers.map((peer) => `--peers ${peer}`),
  ].join(' ');
}

/**
 * The panel's built-in EasyTier network: enable it, let devices join, scan to open the panel, and see joined devices.
 * The network name and secret are not in the status, and are requested only when the user clicks "Show join info".
 */
export function RemotePanelNetwork({
  network,
  onNetwork,
}: {
  network: PanelNetworkStatus;
  onNetwork: (next: PanelNetworkStatus) => void;
}) {
  const { t, tm } = useI18n();
  const peersId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [platform, setPlatform] = useState<Platform>('android');
  const [join, setJoin] = useState<PanelNetworkJoinInfo | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [peersText, setPeersText] = useState(network.customPeers.join('\n'));
  const [useShared, setUseShared] = useState(network.useSharedPeers);
  const peersTouched = useRef(false);

  const peers = parsePeers(peersText);
  const tooManyPeers = peers.length > LAN_CUSTOM_PEER_LIMIT;
  const noPeers = !useShared && peers.length === 0;
  const peersIssue = lanPeersIssue(peers);
  // "Enable" uses the saved peer settings, not the unsaved draft below, so whether it can be enabled is decided by what is saved.
  const savedNoPeers = !network.useSharedPeers && network.customPeers.length === 0;

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const toggle = (enabled: boolean) => run(async () => {
    onNetwork(await savePanelNetwork({ enabled }));
    if (!enabled) setJoin(null);
  });

  const savePeers = () => run(async () => {
    onNetwork(await savePanelNetwork({ enabled: network.enabled, customPeers: peers, useSharedPeers: useShared }));
    peersTouched.current = false;
    // The peers changed, so join info already displayed is void.
    setJoin(null);
    setNotice(t('remoteAccess.net.peers.saved'));
  });

  const reset = () => run(async () => {
    onNetwork(await resetPanelNetworkSecret());
    setConfirmReset(false);
    setJoin(null);
    setNotice(t('remoteAccess.net.reset.done'));
  });

  const showJoin = () => run(async () => {
    setJoin(await getPanelNetworkJoinInfo());
  });

  async function copy(text: string): Promise<void> {
    // The secret is not echoed in the notice.
    setNotice(await copyText(text) ? t('remoteAccess.copied', { text: text.length > 48 ? `${text.slice(0, 24)}…` : text }) : t('remoteAccess.copyFailed'));
  }

  if (!network.platformSupported) {
    return (
      <div className="remote-section">
        <p className="section-lead">{t('remoteAccess.net.lead')}</p>
        <p className="callout callout-warning">{t('remoteAccess.net.unsupported')}</p>
      </div>
    );
  }

  const joinText = join
    ? [
        `${t('remoteAccess.net.join.name')}: ${join.networkName}`,
        `${t('remoteAccess.net.join.secret')}: ${join.networkSecret}`,
        `${t('remoteAccess.net.join.peers')}: ${join.peers.join(', ')}`,
      ].join('\n')
    : '';

  const copyRow = (label: string, shown: string, value: string) => (
    <li className="list-row remote-url-row">
      <div className="list-row-text">
        <span className="list-row-desc">{label}</span>
        <code className="remote-join-value">{shown}</code>
      </div>
      <div className="list-row-control">
        <button className="btn btn-sm" type="button" aria-label={`${t('action.copy')} ${label}`} onClick={() => void copy(value)}>
          <Copy size={13} aria-hidden="true" />
          {t('action.copy')}
        </button>
      </div>
    </li>
  );

  return (
    <div className="remote-section">
      <p className="section-lead">{t('remoteAccess.net.lead')}</p>
      <p className="field-help">{t('remoteAccess.net.separate')}</p>

      <div className="instance-meta">
        <StatusPill tone={stateTone(network.state)}>{t(STATE_KEY[network.state])}</StatusPill>
        {!network.installed && !network.enabled && <span className="field-help">{t('remoteAccess.net.firstTime')}</span>}
      </div>
      {network.detail && <p className="callout callout-warning" role="status">{tm(network.detail)}</p>}
      {network.enabled && network.firewall === 'failed' && (
        <div className="callout callout-warning">
          <TriangleAlert size={18} aria-hidden="true" className="callout-icon" />
          <p>{t('remoteAccess.net.firewallFailed')}</p>
        </div>
      )}
      {error && <p className="callout callout-danger" role="alert">{error}</p>}
      <p role="status" aria-live="polite" className="field-help remote-notice">{notice}</p>

      <div className="instance-actions">
        {network.enabled ? (
          <button className="btn" type="button" disabled={busy} onClick={() => void toggle(false)}>
            {busy ? t('remoteAccess.action.working') : t('remoteAccess.action.turnOff')}
          </button>
        ) : (
          <>
            <button className="btn btn-primary" type="button" disabled={busy || savedNoPeers} onClick={() => void toggle(true)}>
              {busy ? t('remoteAccess.action.working') : t('remoteAccess.action.turnOn')}
            </button>
            {/* Peer settings are in the collapsed advanced section, so when the button is disabled the reason is given beside it. */}
            {savedNoPeers && <span className="field-help">{t('remoteAccess.net.peers.required')}</span>}
          </>
        )}
      </div>

      {network.enabled && (
        <section className="remote-step">
          <h3 className="remote-subtitle">{t('remoteAccess.net.step.join')}</h3>
          <div className="segmented" role="group" aria-label={t('remoteAccess.net.platform.label')}>
            {PLATFORMS.map((item) => (
              <button
                key={item}
                type="button"
                className={`segmented-item${platform === item ? ' active' : ''}`}
                aria-pressed={platform === item}
                onClick={() => setPlatform(item)}
              >
                {t(PLATFORM_KEY[item])}
              </button>
            ))}
          </div>
          {platform === 'ios' ? (
            <p className="callout callout-info">{t('remoteAccess.net.ios')}</p>
          ) : (
            <>
              {platform === 'android' ? (
                <>
                  <p className="field-help">{t('remoteAccess.net.android.install', { version: EASYTIER_VERSION })}</p>
                  <p className="field-help">{t('remoteAccess.net.android.setup')}</p>
                </>
              ) : (
                <p className="field-help">{t('remoteAccess.net.computer.setup', { version: EASYTIER_VERSION })}</p>
              )}
              {join ? (
                <>
                  {platform === 'android' && (
                    <p className="field-help">
                      <a href={join.androidDownloadUrl} target="_blank" rel="noreferrer noopener">
                        {t('remoteAccess.net.android.download')}
                        <ExternalLink size={12} aria-hidden="true" />
                      </a>
                    </p>
                  )}
                  <ul className="list-group remote-url-list">
                    {copyRow(t('remoteAccess.net.join.name'), join.networkName, join.networkName)}
                    {copyRow(t('remoteAccess.net.join.secret'), groupSecret(join.networkSecret), join.networkSecret)}
                    {join.peers.map((peer) => (
                      <li key={peer} className="list-row remote-url-row">
                        <div className="list-row-text">
                          <span className="list-row-desc">{t('remoteAccess.net.join.peers')}</span>
                          <code className="remote-join-value">{peer}</code>
                        </div>
                        <div className="list-row-control">
                          <button className="btn btn-sm" type="button" aria-label={`${t('action.copy')} ${peer}`} onClick={() => void copy(peer)}>
                            <Copy size={13} aria-hidden="true" />
                            {t('action.copy')}
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                  {platform === 'android' ? (
                    <div className="remote-qr">
                      <QrCode value={joinText} label={t('remoteAccess.net.join.qrLabel')} />
                      <div className="remote-qr-text">
                        <p className="field-help">{t('remoteAccess.net.join.qrHelp')}</p>
                      </div>
                    </div>
                  ) : (
                    <>
                      <code className="remote-command">{joinCommand(join)}</code>
                      <div className="instance-actions">
                        <button className="btn btn-sm" type="button" onClick={() => void copy(joinCommand(join))}>
                          <Copy size={13} aria-hidden="true" />
                          {t('remoteAccess.net.join.copyCommand')}
                        </button>
                      </div>
                    </>
                  )}
                  <p className="field-warn">{t('remoteAccess.net.join.secretNote')}</p>
                  <div className="instance-actions">
                    <button className="btn btn-sm" type="button" onClick={() => setJoin(null)}>
                      {t('remoteAccess.net.join.hide')}
                    </button>
                  </div>
                </>
              ) : (
                <div className="instance-actions">
                  <button className="btn" type="button" disabled={busy} onClick={() => void showJoin()}>
                    {t('remoteAccess.net.join.show')}
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {network.enabled && network.url && (
        <section className="remote-step">
          <h3 className="remote-subtitle">{t('remoteAccess.net.step.open')}</h3>
          <div className="remote-qr">
            <QrCode value={network.url} label={t('remoteAccess.qr.label', { url: network.url })} />
            <div className="remote-qr-text">
              <code className="remote-qr-url">{network.url}</code>
              <p className="field-help">{t('remoteAccess.net.open.wait')}</p>
              <div className="instance-actions">
                <button
                  className="btn btn-sm"
                  type="button"
                  aria-label={t('remoteAccess.urls.copyAria', { url: network.url })}
                  onClick={() => void copy(network.url ?? '')}
                >
                  <Copy size={13} aria-hidden="true" />
                  {t('action.copy')}
                </button>
              </div>
            </div>
          </div>
        </section>
      )}

      {network.enabled && network.state === 'running' && (
        <section className="remote-step">
          <h3 className="remote-subtitle">{t('remoteAccess.net.step.devices')}</h3>
          {network.devices.length === 0 ? (
            <p className="field-help">{t('remoteAccess.net.devices.empty')}</p>
          ) : (
            <>
              <ul className="list-group remote-url-list">
                {network.devices.map((device) => (
                  <li key={`${device.virtualIp ?? ''}-${device.hostname}`} className="list-row">
                    <div className="list-row-text">
                      <span className="list-row-title">{device.hostname || t('remoteAccess.net.devices.unnamed')}</span>
                      <span className="list-row-desc">{device.virtualIp ?? ''}</span>
                    </div>
                    <span className="list-row-value">{t(CONNECTION_KEY[device.connection])}</span>
                  </li>
                ))}
              </ul>
              <p className="field-help">{t('remoteAccess.net.devices.unfamiliar')}</p>
            </>
          )}
        </section>
      )}

      <details className="disclosure remote-advanced">
        <summary>{t('remoteAccess.net.advanced')}</summary>
        <div className="field">
          <label htmlFor={peersId}>{t('remoteAccess.net.peers.label')}</label>
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
            {t('remoteAccess.net.peers.help', { limit: LAN_CUSTOM_PEER_LIMIT })}
          </p>
          {tooManyPeers && <p className="error" role="alert">{t('remoteAccess.net.peers.tooMany', { limit: LAN_CUSTOM_PEER_LIMIT })}</p>}
          {peersIssue && <p className="error">{t(peersIssue.key, peersIssue.params)}</p>}
        </div>
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={useShared}
            disabled={busy}
            onChange={(event) => { peersTouched.current = true; setUseShared(event.target.checked); }}
          />
          <span>{t('remoteAccess.net.peers.shared')}</span>
        </label>
        <p className="field-help">
          {t('remoteAccess.net.peers.sharedHelp')}{' '}
          {network.sharedPeers.map((peer, index) => (
            <span key={peer}>
              {index > 0 && ', '}
              <code>{peer}</code>
            </span>
          ))}
        </p>
        {noPeers && <p className="error" role="alert">{t('remoteAccess.net.peers.required')}</p>}
        <div className="instance-actions">
          <button className="btn" type="button" disabled={busy || tooManyPeers || noPeers || peersIssue !== null} onClick={() => void savePeers()}>
            {t('remoteAccess.net.peers.save')}
          </button>
        </div>
        {network.enabled && (
          confirmReset ? (
            <div className="callout callout-warning">
              <p>{t('remoteAccess.net.reset.confirm')}</p>
              <div className="instance-actions">
                <button className="btn btn-destructive btn-sm" type="button" disabled={busy} onClick={() => void reset()}>
                  {t('remoteAccess.net.reset.yes')}
                </button>
                <button className="btn btn-sm" type="button" disabled={busy} onClick={() => setConfirmReset(false)}>
                  {t('action.cancel')}
                </button>
              </div>
            </div>
          ) : (
            <div className="instance-actions">
              <button className="btn btn-sm" type="button" disabled={busy} onClick={() => setConfirmReset(true)}>
                {t('remoteAccess.net.reset')}
              </button>
            </div>
          )
        )}
      </details>
    </div>
  );
}
