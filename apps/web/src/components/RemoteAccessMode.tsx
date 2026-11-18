import { useEffect, useId, useRef, useState } from 'react';
import { Copy, TriangleAlert } from 'lucide-react';
import type {
  AccessModeStatus,
  NetworkInterfaceKind,
  RemoteAccessProblem,
  RemoteAccessStatus,
  RemoteAccessUrl,
  UpdateDirectAccessRequest,
} from '@mystry/shared';
import { renewPanelCertificate, saveAccessMode, savePublicHost } from '../api';
import { copyText } from '../clipboard';
import { errorMessage } from '../errors';
import { useI18n, type MessageKey } from '../i18n';
import { publicHostIssue } from '../validation';
import { QrCode } from './QrCode';

const KIND_HINT: Record<NetworkInterfaceKind | 'publicHost', MessageKey> = {
  lan: 'remoteAccess.kind.lan',
  public: 'remoteAccess.kind.public',
  publicHost: 'remoteAccess.kind.publicHost',
  overlay: 'remoteAccess.kind.overlay',
  proxy: 'remoteAccess.kind.proxy',
  virtual: 'remoteAccess.kind.virtual',
  instanceNetwork: 'remoteAccess.kind.instanceNetwork',
};

const PROBLEM_TEXT: Record<RemoteAccessProblem, MessageKey> = {
  interfaceGone: 'remoteAccess.problem.interfaceGone',
  noAddress: 'remoteAccess.problem.noAddress',
  listenFailed: 'remoteAccess.problem.listenFailed',
  subnetUnknown: 'remoteAccess.problem.subnetUnknown',
  certificateFailed: 'remoteAccess.problem.certificateFailed',
};

/** 下拉框里「所有网卡」对应的值；真实网卡名不会是空字符串。 */
const ALL_ADAPTERS = '';

function isPrivateHost(host: string): boolean {
  return /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(host) || host === 'localhost';
}

/** 浏览器当前是不是经这种方式打开的面板：是的话，关掉它会断开自己。 */
function usesCurrentOrigin(urls: readonly RemoteAccessUrl[]): boolean {
  return urls.some((item) => {
    try {
      return new URL(item.url).hostname === window.location.hostname;
    } catch {
      return false;
    }
  });
}

/**
 * 「直接访问」和「已装的组网软件」共用的分段：选网卡、两个安全开关、开启或关闭，
 * 开启后显示二维码、网址和防火墙结果。网址只用服务端返回的，不用 window.location 拼。
 */
