import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, TriangleAlert } from 'lucide-react';
import type { InstanceInfo, InstanceLocalNetwork } from '@mystry/shared';
import { getInstanceLocalNetwork } from '../api';
import { errorMessage } from '../errors';
import { usePolling } from '../hooks/usePolling';
import { useI18n } from '../i18n';

/**
 * 同一网络直连：朋友和这台电脑连着同一个路由器时，直接用局域网地址加入。
 * 只读显示地址和端口，不安装任何东西，也不改服务器配置。
 */
export function DirectSection({
  instance,
  onChooseVirtualLan,
}: {
  instance: InstanceInfo;
  onChooseVirtualLan: () => void;
}) {
  const { t } = useI18n();
  const [network, setNetwork] = useState<InstanceLocalNetwork | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      setNetwork(await getInstanceLocalNetwork(instance.id));
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [instance.id]);
  usePolling(load, 10_000);

  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);

  async function copy(address: string) {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(address);
      setNotice(t('multiplayer.direct.copied', { address }));
    } catch {
      setNotice(t('multiplayer.direct.copyFailed'));
    }
    noticeTimer.current = setTimeout(() => setNotice(''), 6000);
  }

  const running = instance.status === 'running';
  const port = network?.port ?? null;
  const addresses = port != null && network ? network.addresses.map((address) => `${address}:${port}`) : [];

  return (
    <section className="form-section">
      <p className="section-lead">{t('multiplayer.direct.intro')}</p>
      {error && <p className="callout callout-danger" role="alert">{error}</p>}
      {!running && <p className="callout" role="status">{t('multiplayer.direct.notRunning')}</p>}
      {network?.serverIpBlocked && (
        <p className="callout callout-danger" role="alert">{t('multiplayer.direct.serverIpBlocked')}</p>
      )}
      {network && port == null && (
        <p className="callout callout-danger" role="alert">{t('multiplayer.direct.portInvalid')}</p>
      )}
      <div className="card form-card">
        <div className="direct-block">
          <h3 className="direct-title">{t('multiplayer.direct.addressTitle')}</h3>
          {network === null && !error ? (
            <p className="field-help" role="status">{t('common.loading')}</p>
          ) : addresses.length > 0 ? (
            <>
              <ul className="direct-address-list">
                {addresses.map((address) => (
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
              {addresses.length > 1 && <p className="field-help">{t('multiplayer.direct.several')}</p>}
              <p className="field-help">{t('multiplayer.direct.howTo')}</p>
            </>
          ) : network && !network.serverIpBlocked && port != null ? (
            <p className="field-help">{t('multiplayer.direct.noAddress')}</p>
          ) : null}
          {port != null && <p className="field-help">{t('multiplayer.direct.self', { address: `127.0.0.1:${port}` })}</p>}
          <p role="status" aria-live="polite" className="field-help direct-notice">{notice}</p>
        </div>
        <div className="callout callout-warning">
          <TriangleAlert size={18} aria-hidden="true" className="callout-icon" />
          <p>{t('multiplayer.direct.firewall')}</p>
        </div>
      </div>
      <div className="callout">
        <p>{t('multiplayer.direct.elsewhere')}</p>
        <button className="btn" type="button" onClick={onChooseVirtualLan}>
          {t('multiplayer.direct.useVirtualLan')}
        </button>
      </div>
    </section>
  );
}
