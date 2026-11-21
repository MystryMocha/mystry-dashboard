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
 * Changes the current admin's password. Mounted only when opened: the form keeps no old password, and the input's autoFocus does not steal page focus.
 * On success the server invalidates all old tokens; the new token from the response is swapped in here, so the current page stays signed in and other devices have to sign in again.
 * The password box can be revealed, so the new password is no longer required to be typed twice.
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
      // When Enter is pressed but it cannot submit, show the reason and jump to the item to fix; when nothing is wrong and it is just still empty, nothing is marked red.
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
              errorReplacesHelp
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
