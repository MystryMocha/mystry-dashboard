import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Copy, Play } from 'lucide-react';
import type { InstanceInfo, InstanceLocalNetwork } from '@mystry/shared';
import { controlInstance, getInstanceLocalNetwork, savePublicHost } from '../api';
import { copyText } from '../clipboard';
import { MultiplayerLayout, type GuideControl } from './MultiplayerLayout';
import { errorMessage } from '../errors';
import { usePolling } from '../hooks/usePolling';
import { useI18n } from '../i18n';
import { canStartInstance } from '../instance-status';
import { publicHostIssue } from '../validation';

function isPrivateHost(host: string): boolean {
  return /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(host) || host === 'localhost';
}

/**
 * Direct connection: when friends are on the same network as this computer they use the LAN address; when this computer has a public IP (cloud server, data center),
 * friends join directly with "public address:game port". When this computer has a public IPv6, another address to try is given as well.
 * Only addresses, the port and a checklist are shown; nothing is installed and no server config is changed; the public address is entered by the user and not auto-detected.
 * The main column holds addresses and notices that must be handled; troubleshooting, the public network checklist and IPv6 router notes go in the guide column on the right.
 */
export function DirectSection({
  instance,
  guide,
  onChooseVirtualLan,
  onInstanceChanged,
}: {
  instance: InstanceInfo;
  guide: GuideControl;
  onChooseVirtualLan: () => void;
  /** Called after an instance is started from here, so the page re-reads the instance status. */
  onInstanceChanged: () => Promise<void> | void;
}) {
  const { t } = useI18n();
  const hostId = useId();
  const [network, setNetwork] = useState<InstanceLocalNetwork | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [hostDraft, setHostDraft] = useState('');
  const [hostOpen, setHostOpen] = useState(false);
  const [hostBusy, setHostBusy] = useState(false);
  const [hostError, setHostError] = useState('');
  const [startBusy, setStartBusy] = useState(false);
  const [startError, setStartError] = useState('');
  const hostTouched = useRef(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await getInstanceLocalNetwork(instance.id);
      setNetwork(next);
      // While the user is typing, polling results do not overwrite the input.
      if (!hostTouched.current) setHostDraft(next.publicHost ?? '');
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [instance.id]);
  usePolling(load, 10_000);

  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);

  function showNotice(text: string) {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(text);
    noticeTimer.current = setTimeout(() => setNotice(''), 6000);
  }

  async function copy(address: string) {
    showNotice(await copyText(address) ? t('multiplayer.direct.copied', { address }) : t('multiplayer.direct.copyFailed'));
  }

  async function saveHost(host: string | null) {
    setHostBusy(true);
    setHostError('');
    try {
      const saved = await savePublicHost(host);
      hostTouched.current = false;
      setHostDraft(saved.publicHost ?? '');
      if (!saved.publicHost) setHostOpen(false);
      await load();
      showNotice(t(saved.publicHost ? 'multiplayer.direct.public.saved' : 'multiplayer.direct.public.cleared'));
    } catch (err) {
      setHostError(errorMessage(err));
    } finally {
      setHostBusy(false);
    }
  }

  async function start() {
    setStartBusy(true);
    setStartError('');
    try {
      await controlInstance(instance.id, 'start');
      // Refresh the instance status right away, so the button does not become clickable again before the next poll.
      await onInstanceChanged();
    } catch (err) {
      setStartError(errorMessage(err));
    } finally {
      setStartBusy(false);
    }
  }

  const running = instance.status === 'running';
  // Pending migration, detached live process, or this start is known to fail: no "Start" here, go to the instance page to handle it.
  const needsFix = !!instance.orphanProcess || (canStartInstance(instance.status) && (instance.requiresMigration || !!instance.startIssue));
  const port = network?.port ?? null;
  const withPort = (host: string) => (host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`);
  const addresses = port != null && network ? network.addresses.map(withPort) : [];
  // An IPv6 address with a port must be wrapped in square brackets for the game to recognize the port.
  const ipv6Addresses = port != null && network ? network.publicIpv6.map(withPort) : [];
  const publicHosts = network ? [...new Set([...(network.publicHost ? [network.publicHost] : []), ...network.publicIpv4])] : [];
  const publicAddresses = port != null ? publicHosts.map(withPort) : [];
  const hasPublic = publicHosts.length > 0;
  const showPublicCard = hasPublic || hostOpen;
  const windows = network?.platform === 'win32';
  const hostIssue = publicHostIssue(hostDraft);

  const addressList = (items: string[]) => (
    <ul className="direct-address-list">
      {items.map((address) => (
        <li key={address}>
          <code className="direct-address">{address}</code>
          <button
            className="btn btn-sm"
            type="button"
            aria-label={t('multiplayer.direct.copyAria', { address })}
            onClick={() => void copy(address)}
          >
            <Copy size={13} aria-hidden="true" />
            {t('action.copy')}
          </button>
        </li>
      ))}
    </ul>
  );

  const checklist = network && showPublicCard && (
    <>
      <h3>{t('multiplayer.direct.public.checklist')}</h3>
      <ol className="direct-checklist">
        <li>{t('multiplayer.direct.public.check.securityGroup', { port: String(port ?? 25565), panelPort: String(network.panelPort) })}</li>
        <li>
          {t(windows ? 'multiplayer.direct.public.check.firewallWindows' : 'multiplayer.direct.public.check.firewallLinux', {
            port: String(port ?? 25565),
          })}
          <code className="direct-command">
            {windows
              ? `netsh advfirewall firewall add rule name="Minecraft ${port ?? 25565}" dir=in action=allow protocol=TCP localport=${port ?? 25565}`
              : `sudo ufw allow ${port ?? 25565}/tcp`}
          </code>
          {!windows && (
            <code className="direct-command">
              {`sudo firewall-cmd --permanent --add-port=${port ?? 25565}/tcp && sudo firewall-cmd --reload`}
            </code>
          )}
        </li>
        <li>{t('multiplayer.direct.public.check.serverIp')}</li>
        <li>{t('multiplayer.direct.public.check.domain')}</li>
        <li>{t('multiplayer.direct.public.check.safety')}</li>
        <li>{t('multiplayer.direct.public.check.test')}</li>
      </ol>
    </>
  );

  const guideContent = (
    <>
      <h3>{t('multiplayer.guide.troubleshoot')}</h3>
      <ul>
        <li>{t('multiplayer.guide.direct.running')}</li>
        {(windows || !network) && <li>{t('multiplayer.guide.direct.javaBlocked')}</li>}
        <li>{t('multiplayer.guide.direct.isolation')}</li>
      </ul>
      {checklist}
      {ipv6Addresses.length > 0 && (
        <>
          <h3>{t('multiplayer.guide.ipv6.title')}</h3>
          <p>{t('multiplayer.direct.ipv6.router', { port: String(port) })}</p>
        </>
      )}
    </>
  );

  return (
    <MultiplayerLayout guide={guideContent} control={guide}>
      <p className="section-lead">{t('multiplayer.direct.intro')}</p>
      {error && <p className="callout callout-danger" role="alert">{error}</p>}
      {/* Addresses are unusable while not running: start it here if it can be started; when there is a problem to handle first (EULA, Java, pending migration), go to the instance page, where the reason is written. */}
      {!running && (
        <div className="callout" role="status">
          <p>
            {t(needsFix
              ? 'multiplayer.direct.needsFix'
              : instance.status === 'starting' ? 'multiplayer.direct.starting' : 'multiplayer.direct.notRunning')}
          </p>
          {needsFix ? (
            <Link className="btn btn-sm" to={`/instances/${instance.id}`}>{t('multiplayer.direct.openInstance')}</Link>
          ) : canStartInstance(instance.status) ? (
            <button className="btn btn-sm" type="button" disabled={startBusy} onClick={() => void start()}>
              <Play size={13} aria-hidden="true" />
              {t('action.start')}
            </button>
          ) : null}
        </div>
      )}
      {startError && <p className="callout callout-danger" role="alert">{startError}</p>}
      {network?.serverIpBlocked && (
        <p className="callout callout-danger" role="alert">
          {t(network.serverIpIsUnboundPublicHost ? 'multiplayer.direct.serverIpPublic' : 'multiplayer.direct.serverIpBlocked')}
        </p>
      )}
      {network && port == null && (
        <p className="callout callout-danger" role="alert">{t('multiplayer.direct.portInvalid')}</p>
      )}

      {/* LAN addresses are valid only on the same network: the heading always states the scope, the first sentence under the address states the limitation, and the way out for other networks follows right after. */}
      <section className="form-section">
        <h3 className="form-section-title">{t('multiplayer.direct.sameNetworkTitle')}</h3>
        <div className="card form-card direct-block">
          {network === null && !error ? (
            <p className="field-help" role="status">{t('common.loading')}</p>
          ) : addresses.length > 0 ? (
            <>
              {addressList(addresses)}
              <p className="field-help direct-scope">{t('multiplayer.direct.scope')}</p>
              {addresses.length > 1 && !hasPublic && <p className="field-help">{t('multiplayer.direct.several')}</p>}
            </>
          ) : network && !network.serverIpBlocked && port != null ? (
            <>
              <p className="field-help">{t('multiplayer.direct.noAddress')}</p>
              {/* With no LAN address, 127.0.0.1 is the only address for the host to test on this computer; with a LAN address that one is enough and no extra one is given. */}
              <p className="field-help">{t('multiplayer.direct.self', { address: `127.0.0.1:${port}` })}</p>
            </>
          ) : null}
          {/* When server-ip is bound, the port is invalid or reading failed, the red notice above has to be handled first, so no separate way-out row is placed here. */}
          {network && (addresses.length > 0 || (!network.serverIpBlocked && port != null)) && (
            <div className="direct-elsewhere">
              <p>{t(hasPublic ? 'multiplayer.direct.elsewherePublic' : 'multiplayer.direct.elsewhere')}</p>
              <div className="instance-actions">
                <button className="btn" type="button" onClick={onChooseVirtualLan}>
                  {t('multiplayer.direct.useVirtualLan')}
                </button>
                {network && !showPublicCard && (
                  <button className="btn" type="button" onClick={() => setHostOpen(true)}>
                    {t('multiplayer.direct.public.open')}
                  </button>
                )}
              </div>
            </div>
          )}
          {(windows || !network) && <p className="field-help">{t('multiplayer.direct.firewall')}</p>}
          {/* The status area is always kept so screen readers announce it; it is hidden when empty and takes no spacing. */}
          <p role="status" aria-live="polite" className={notice ? 'field-help' : 'visually-hidden'}>{notice}</p>
        </div>
      </section>

      {network && showPublicCard && (
        <section className="form-section">
          <h3 className="form-section-title">{t('multiplayer.direct.public.title')}</h3>
          <div className="card form-card direct-block">
            {publicAddresses.length > 0 && addressList(publicAddresses)}
            <div className="field">
              <label htmlFor={hostId}>{t('multiplayer.direct.public.hostLabel')}</label>
              <div className="remote-host-row">
                <input
                  id={hostId}
                  className="input"
                  value={hostDraft}
                  disabled={hostBusy}
                  placeholder="203.0.113.10"
                  inputMode="url"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(event) => { hostTouched.current = true; setHostDraft(event.target.value); }}
                />
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={hostBusy || hostDraft.trim() === '' || hostIssue !== null || hostDraft.trim() === (network.publicHost ?? '')}
                  onClick={() => void saveHost(hostDraft)}
                >
                  {t('action.save')}
                </button>
                {network.publicHost && (
                  <button className="btn" type="button" disabled={hostBusy} onClick={() => void saveHost(null)}>
                    {t('action.clear')}
                  </button>
                )}
              </div>
              <p className="field-help">{t('multiplayer.direct.public.hostHelp')}</p>
              {hostIssue && <p className="error">{t(hostIssue.key)}</p>}
              {!hostIssue && isPrivateHost(hostDraft.trim()) && <p className="field-warn">{t('multiplayer.direct.public.private')}</p>}
              {hostError && <p className="error" role="alert">{hostError}</p>}
            </div>
          </div>
        </section>
      )}

      {ipv6Addresses.length > 0 && (
        <section className="form-section">
          <h3 className="form-section-title">{t('multiplayer.direct.ipv6.title')}</h3>
          <div className="card form-card direct-block">
            {addressList(ipv6Addresses)}
            <p className="field-help">{t('multiplayer.direct.ipv6.intro')}</p>
          </div>
        </section>
      )}
    </MultiplayerLayout>
  );
}
