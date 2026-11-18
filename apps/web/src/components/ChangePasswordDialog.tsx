import { useId, useState } from 'react';
import type { ChangePasswordInput, ChangePasswordResult } from '@mystry/shared';
import { api, setToken } from '../api';
import { errorMessage } from '../errors';
import { useI18n } from '../i18n';
import { PASSWORD_MIN, newPasswordIssue } from '../validation';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * 修改当前管理员密码。打开时才挂载：表单不留旧密码，输入框的 autoFocus 也不会抢走页面焦点。
 * 成功后服务端让所有旧令牌失效，这里换上响应里的新令牌，当前页面保持登录，其他设备需要重新登录。
 */
export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [changed, setChanged] = useState(false);
  const currentId = useId();
  const newId = useId();
  const confirmId = useId();

  const mismatch = confirmPassword !== '' && confirmPassword !== newPassword;
  const newIssue = newPasswordIssue(newPassword);
  const canSubmit = currentPassword !== ''
    && newPassword.length >= PASSWORD_MIN
    && newIssue === null
    && confirmPassword === newPassword;

  async function submit(): Promise<void> {
    if (changed) {
      onClose();
      return;
    }
    if (!canSubmit || busy) return;
    setBusy(true);
    setError('');
    try {
      const body: ChangePasswordInput = { currentPassword, newPassword };
      const result = await api<ChangePasswordResult>('/api/auth/password', { method: 'POST', json: body });
      setToken(result.token);
      setChanged(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function onEnter(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void submit();
  }

  return (
    <ConfirmDialog
      open
      title={t('shell.user.changePassword')}
      confirmLabel={changed ? t('action.close') : t('shell.user.changePassword')}
      busy={busy}
      confirmDisabled={!changed && !canSubmit}
      error={error}
      onConfirm={() => void submit()}
      onCancel={onClose}
      description={changed ? (
        <p className="callout callout-success" role="status">{t('shell.password.changed')}</p>
      ) : (
        <>
          <div className="field">
            <label htmlFor={currentId}>{t('shell.password.current')}</label>
            <input
              id={currentId}
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              onKeyDown={onEnter}
              autoComplete="current-password"
              autoFocus
            />
          </div>
          <div className="field">
            <label htmlFor={newId}>{t('shell.password.new')}</label>
            <input
              id={newId}
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              onKeyDown={onEnter}
              autoComplete="new-password"
              maxLength={128}
              aria-invalid={newIssue !== null && newPassword.length >= PASSWORD_MIN ? true : undefined}
            />
          </div>
          <div className="field">
            <label htmlFor={confirmId}>{t('shell.password.confirm')}</label>
            <input
              id={confirmId}
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              onKeyDown={onEnter}
              autoComplete="new-password"
              maxLength={128}
              aria-invalid={mismatch}
            />
          </div>
          {/* 长度不够时说明文字已经写了 12 位；只有超长（含按字节超出）才单独报错。 */}
          {mismatch ? <p className="error">{t('shell.password.mismatch')}</p>
            : newIssue && newPassword.length >= PASSWORD_MIN ? <p className="error">{t(newIssue.key, newIssue.params)}</p>
              : <p className="muted">{t('shell.password.help')}</p>}
        </>
      )}
    />
  );
}
