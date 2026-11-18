import { useRef, useState } from 'react';
import type { ChangePasswordInput, ChangePasswordResult } from '@mystry/shared';
import { api, setToken } from '../api';
import { errorMessage } from '../errors';
import { useI18n } from '../i18n';
import { newPasswordIssue } from '../validation';
import { ConfirmDialog } from './ConfirmDialog';
import { Field, FormFeedbackProvider, focusFirstInvalidField, useFormFeedback } from './Field';
import { PasswordInput } from './PasswordInput';

/**
 * 修改当前管理员密码。打开时才挂载：表单不留旧密码，输入框的 autoFocus 也不会抢走页面焦点。
 * 成功后服务端让所有旧令牌失效，这里换上响应里的新令牌，当前页面保持登录，其他设备需要重新登录。
 * 密码框可以点开看，所以不再要求把新密码输两遍。
 */
export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [changed, setChanged] = useState(false);
  const feedback = useFormFeedback();
  const fieldsRef = useRef<HTMLDivElement>(null);

  const newIssue = newPasswordIssue(newPassword);
  const canSubmit = currentPassword !== '' && newPassword !== '' && newIssue === null;

  async function submit(): Promise<void> {
    if (changed) {
      onClose();
      return;
    }
    if (busy) return;
    if (!canSubmit) {
      // 按 Enter 却提交不了时，把原因显示出来并跳到要改的那一项；没有填错、只是还空着时不标红。
      feedback.revealAll();
      focusFirstInvalidField(fieldsRef.current);
      return;
    }
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
        <FormFeedbackProvider value={feedback.value}>
          <div className="form-fields" ref={fieldsRef}>
            <Field label={t('shell.password.current')}>
              {(control) => (
                <PasswordInput
                  {...control}
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  onKeyDown={onEnter}
                  autoComplete="current-password"
                  autoFocus
                />
              )}
            </Field>
            <Field
              label={t('shell.password.new')}
              help={t('shell.password.help')}
              error={newIssue ? t(newIssue.key, newIssue.params) : null}
            >
              {(control) => (
                <PasswordInput
                  {...control}
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  onKeyDown={onEnter}
                  autoComplete="new-password"
                  maxLength={128}
                />
              )}
            </Field>
          </div>
        </FormFeedbackProvider>
      )}
    />
  );
}
