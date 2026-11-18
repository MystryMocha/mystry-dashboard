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

// 与服务端初始化管理员的规则一致：用户名去掉首尾空格后 2–64 个字符。
const USERNAME_MIN = 2;
const USERNAME_MAX = 64;

/** 用户名已经填了但不合规时给出原因；空用户名只让按钮不可点，不提前报错。 */
function usernameIssue(username: string): Issue | null {
  const name = username.trim();
  if (name && charCount(name) < USERNAME_MIN) return { key: 'server.auth.usernameTooShort', params: { min: USERNAME_MIN } };
  if (charCount(name) > USERNAME_MAX) return { key: 'server.auth.usernameTooLong', params: { max: USERNAME_MAX } };
  return null;
}

/** 把几个可能为空的 id 拼成 aria-describedby。 */
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
      {/* 字段的显示时机要从上下文里读「是否要求全部显示」，所以表单拆成子组件放在 Provider 里面。 */}
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
  // 粘贴后要放回的光标位置：受控输入框改值后光标会跑到末尾。
  const tokenCaretRef = useRef<number | null>(null);

  // 「合不合法」每次渲染都算，决定按钮；红字什么时候出现由 useFieldFeedback 管（失焦过，或按了 Enter）。
  // 登录状态不做这些检查。
  const nameIssue = needsSetup ? usernameIssue(username) : null;
  const tokenIssue = needsSetup ? setupTokenIssue(setupToken) : null;
  const passwordIssue = needsSetup ? newPasswordIssue(password) : null;
  const nameError = nameIssue ? t(nameIssue.key, nameIssue.params) : null;
  const tokenError = tokenIssue ? t(tokenIssue.key, tokenIssue.params) : null;
  const passwordError = passwordIssue ? t(passwordIssue.key, passwordIssue.params) : null;
  const nameFeedback = useFieldFeedback(nameError);
  const tokenFeedback = useFieldFeedback(tokenError);
  const passwordFeedback = useFieldFeedback(passwordError);

  // 只有初始化按规则禁用。登录按钮不预先禁用：浏览器自动填充的密码在用户操作前可能还没进 React 状态，
  // 禁用后连回车都提交不了；空字段由输入框的 required 拦住。
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
   * 初始化按钮禁用时浏览器不会因为 Enter 触发 submit，这里自己接：把各字段的原因显示出来，跳到第一个要改的。
   * 可以提交时不拦，交给原生 submit；登录状态也不拦。
   */
  function onKeyDown(e: React.KeyboardEvent<HTMLFormElement>) {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    // 只管输入框里的 Enter，密码显示按钮上的 Enter 仍然是切换显示。
    if (!(e.target instanceof HTMLInputElement)) return;
    if (!needsSetup || busy || canSubmit) return;
    e.preventDefault();
    if (nameIssue || tokenIssue || passwordIssue) {
      revealAll();
      focusFirstInvalidField(e.currentTarget);
      return;
    }
    // 没有填错、只是还空着：只把焦点带到第一个没填的。这时不能 revealAll，
    // 否则接下来在空框里输的第一个字符就会报错。
    if (username.trim() === '') focusField('username');
    else if (setupToken === '') focusField('setup-token');
    else if (password === '') focusField('password');
  }

  /** 从配置文件复制时常带上行尾换行或空格：粘贴时去掉首尾空白，再放进当前选区。 */
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
      <p className="login-subtitle">
        {needsSetup
          ? t('login.setup.subtitle')
          : t('login.signin.subtitle')}
      </p>

      <form className="login-form" onSubmit={onSubmit} onKeyDown={onKeyDown}>
        <div className="field-stack">
          {/* data-field-invalid 不管红字显没显示都标着，focusFirstInvalidField 靠它找到第一个要改的字段。 */}
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
              {/* 令牌是从配置文件里复制的，用等宽的普通文本框，贴了什么看得见。
                  不设 maxLength：浏览器会先截断再交给页面，多贴的字符就看不出来了，也数不对。 */}
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
                {/* 实时计数：不用失焦就能看出少贴了几位。读屏通过 aria-describedby 读到。 */}
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
              aria-describedby={describedBy(passwordFeedback.shown && 'password-error', needsSetup && 'password-help')}
              aria-invalid={passwordFeedback.shown ? true : undefined}
              required
              minLength={needsSetup ? 12 : 1}
              // 浮动标签靠「input + label」相邻选择器定位，要紧跟在输入框后面。
              after={<label htmlFor="password">{t('login.form.password')}</label>}
            />
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
