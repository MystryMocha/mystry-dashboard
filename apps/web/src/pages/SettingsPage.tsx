import { lazy, Suspense, useEffect, useId, useState } from 'react';
import { ChevronRight, LogOut } from 'lucide-react';
import type { PanelInfo } from '@mystry/shared';
import { getPanelInfo } from '../api';
import { useAuth } from '../auth';
import { ChangePasswordDialog } from '../components/ChangePasswordDialog';
import { DownloadSourceRow } from '../components/DownloadSourceSection';
import { PageHeader } from '../components/PageHeader';
import { SessionDurationRow } from '../components/SessionDurationRow';
import { errorMessage } from '../errors';
import {
  getLocalePreference,
  isLocalePreference,
  LOCALE_CHANGE_EVENT,
  LOCALE_NATIVE_NAMES,
  LOCALE_PREFERENCES,
  setLocalePreference,
  useI18n,
  type LocalePreference,
} from '../i18n';
import {
  APPEARANCES,
  APPEARANCE_LABEL_KEYS,
  getAppearance,
  setAppearance,
  THEME_CHANGE_EVENT,
  type Appearance,
} from '../theme';

// 弹窗连同二维码库只在点开时加载。
const RemoteAccessDialog = lazy(() =>
  import('../components/RemoteAccessDialog').then(({ RemoteAccessDialog }) => ({ default: RemoteAccessDialog })),
);

/** 一组设置：组名和一句适用范围在前，设置行在后；页面够宽时组名在左边一列。 */
function SettingsSection({
  title,
  lead,
  children,
}: {
  title: string;
  lead?: string;
  children: React.ReactNode;
}) {
  const titleId = useId();
  return (
    <section className="form-section settings-section" aria-labelledby={titleId}>
      <div className="settings-section-head">
        <h2 className="form-section-title" id={titleId}>{title}</h2>
        {lead && <p className="section-lead">{lead}</p>}
      </div>
      <div className="settings-section-body">{children}</div>
    </section>
  );
}

