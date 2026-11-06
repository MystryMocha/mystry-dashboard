import { useId, useState } from 'react';
import type { ChangePasswordInput } from '@mystry/shared';
import { api } from '../api';
import { errorMessage } from '../errors';
import { useI18n } from '../i18n';
import { ConfirmDialog } from './ConfirmDialog';

const PASSWORD_MIN_LENGTH = 12;

/** 修改当前管理员密码。打开时才挂载：表单不留旧密码，输入框的 autoFocus 也不会抢走页面焦点。 */
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
  const canSubmit = currentPassword !== ''
    && newPassword.length >= PASSWORD_MIN_LENGTH
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
      await api('/api/auth/password', { method: 'POST', json: body });
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
          <p className="muted">{mismatch ? t('shell.password.mismatch') : t('shell.password.help')}</p>
        </>
      )}
    />
  );
}
