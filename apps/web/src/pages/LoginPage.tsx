import { useRef, useState } from 'react';
import { BrandMark } from '../components/BrandMark';
import { LanguageToggle } from '../components/LanguageToggle';
import { ThemeToggle } from '../components/ThemeToggle';
import { useAuth } from '../auth';
import { errorMessage } from '../errors';
import { useI18n } from '../i18n';

export function LoginPage() {
  const { t } = useI18n();
  const { needsSetup, statusError, login, setup, refresh } = useAuth();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const submittingRef = useRef(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    setError('');
    try {
      if (needsSetup) await setup(username, password, setupToken);
      else await login(username, password);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
  }

  async function recheck() {
    setChecking(true);
    try {
      await refresh();
    } finally {
      setChecking(false);
    }
  }

  const footer = <p className="login-footer">{t('login.footer', { version: __APP_VERSION__ })}</p>;

  if (statusError) {
    return (
      <div className="login-page">
        <div className="login-appearance">
          <LanguageToggle placement="login" />
          <ThemeToggle placement="login" />
        </div>
        <div className="login-stack">
          <BrandMark size="lg" />
          <h1 className="login-title">{t('login.unavailable.title')}</h1>
          <p className="callout callout-danger" role="alert">{statusError}</p>
          <button className="btn btn-primary btn-lg btn-block" type="button" disabled={checking} onClick={() => void recheck()}>
            {checking ? t('login.unavailable.checking') : t('login.unavailable.recheck')}
          </button>
          {footer}
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-appearance">
        <LanguageToggle placement="login" />
        <ThemeToggle placement="login" />
      </div>
      <div className="login-stack">
        <BrandMark size="lg" />
        <h1 className="login-title">{needsSetup ? t('login.setup.title') : t('login.signin.title')}</h1>
        <p className="login-subtitle">
          {needsSetup
            ? t('login.setup.subtitle')
            : t('login.signin.subtitle')}
        </p>

        <form className="login-form" onSubmit={onSubmit}>
          <div className="field-stack">
            <div className="float-field">
              <input
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                placeholder=" "
                required
              />
              <label htmlFor="username">{t('login.form.username')}</label>
            </div>
            {needsSetup && (
              <div className="float-field">
                <input
                  id="setup-token"
                  type="password"
                  value={setupToken}
                  onChange={(e) => setSetupToken(e.target.value)}
                  autoComplete="off"
                  placeholder=" "
                  minLength={64}
                  maxLength={64}
                  aria-describedby="setup-token-help"
                  required
                />
                <label htmlFor="setup-token">{t('login.form.setupToken')}</label>
              </div>
            )}
            <div className="float-field">
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={needsSetup ? 'new-password' : 'current-password'}
                placeholder=" "
                aria-describedby={needsSetup ? 'password-help' : undefined}
                required
                minLength={needsSetup ? 12 : 1}
              />
              <label htmlFor="password">{t('login.form.password')}</label>
            </div>
          </div>

          {needsSetup && (
            <div className="login-notes">
              <p id="setup-token-help">
                {t('login.form.setupTokenHelp')}
              </p>
              <p id="password-help">{t('login.form.passwordHelp')}</p>
            </div>
          )}

          {error && <p className="callout callout-danger" role="alert">{error}</p>}
          <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={busy}>
            {busy ? t('login.submit.busy') : needsSetup ? t('login.submit.setup') : t('login.submit.signin')}
          </button>
        </form>
        {footer}
      </div>
    </div>
  );
}