/** 语言：和顶栏的语言按钮改的是同一个设置，两边互相同步。 */
function LanguageRow() {
  const { t, locale } = useI18n();
  const selectId = useId();
  const hintId = useId();
  const [preference, setPreference] = useState<LocalePreference>(getLocalePreference);

  useEffect(() => {
    const onChange = () => setPreference(getLocalePreference());
    window.addEventListener(LOCALE_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(LOCALE_CHANGE_EVENT, onChange);
  }, []);

  return (
    <div className="list-row">
      <div className="list-row-text">
        <label className="list-row-title" htmlFor={selectId}>{t('language.title')}</label>
        {preference === 'auto' && (
          <p className="list-row-desc" id={hintId}>
            {t('language.auto.hint', { language: LOCALE_NATIVE_NAMES[locale] })}
          </p>
        )}
      </div>
      <div className="list-row-control settings-row-select">
        <select
          id={selectId}
          className="input"
          value={preference}
          aria-describedby={preference === 'auto' ? hintId : undefined}
          onChange={(event) => {
            const next = event.target.value;
            if (isLocalePreference(next)) setLocalePreference(next);
          }}
        >
          {LOCALE_PREFERENCES.map((id) => (
            <option key={id} value={id} lang={id === 'auto' ? undefined : id}>
              {id === 'auto' ? t('language.auto') : LOCALE_NATIVE_NAMES[id]}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/** 外观：和顶栏的外观按钮改的是同一个设置。 */
function AppearanceRow() {
  const { t } = useI18n();
  const titleId = useId();
  const [appearance, setAppearanceState] = useState<Appearance>(getAppearance);

  useEffect(() => {
    const onChange = () => setAppearanceState(getAppearance());
    window.addEventListener(THEME_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, onChange);
  }, []);

  return (
    <div className="list-row">
      <div className="list-row-text">
        <span className="list-row-title" id={titleId}>{t('appearance.title')}</span>
      </div>
      <div className="list-row-control">
        <div className="segmented" role="group" aria-labelledby={titleId}>
          {APPEARANCES.map((id) => (
            <button
              key={id}
              type="button"
              className={`segmented-item${appearance === id ? ' active' : ''}`}
              aria-pressed={appearance === id}
              onClick={() => setAppearance(id)}
            >
              {t(APPEARANCE_LABEL_KEYS[id])}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 地址里的 IPv6 要加方括号，否则和端口的冒号分不开。 */
function listenAddress(info: PanelInfo): string {
  return `${info.host.includes(':') ? `[${info.host}]` : info.host}:${info.port}`;
}

function isPanelInfo(value: unknown): value is PanelInfo {
  const info = value as Partial<PanelInfo> | null;
  return typeof info?.host === 'string'
    && typeof info.port === 'number'
    && typeof info.dataDir === 'string'
    && typeof info.backupDir === 'string'
    && typeof info.configPath === 'string';
}

/** 运行信息：版本随前端构建写入；监听地址和目录来自配置文件，这里只展示。 */
function PanelInfoSection() {
  const { t } = useI18n();
  const [info, setInfo] = useState<PanelInfo | null>(null);
  const [error, setError] = useState('');
  // 每点一次「重试」加一，重新读取。
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setError('');
    getPanelInfo()
      .then((result) => {
        if (!active) return;
        if (isPanelInfo(result)) setInfo(result);
        else setError(t('settings.info.loadFailed'));
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err));
      });
    return () => {
      active = false;
    };
    // 挂载时读取一次，之后只在重试时再读
  }, [attempt]);

  return (
    <SettingsSection title={t('settings.info.title')}>
      <dl className="list-group settings-info">
        <div className="list-row">
          <dt className="list-row-title">{t('settings.info.version')}</dt>
          <dd className="list-row-value">{__APP_VERSION__}</dd>
        </div>
        {info && (
          <>
            <div className="list-row">
              <dt className="list-row-title">{t('settings.info.address')}</dt>
              <dd className="list-row-value settings-path">{listenAddress(info)}</dd>
            </div>
            <div className="list-row settings-path-row">
              <dt className="list-row-title">{t('settings.info.dataDir')}</dt>
              <dd className="list-row-value settings-path">{info.dataDir}</dd>
            </div>
            <div className="list-row settings-path-row">
              <dt className="list-row-title">{t('settings.info.backupDir')}</dt>
              <dd className="list-row-value settings-path">{info.backupDir}</dd>
            </div>
            <div className="list-row settings-path-row">
              <dt className="list-row-title">{t('settings.info.configFile')}</dt>
              <dd className="list-row-value settings-path">{info.configPath}</dd>
            </div>
          </>
        )}
      </dl>
      {error && (
        <div className="settings-load-error">
          <p className="error" role="alert">{error}</p>
          <button type="button" className="link-button" onClick={() => setAttempt((count) => count + 1)}>
            {t('action.retry')}
          </button>
        </div>
      )}
      {info && <p className="field-help">{t('settings.info.note')}</p>}
    </SettingsSection>
  );
}

export function SettingsPage() {
  const { t } = useI18n();
  const { user, logout } = useAuth();
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [remoteAccessOpen, setRemoteAccessOpen] = useState(false);

  return (
    <div className="page settings-page">
      <PageHeader title={t('nav.settings')} />

      <SettingsSection title={t('settings.device.title')} lead={t('settings.device.lead')}>
        <div className="list-group">
          <LanguageRow />
          <AppearanceRow />
        </div>
      </SettingsSection>

      <SettingsSection title={t('settings.panel.title')} lead={t('settings.panel.lead')}>
        <div className="list-group">
          <SessionDurationRow />
          <DownloadSourceRow />
          <button type="button" className="list-row remote-entry-row" onClick={() => setRemoteAccessOpen(true)}>
            <span className="list-row-text">
              <span className="list-row-title">{t('remoteAccess.entry')}</span>
              <span className="list-row-desc">{t('remoteAccess.entry.desc')}</span>
            </span>
            <ChevronRight size={16} aria-hidden="true" className="remote-entry-chevron" />
          </button>
        </div>
      </SettingsSection>

      <SettingsSection title={t('settings.account.title')}>
        <div className="list-group">
          <div className="list-row">
            <div className="list-row-text">
              <span className="list-row-title">{user?.username ?? 'admin'}</span>
              <span className="list-row-desc">{t('shell.user.role')}</span>
            </div>
            <div className="list-row-control">
              <button className="btn" type="button" onClick={logout}>
                <LogOut size={15} aria-hidden="true" />
                {t('shell.user.signOut')}
              </button>
            </div>
          </div>
          <div className="list-row">
            <div className="list-row-text">
              <span className="list-row-title">{t('settings.account.password')}</span>
              <span className="list-row-desc">{t('settings.account.password.desc')}</span>
            </div>
            <div className="list-row-control">
              <button className="btn" type="button" onClick={() => setPasswordDialogOpen(true)}>
                {t('shell.user.changePassword')}
              </button>
            </div>
          </div>
        </div>
      </SettingsSection>

      <PanelInfoSection />

      {passwordDialogOpen && <ChangePasswordDialog onClose={() => setPasswordDialogOpen(false)} />}
      {remoteAccessOpen && (
        <Suspense fallback={null}>
          <RemoteAccessDialog onClose={() => setRemoteAccessOpen(false)} />
        </Suspense>
      )}
    </div>
  );
}
