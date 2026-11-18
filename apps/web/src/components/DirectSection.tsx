import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Copy } from 'lucide-react';
import type { InstanceInfo, InstanceLocalNetwork } from '@mystry/shared';
import { getInstanceLocalNetwork, savePublicHost } from '../api';
import { copyText } from '../clipboard';
import { MultiplayerLayout, type GuideControl } from './MultiplayerLayout';
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
 * 主栏放地址和必须处理的提示；排查、公网检查清单和 IPv6 路由器说明放右侧指引栏。
 */
export function DirectSection({
  instance,
  guide,
  onChooseVirtualLan,
}: {
  instance: InstanceInfo;
  guide: GuideControl;
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
      {!running && <p className="callout" role="status">{t('multiplayer.direct.notRunning')}</p>}
      {network?.serverIpBlocked && (
        <p className="callout callout-danger" role="alert">
          {t(network.serverIpIsUnboundPublicHost ? 'multiplayer.direct.serverIpPublic' : 'multiplayer.direct.serverIpBlocked')}
        </p>
      )}
      {network && port == null && (
        <p className="callout callout-danger" role="alert">{t('multiplayer.direct.portInvalid')}</p>
      )}

      {/* 局域网地址只对同一网络有效：标题始终写明范围，地址下第一句说限制，紧跟着给出其他网络的出路。 */}
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
              {/* 没有局域网地址时，127.0.0.1 是服主在这台电脑上自测的唯一地址；有局域网地址时用它即可，不再多给一个。 */}
              <p className="field-help">{t('multiplayer.direct.self', { address: `127.0.0.1:${port}` })}</p>
            </>
          ) : null}
          {/* server-ip 绑定、端口无效或读取失败时，上面的红色提示要先处理，这里不再单独放一行出路。 */}
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
          {/* 状态区一直保留，读屏软件才会播报；空的时候隐藏，不占间距。 */}
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
