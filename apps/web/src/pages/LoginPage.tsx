import { useLayoutEffect, useRef, useState } from 'react';
import { BrandMark } from '../components/BrandMark';
import { FormFeedbackProvider, focusField, focusFirstInvalidField, useFieldFeedback, useFormFeedback } from '../components/Field';
import { LanguageToggle } from '../components/LanguageToggle';
import { PasswordInput } from '../components/PasswordInput';
import { ThemeToggle } from '../components/ThemeToggle';
import { useAuth } from '../auth';
import { errorMessage } from '../errors';
import { useI18n } from '../i18n';
import { SETUP_TOKEN_LENGTH, charCount, newPasswordIssue, setupTokenIssue, type Issue } from '../validation';

// Same as the server's rules for setting up the admin: the username is 2–64 characters after trimming.
const USERNAME_MIN = 2;
const USERNAME_MAX = 64;

/** Gives the reason when the username is filled in but does not comply; an empty username only disables the button, without reporting early. */
function usernameIssue(username: string): Issue | null {
  const name = username.trim();
  if (name && charCount(name) < USERNAME_MIN) return { key: 'server.auth.usernameTooShort', params: { min: USERNAME_MIN } };
  if (charCount(name) > USERNAME_MAX) return { key: 'server.auth.usernameTooLong', params: { max: USERNAME_MAX } };
  return null;
}

/** Joins several possibly empty ids into aria-describedby. */
function describedBy(...ids: (string | false | null | undefined)[]): string | undefined {
  return ids.filter(Boolean).join(' ') || undefined;
}

export function LoginPage() {
  const { t } = useI18n();
  const { statusError, refresh } = useAuth();
  const [checking, setChecking] = useState(false);
  const feedback = useFormFeedback();

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
      {/* When a field shows feedback depends on reading "whether everything is asked to show" from context, so the form is split into a child component placed inside the Provider. */}
      <FormFeedbackProvider value={feedback.value}>
        <CredentialForm revealAll={feedback.revealAll} footer={footer} />
      </FormFeedbackProvider>
    </div>
  );
}

