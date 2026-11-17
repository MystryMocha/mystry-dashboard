import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Copy, TriangleAlert } from 'lucide-react';
import type { InstanceInfo, InstanceLocalNetwork } from '@mystry/shared';
import { getInstanceLocalNetwork, savePublicHost } from '../api';
import { copyText } from '../clipboard';
import { errorMessage } from '../errors';
import { usePolling } from '../hooks/usePolling';
import { useI18n } from '../i18n';

function isPrivateHost(host: string): boolean {
  return /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(host) || host === 'localhost';
}

/**
 * 直连：朋友和这台电脑在同一个网络时用局域网地址；这台电脑有公网 IP（云服务器、机房）时，
 * 朋友用「公网地址:游戏端口」直接加入。这台电脑有公网 IPv6 时，另外给出可以试的地址。
 * 只显示地址、端口和检查清单，不安装任何东西，也不改服务器配置；公网地址由用户填写，不自动探测。
 */
export function DirectSection({
  instance,
  onChooseVirtualLan,
}: {
  instance: InstanceInfo;
  onChooseVirtualLan: () => void;
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
  const hostTouched = useRef(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await getInstanceLocalNetwork(instance.id);
      setNetwork(next);
      // 用户正在输入时，轮询结果不覆盖输入框。
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

  const running = instance.status === 'running';
  const port = network?.port ?? null;
  const withPort = (host: string) => (host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`);
  const addresses = port != null && network ? network.addresses.map(withPort) : [];
  // IPv6 地址带端口时必须用方括号包起来，游戏才认得出端口。
  const ipv6Addresses = port != null && network ? network.publicIpv6.map(withPort) : [];
  const publicHosts = network ? [...new Set([...(network.publicHost ? [network.publicHost] : []), ...network.publicIpv4])] : [];
  const publicAddresses = port != null ? publicHosts.map(withPort) : [];
  const hasPublic = publicHosts.length > 0;
  const showPublicCard = hasPublic || hostOpen;
  const windows = network?.platform === 'win32';

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

  return (
    <section className="form-section">
      <p className="section-lead">{t('multiplayer.direct.intro')}</p>
      {error && <p className="callout callout-danger" role="alert">{error}</p>}
      {!running && <p className="callout" role="status">{t('multiplayer.direct.notRunning')}</p>}
      {network?.serverIpBlocked && (
        <p className="callout callout-danger" role="alert">
          {t(network.serverIpIsUnboundPublicHost ? 'multiplayer.direct.serverIpPublic' : 'multiplayer.direct.serverIpBlocked')}
        </p>
      )}
      {network && port == null && (
        <p className="callout callout-danger" role="alert">{t('multiplayer.direct.portInvalid')}</p>
      )}
      <div className="card form-card">
        <div className="direct-block">
          <h3 className="direct-title">
            {t(hasPublic ? 'multiplayer.direct.sameNetworkTitle' : 'multiplayer.direct.addressTitle')}
          </h3>
          {network === null && !error ? (
            <p className="field-help" role="status">{t('common.loading')}</p>
          ) : addresses.length > 0 ? (
            <>
              {addressList(addresses)}
              {addresses.length > 1 && !hasPublic && <p className="field-help">{t('multiplayer.direct.several')}</p>}
              <p className="field-help">{t('multiplayer.direct.howTo')}</p>
            </>
          ) : network && !network.serverIpBlocked && port != null ? (
            <p className="field-help">{t('multiplayer.direct.noAddress')}</p>
          ) : null}
          {port != null && <p className="field-help">{t('multiplayer.direct.self', { address: `127.0.0.1:${port}` })}</p>}
          <p role="status" aria-live="polite" className="field-help direct-notice">{notice}</p>
        </div>
        {(windows || !network) && (
          <div className="callout callout-warning">
            <TriangleAlert size={18} aria-hidden="true" className="callout-icon" />
            <p>{t('multiplayer.direct.firewall')}</p>
          </div>
        )}
      </div>

      {network && showPublicCard && (
        <div className="card form-card">
          <div className="direct-block">
            <h3 className="direct-title">{t('multiplayer.direct.public.title')}</h3>
            <p className="field-help">{t('multiplayer.direct.public.intro')}</p>
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
                  disabled={hostBusy || hostDraft.trim() === '' || hostDraft.trim() === (network.publicHost ?? '')}
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
              {isPrivateHost(hostDraft.trim()) && <p className="field-warn">{t('multiplayer.direct.public.private')}</p>}
              {hostError && <p className="error" role="alert">{hostError}</p>}
            </div>
            <h4 className="direct-subtitle">{t('multiplayer.direct.public.checklist')}</h4>
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
          </div>
        </div>
      )}

      {ipv6Addresses.length > 0 && (
        <div className="card form-card">
          <div className="direct-block">
            <h3 className="direct-title">{t('multiplayer.direct.ipv6.title')}</h3>
            <p className="field-help">{t('multiplayer.direct.ipv6.intro')}</p>
            {addressList(ipv6Addresses)}
            <p className="field-help">{t('multiplayer.direct.ipv6.changes')}</p>
          </div>
          <div className="callout callout-warning">
            <TriangleAlert size={18} aria-hidden="true" className="callout-icon" />
            <p>{t('multiplayer.direct.ipv6.router', { port: String(port) })}</p>
          </div>
        </div>
      )}
      <div className="callout">
        <p>{t(ipv6Addresses.length > 0 ? 'multiplayer.direct.ipv6.elsewhere' : 'multiplayer.direct.elsewhere')}</p>
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
    </section>
  );
}
