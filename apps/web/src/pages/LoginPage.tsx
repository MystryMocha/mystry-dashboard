import { useRef, useState } from 'react';
import { BrandMark } from '../components/BrandMark';
import { ThemeToggle } from '../components/ThemeToggle';
import { useAuth } from '../auth';
import { errorMessage } from '../errors';

export function LoginPage() {
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

  const footer = <p className="login-footer">Mystry Dashboard v{__APP_VERSION__} · Minecraft Java 服务端管理面板</p>;

  if (statusError) {
    return (
      <div className="login-page">
        <div className="login-appearance">
          <ThemeToggle placement="login" />
        </div>
        <div className="login-stack">
          <BrandMark size="lg" />
          <h1 className="login-title">面板服务不可用</h1>
          <p className="callout callout-danger" role="alert">{statusError}</p>
          <button className="btn btn-primary btn-lg btn-block" type="button" disabled={checking} onClick={() => void recheck()}>
            {checking ? '正在检查…' : '重新检查'}
          </button>
          {footer}
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-appearance">
        <ThemeToggle placement="login" />
      </div>
      <div className="login-stack">
        <BrandMark size="lg" />
        <h1 className="login-title">{needsSetup ? '初始化管理员' : '登录面板'}</h1>
        <p className="login-subtitle">
          {needsSetup
            ? '首次启动，请创建管理员账号。'
            : '使用管理员账号登录 Mystry Dashboard。'}
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
              <label htmlFor="username">用户名</label>
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
                <label htmlFor="setup-token">初始化令牌</label>
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
              <label htmlFor="password">密码</label>
            </div>
          </div>

          {needsSetup && (
            <div className="login-notes">
              <p id="setup-token-help">
                用启动器打开面板时，令牌已自动复制到剪贴板，按 Ctrl+V 粘贴即可。剪贴板里没有时，请打开面板配置文件（便携版和 Linux 为 config/panel.env，Windows 源码版为 .env），复制 SETUP_TOKEN 的值。
              </p>
              <p id="password-help">密码至少 12 个字符，请牢记，面板暂不支持找回密码。</p>
            </div>
          )}

          {error && <p className="callout callout-danger" role="alert">{error}</p>}
          <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={busy}>
            {busy ? '处理中…' : needsSetup ? '创建并进入' : '登录'}
          </button>
        </form>
        {footer}
      </div>
    </div>
  );
}
