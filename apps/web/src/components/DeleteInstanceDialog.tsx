import { useEffect, useState } from 'react';
import type { InstanceInfo } from '@mystry/shared';
import { api, instanceApi } from '../api';
import { errorMessage } from '../errors';
import { useI18n } from '../i18n';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * Confirmation dialog for deleting an instance, shared by the overview and instance settings.
 * The instance name has to be typed to confirm, and deleting the backups along with it is optional; for an instance pending migration only the record is removed and no files are deleted.
 * The delete request is sent here: on failure the dialog stays open with the reason shown inside it, and the caller is notified only on success.
 */
export function DeleteInstanceDialog({
  instance,
  onDeleted,
  onCancel,
}: {
  /** The instance to delete; the dialog is closed when null. */
  instance: InstanceInfo | null;
  onDeleted: (instance: InstanceInfo) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [deleteBackups, setDeleteBackups] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const instanceId = instance?.id;

  // Every open returns to the defaults: delete along with backups, without the previous failure message.
  useEffect(() => {
    if (!instanceId) return;
    setDeleteBackups(true);
    setError('');
  }, [instanceId]);

  const recordOnly = instance?.requiresMigration ?? false;
  const name = instance?.name ?? '';

  async function confirm() {
    if (!instance || busy) return;
    const query = !recordOnly && !deleteBackups ? '?keepBackups=1' : '';
    setBusy(true);
    setError('');
    try {
      await api(`${instanceApi(instance.id)}${query}`, { method: 'DELETE' });
      onDeleted(instance);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConfirmDialog
      open={instance !== null}
      title={recordOnly ? t('dashboard.removeRecord.title', { name }) : t('dashboard.delete.title', { name })}
      description={
        recordOnly
          ? t('dashboard.removeRecord.body')
          : (
            <>
              <p>{t('dashboard.delete.body')}</p>
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={deleteBackups}
                  disabled={busy}
                  onChange={(e) => setDeleteBackups(e.target.checked)}
                />
                <span>{t('dashboard.delete.deleteBackups')}</span>
              </label>
              {!deleteBackups && <p className="muted">{t('dashboard.delete.keepBackupsNote')}</p>}
            </>
          )
      }
      confirmLabel={recordOnly ? t('dashboard.removeRecord.confirm') : t('action.deletePermanently')}
      danger
      busy={busy}
      error={error}
      requireText={recordOnly ? undefined : instance?.name}
      onConfirm={() => void confirm()}
      onCancel={onCancel}
    />
  );
}