export function RemoteAccessMode({
  mode,
  status,
  onStatus,
}: {
  mode: 'direct' | 'overlay';
  status: RemoteAccessStatus;
  onStatus: (next: RemoteAccessStatus) => void;
}) {
  const { t, fmt } = useI18n();
  const access: AccessModeStatus = status[mode];
  const adapterId = useId();
  const hostId = useId();
  const httpsTitleId = useId();
  const subnetTitleId = useId();
  const httpsHelpId = useId();
  const subnetHelpId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [failedKey, setFailedKey] = useState('');
  const [notice, setNotice] = useState('');
  const [selectedUrl, setSelectedUrl] = useState('');
  const [hostDraft, setHostDraft] = useState(status.publicHost ?? '');
  const [hostOpen, setHostOpen] = useState(false);
  // 没开启时，网卡和两个开关只是草稿，点「开启」才提交；开启后每次改动立即生效。
  const overlayDefault = status.interfaces.find((entry) => entry.kind === 'overlay')?.name
    ?? status.interfaces[0]?.name ?? ALL_ADAPTERS;
  const [draft, setDraft] = useState<UpdateDirectAccessRequest>({
    enabled: false,
    interfaceName: access.interfaceName ?? (mode === 'overlay' ? overlayDefault || null : null),
    restrictToSubnet: access.restrictToSubnet,
    https: access.https,
  });
  const previousFirstUrl = useRef('');

  const listeningUrls = access.urls.filter((item) => item.listening);
  const firstUrl = listeningUrls[0]?.url ?? '';
  const shownUrl = listeningUrls.some((item) => item.url === selectedUrl) ? selectedUrl : firstUrl;

  // 地址变了（DHCP、换 Wi-Fi）时提示二维码已更新。
  useEffect(() => {
    if (previousFirstUrl.current && firstUrl && previousFirstUrl.current !== firstUrl && !busy) {
      setNotice(t('remoteAccess.changed', { url: firstUrl }));
    }
    previousFirstUrl.current = firstUrl;
  }, [firstUrl, busy, t]);

  const current: UpdateDirectAccessRequest = access.enabled
    ? { enabled: true, interfaceName: access.interfaceName, restrictToSubnet: access.restrictToSubnet, https: access.https }
    : draft;
  const names = [...new Set(status.interfaces.map((entry) => entry.name))];
  const selectedName = current.interfaceName ?? ALL_ADAPTERS;
  const selectedEntry = status.interfaces.find((entry) => entry.name === selectedName);
  const hasOverlayAdapter = status.interfaces.some((entry) => entry.kind === 'overlay');
  // 之前选的网卡现在找不到了（拔了网线、关了虚拟网卡）：不能用它开启，提示换一块。
  const adapterMissing = selectedName !== ALL_ADAPTERS && !names.includes(selectedName);
  const hostIssue = publicHostIssue(hostDraft);

  async function apply(next: UpdateDirectAccessRequest): Promise<void> {
    setBusy(true);
    setError('');
    setFailedKey('');
    setNotice('');
    try {
      onStatus(await saveAccessMode(mode, next));
      setDraft({ ...next, enabled: false });
    } catch (err) {
      setError(errorMessage(err));
      setFailedKey((err as { messageI18n?: { key?: string } } | null)?.messageI18n?.key ?? '');
    } finally {
      setBusy(false);
    }
  }

  function change(patch: Partial<UpdateDirectAccessRequest>): void {
    if (access.enabled) void apply({ ...current, ...patch, enabled: true });
    else setDraft((value) => ({ ...value, ...patch }));
  }

  async function copy(text: string): Promise<void> {
    setNotice(await copyText(text) ? t('remoteAccess.copied', { text }) : t('remoteAccess.copyFailed'));
  }

  async function renew(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      onStatus(await renewPanelCertificate());
      setNotice(t('remoteAccess.cert.renewed'));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveHost(host: string | null): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const saved = await savePublicHost(host);
      setHostDraft(saved.publicHost ?? '');
      onStatus({ ...status, publicHost: saved.publicHost });
      setNotice(t(saved.publicHost ? 'remoteAccess.publicHost.saved' : 'remoteAccess.publicHost.cleared'));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const urlList = (
    <div className="remote-urls">
      <h3 className="remote-subtitle">{t('remoteAccess.urls.title')}</h3>
      <ul className="list-group remote-url-list">
        {access.urls.map((item) => (
          <li key={item.url} className={`list-row remote-url-row${item.listening ? '' : ' is-muted'}`}>
            <div className="list-row-text">
              {item.listening ? (
                <button
                  type="button"
                  className="link-button remote-url"
                  aria-label={t('remoteAccess.urls.show', { url: item.url })}
                  aria-pressed={item.url === shownUrl}
                  onClick={() => setSelectedUrl(item.url)}
                >
                  {item.url}
                </button>
              ) : (
                <span className="remote-url">{item.url}</span>
              )}
              <span className="list-row-desc">
                {item.listening
                  ? t(KIND_HINT[item.kind])
                  : item.problem
                    ? t(PROBLEM_TEXT[item.problem], { port: status.port })
                    : t('remoteAccess.urls.notListening')}
              </span>
            </div>
            {item.listening && (
              <div className="list-row-control">
                <button
                  className="btn btn-sm"
                  type="button"
                  aria-label={t('remoteAccess.urls.copyAria', { url: item.url })}
                  onClick={() => void copy(item.url)}
                >
                  <Copy size={13} aria-hidden="true" />
                  {t('action.copy')}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );

  const qrBlock = shownUrl && (
    <div className="remote-qr">
      <QrCode value={shownUrl} label={t('remoteAccess.qr.label', { url: shownUrl })} />
      <div className="remote-qr-text">
        <code className="remote-qr-url">{shownUrl}</code>
        <p className="field-help">{t('remoteAccess.qr.scan')}</p>
        {mode === 'overlay' && <p className="field-help">{t('remoteAccess.overlay.phoneFirst')}</p>}
        {shownUrl.startsWith('https:') && <p className="field-help">{t('remoteAccess.qr.firstVisit')}</p>}
      </div>
    </div>
  );

  if (mode === 'direct' && status.managedByConfig) {
    return (
      <div className="remote-section">
        <p className="callout callout-info">{t('remoteAccess.managed', { host: status.configuredHost ?? '' })}</p>
        {!status.frontendServed && <p className="callout callout-warning">{t('remoteAccess.devMode')}</p>}
        {qrBlock}
        {access.urls.length > 0 && urlList}
        <p role="status" aria-live="polite" className="field-help remote-notice">{notice}</p>
      </div>
    );
  }

  return (
    <div className="remote-section">
      {mode === 'direct' ? (
        <p className="section-lead">{t(access.enabled ? 'remoteAccess.lead' : 'remoteAccess.direct.off')}</p>
      ) : (
        <p className="section-lead">{t('remoteAccess.overlay.lead')}</p>
      )}
      {mode === 'direct' && !access.enabled && <p className="field-help">{t('remoteAccess.lead')}</p>}
      {mode === 'overlay' && !hasOverlayAdapter && <p className="callout callout-info">{t('remoteAccess.overlay.none')}</p>}
      {!status.frontendServed && <p className="callout callout-warning">{t('remoteAccess.devMode')}</p>}

      {access.enabled && access.problem && (
        <p className="callout callout-warning" role="status">
          {t(PROBLEM_TEXT[access.problem], { port: status.port })}
        </p>
      )}
      {access.enabled && qrBlock}
      {access.enabled && access.urls.length > 0 && urlList}
      <p role="status" aria-live="polite" className="field-help remote-notice">{notice}</p>

      {access.enabled && access.firewall === 'applied' && (
        <p className="field-help">{t('remoteAccess.firewall.applied', { port: status.port })}</p>
      )}
      {access.enabled && access.firewall === 'failed' && (
        <div className="callout callout-warning">
          <TriangleAlert size={18} aria-hidden="true" className="callout-icon" />
          <p>{t('remoteAccess.firewall.failed', { port: status.port })}</p>
        </div>
      )}
      {access.enabled && access.firewall === 'skipped' && (
        <p className="field-help">
          {t('remoteAccess.firewall.skipped', {
            port: status.port,
            ufw: `sudo ufw allow ${status.port}/tcp`,
            firewalld: `sudo firewall-cmd --permanent --add-port=${status.port}/tcp && sudo firewall-cmd --reload`,
          })}
        </p>
      )}
      {access.enabled && mode === 'direct' && (
        <p className="field-help">{t('remoteAccess.firewall.cloud', { port: status.port })}</p>
      )}

      <div className="field">
        <label htmlFor={adapterId}>{t('remoteAccess.adapter.label')}</label>
        <select
          id={adapterId}
          className="input"
          value={selectedName}
          disabled={busy}
          onChange={(event) => change({ interfaceName: event.target.value === ALL_ADAPTERS ? null : event.target.value })}
        >
          {mode === 'direct' && <option value={ALL_ADAPTERS}>{t('remoteAccess.adapter.all')}</option>}
          {/*
            组网方式必须选一块网卡，没有「所有网卡」。还没选时（打开时没有网卡、之后才连上）给一个占位项，
            否则浏览器把下拉框显示成第一块网卡，开启按钮却因为没选而点不了。
          */}
          {mode === 'overlay' && selectedName === ALL_ADAPTERS && (
            <option value={ALL_ADAPTERS} disabled={names.length > 0}>
              {names.length === 0 ? t('common.none') : t('remoteAccess.adapter.choose')}
            </option>
          )}
          {/* 选中的网卡已经不在了：照样列出，否则下拉框会显示成别的网卡。 */}
          {selectedName !== ALL_ADAPTERS && !names.includes(selectedName) && (
            <option value={selectedName}>{selectedName}</option>
          )}
          {names.map((name) => (
            <option key={name} value={name}>
              {t('remoteAccess.adapter.option', {
                name,
                address: status.interfaces.filter((entry) => entry.name === name).map((entry) => entry.address).join(', '),
              })}
            </option>
          ))}
        </select>
        <p className="field-help">
          {adapterMissing ? <span className="error">{t('remoteAccess.adapter.missing')}</span>
            : selectedEntry ? t(KIND_HINT[selectedEntry.kind]) : mode === 'direct' ? t('remoteAccess.adapter.allHelp') : ''}
        </p>
      </div>

      <div className="remote-security">
        <h3 className="remote-subtitle">{t('remoteAccess.security.title')}</h3>
        <div className="list-group">
          <label className="list-row remote-switch-row">
            <span className="list-row-text">
              <span className="list-row-title" id={httpsTitleId}>{t('remoteAccess.security.https')}</span>
              <span className="list-row-desc" id={httpsHelpId}>
                {t('remoteAccess.security.httpsHelp')}
                {/* 只有直接访问可能用公网地址打开；组网地址不受这条影响。 */}
                {mode === 'direct' && !current.https && ` ${t('remoteAccess.security.httpsChromeNote')}`}
              </span>
            </span>
            <input
              type="checkbox"
              role="switch"
              className="switch"
              checked={current.https}
              disabled={busy}
              aria-labelledby={httpsTitleId}
              aria-describedby={httpsHelpId}
              onChange={(event) => change({ https: event.target.checked })}
            />
          </label>
          <label className="list-row remote-switch-row">
            <span className="list-row-text">
              <span className="list-row-title" id={subnetTitleId}>{t('remoteAccess.security.subnet')}</span>
              <span className="list-row-desc" id={subnetHelpId}>{t('remoteAccess.security.subnetHelp')}</span>
            </span>
            <input
              type="checkbox"
              role="switch"
              className="switch"
              checked={current.restrictToSubnet}
              disabled={busy}
              aria-labelledby={subnetTitleId}
              aria-describedby={subnetHelpId}
              onChange={(event) => change({ restrictToSubnet: event.target.checked })}
            />
          </label>
        </div>
      </div>

      {access.enabled && access.https && status.certificate && (
        <details className="disclosure remote-cert">
          <summary>{t('remoteAccess.cert.title')}</summary>
          <p className="field-help">{t('remoteAccess.cert.fingerprint')}</p>
          <code className="remote-fingerprint">{status.certificate.fingerprint256}</code>
          <p className="field-help">
            {t('remoteAccess.cert.expires', { date: fmt.dateTime(status.certificate.notAfter) })}
            {' '}
            {t('remoteAccess.cert.compare')}
          </p>
          <div className="instance-actions">
            <button className="btn btn-sm" type="button" disabled={busy} onClick={() => void renew()}>
              {t('remoteAccess.cert.renew')}
            </button>
          </div>
          <p className="field-help">{t('remoteAccess.cert.renewHelp')}</p>
        </details>
      )}

      {mode === 'direct' && (
        hostOpen || status.publicHost ? (
          <div className="field">
            <label htmlFor={hostId}>{t('remoteAccess.publicHost.label')}</label>
            <div className="remote-host-row">
              <input
                id={hostId}
                className="input"
                value={hostDraft}
                disabled={busy}
                placeholder="203.0.113.10"
                inputMode="url"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(event) => setHostDraft(event.target.value)}
              />
              <button
                className="btn btn-primary"
                type="button"
                disabled={busy || hostDraft.trim() === '' || hostIssue !== null || hostDraft.trim() === (status.publicHost ?? '')}
                onClick={() => void saveHost(hostDraft)}
              >
                {t('action.save')}
              </button>
              {status.publicHost && (
                <button className="btn" type="button" disabled={busy} onClick={() => void saveHost(null)}>
                  {t('action.clear')}
                </button>
              )}
            </div>
            <p className="field-help">{t('remoteAccess.publicHost.help')}</p>
            {hostIssue && <p className="error">{t(hostIssue.key)}</p>}
            {!hostIssue && isPrivateHost(hostDraft.trim()) && <p className="field-warn">{t('remoteAccess.publicHost.private')}</p>}
            {/* 只提醒、不改默认值：云服务器上开「只允许同一网段」会把用户自己挡在外面。 */}
            {status.publicHost && !current.restrictToSubnet && <p className="field-warn">{t('remoteAccess.publicHost.exposed')}</p>}
          </div>
        ) : (
          <p className="field-help">
            {t('remoteAccess.publicHost.prompt')}{' '}
            <button type="button" className="link-button" onClick={() => setHostOpen(true)}>
              {t('remoteAccess.publicHost.label')}
            </button>
          </p>
        )
      )}

      {error && <p className="callout callout-danger" role="alert">{error}</p>}
      {access.enabled && usesCurrentOrigin(access.urls) && (
        <p className="field-warn">{t('remoteAccess.turnOffSelf')}</p>
      )}
      <div className="instance-actions">
        {access.enabled ? (
          <button className="btn" type="button" disabled={busy} onClick={() => void apply({ ...current, enabled: false })}>
            {busy ? t('remoteAccess.action.working') : t('remoteAccess.action.turnOff')}
          </button>
        ) : (
          <>
            <button
              className="btn btn-primary"
              type="button"
              disabled={busy || adapterMissing || (mode === 'overlay' && !current.interfaceName)}
              onClick={() => void apply({ ...current, enabled: true })}
            >
              {busy ? t('remoteAccess.action.working') : t('remoteAccess.action.turnOn')}
            </button>
            {/* 证书生成失败时给一条出路：同样的请求，不加密。 */}
            {failedKey === 'server.remoteAccess.certificateFailed' && (
              <button className="btn" type="button" disabled={busy} onClick={() => void apply({ ...current, enabled: true, https: false })}>
                {t('remoteAccess.action.turnOnPlain')}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