function CredentialForm({ revealAll, footer }: { revealAll: () => void; footer: React.ReactNode }) {
  const { t } = useI18n();
  const { needsSetup, login, setup } = useAuth();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submittingRef = useRef(false);
  const tokenRef = useRef<HTMLInputElement>(null);
  // The caret position to put back after a paste: after a controlled input's value changes, the caret jumps to the end.
  const tokenCaretRef = useRef<number | null>(null);

  // "Whether it is valid" is computed on every render and decides the button; when the red text appears is managed by useFieldFeedback (after blur, or after Enter is pressed).
  // These checks are not done in the sign-in state.
  const nameIssue = needsSetup ? usernameIssue(username) : null;
  const tokenIssue = needsSetup ? setupTokenIssue(setupToken) : null;
  const passwordIssue = needsSetup ? newPasswordIssue(password) : null;
  const nameError = nameIssue ? t(nameIssue.key, nameIssue.params) : null;
  const tokenError = tokenIssue ? t(tokenIssue.key, tokenIssue.params) : null;
  const passwordError = passwordIssue ? t(passwordIssue.key, passwordIssue.params) : null;
  const nameFeedback = useFieldFeedback(nameError);
  const tokenFeedback = useFieldFeedback(tokenError);
  const passwordFeedback = useFieldFeedback(passwordError);

  // Only setup is disabled by rules. The sign-in button is not disabled in advance: a password autofilled by the browser may not have reached React state before the user interacts,
  // and once disabled even Enter could not submit; empty fields are blocked by the inputs' required.
  const canSubmit = !busy && (!needsSetup
    || (username.trim() !== '' && password !== '' && setupToken.length === SETUP_TOKEN_LENGTH
      && nameIssue === null && tokenIssue === null && passwordIssue === null));

  useLayoutEffect(() => {
    if (tokenCaretRef.current === null) return;
    tokenRef.current?.setSelectionRange(tokenCaretRef.current, tokenCaretRef.current);
    tokenCaretRef.current = null;
  }, [setupToken]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submittingRef.current || !canSubmit) return;
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

  /**
   * While the setup button is disabled the browser does not trigger submit on Enter, so it is handled here: show each field's reason and jump to the first one to fix.
   * When it can be submitted nothing is intercepted and the native submit takes over; the sign-in state is not intercepted either.
   */
  function onKeyDown(e: React.KeyboardEvent<HTMLFormElement>) {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    // Only Enter in inputs is handled; Enter on the password show button still toggles visibility.
    if (!(e.target instanceof HTMLInputElement)) return;
    if (!needsSetup || busy || canSubmit) return;
    e.preventDefault();
    if (nameIssue || tokenIssue || passwordIssue) {
      revealAll();
      focusFirstInvalidField(e.currentTarget);
      return;
    }
    // Nothing filled in wrong, just still empty: only bring focus to the first unfilled one. revealAll must not be used here,
    // or the first character typed next into the empty box would report an error.
    if (username.trim() === '') focusField('username');
    else if (setupToken === '') focusField('setup-token');
    else if (password === '') focusField('password');
  }

  /** Copying from the config file often brings a trailing line break or spaces: on paste, surrounding whitespace is trimmed before it is put into the current selection. */
  function onTokenPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData('text');
    const trimmed = text.trim();
    if (trimmed === text) return;
    e.preventDefault();
    const input = e.currentTarget;
    const start = input.selectionStart ?? setupToken.length;
    const end = input.selectionEnd ?? start;
    tokenCaretRef.current = start + trimmed.length;
    setSetupToken(setupToken.slice(0, start) + trimmed + setupToken.slice(end));
  }

  return (
    <div className="login-stack">
      <BrandMark size="lg" />
      <h1 className="login-title">{needsSetup ? t('login.setup.title') : t('login.signin.title')}</h1>
      {needsSetup && <p className="login-subtitle">{t('login.setup.subtitle')}</p>}

      <form className="login-form" onSubmit={onSubmit} onKeyDown={onKeyDown}>
        <div className="field-stack">
          {/* data-field-invalid is set whether or not the red text is showing, and focusFirstInvalidField uses it to find the first field to fix. */}
          <div className="float-field" data-field-invalid={nameError ? '' : undefined}>
            <input
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onBlur={nameFeedback.onBlur}
              autoComplete="username"
              placeholder=" "
              aria-describedby={describedBy(nameFeedback.shown && 'username-error')}
              aria-invalid={nameFeedback.shown ? true : undefined}
              required
            />
            <label htmlFor="username">{t('login.form.username')}</label>
          </div>
          {needsSetup && (
            <div className="float-field" data-field-invalid={tokenError ? '' : undefined}>
              {/* The token is copied from the config file, so a monospace plain text box is used and what was pasted is visible.
                  No maxLength: the browser would truncate before handing it to the page, so extra pasted characters could not be seen or counted correctly. */}
              <span className="input-affix">
                <input
                  ref={tokenRef}
                  id="setup-token"
                  className="token-input"
                  type="text"
                  value={setupToken}
                  onChange={(e) => setSetupToken(e.target.value)}
                  onPaste={onTokenPaste}
                  onBlur={tokenFeedback.onBlur}
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder=" "
                  aria-describedby={describedBy(tokenFeedback.shown && 'setup-token-error', 'setup-token-count', 'setup-token-help')}
                  aria-invalid={tokenFeedback.shown ? true : undefined}
                  required
                />
                <label htmlFor="setup-token">{t('login.form.setupToken')}</label>
                {/* Live count: how many characters are missing is visible without blurring. Screen readers get it through aria-describedby. */}
                <span className="input-affix-text" id="setup-token-count">
                  {t('login.form.setupTokenCount', { count: setupToken.length, max: SETUP_TOKEN_LENGTH })}
                </span>
              </span>
            </div>
          )}
          <div className="float-field" data-field-invalid={passwordError ? '' : undefined}>
            <PasswordInput
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onBlur={passwordFeedback.onBlur}
              autoComplete={needsSetup ? 'new-password' : 'current-password'}
              placeholder=" "
              aria-describedby={describedBy(passwordFeedback.shown && 'password-error', needsSetup && !passwordFeedback.shown && 'password-help')}
              aria-invalid={passwordFeedback.shown ? true : undefined}
              required
              minLength={needsSetup ? 12 : 1}
              // The floating label is positioned with the "input + label" adjacent selector, so it has to come right after the input.
              after={<label htmlFor="password">{t('login.form.password')}</label>}
            />
          </div>
        </div>

        {needsSetup && (
          <div className="login-notes">
            <p id="setup-token-help">
              {t('login.form.setupTokenHelp')}
            </p>
            {/* When the password error appears it is about the length too, so this description is not repeated. */}
            {!passwordFeedback.shown && <p id="password-help">{t('login.form.passwordHelp')}</p>}
          </div>
        )}

        {nameFeedback.shown && <p className="error" id="username-error">{nameError}</p>}
        {tokenFeedback.shown && <p className="error" id="setup-token-error">{tokenError}</p>}
        {passwordFeedback.shown && <p className="error" id="password-error">{passwordError}</p>}
        {error && <p className="callout callout-danger" role="alert">{error}</p>}
        <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={!canSubmit}>
          {busy ? t('login.submit.busy') : needsSetup ? t('login.submit.setup') : t('login.submit.signin')}
        </button>
      </form>
      {footer}
    </div>
  );
}
