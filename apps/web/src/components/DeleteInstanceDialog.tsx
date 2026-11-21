import { useEffect, useState } from 'react';
import type { InstanceInfo } from '@mystry/shared';
import { api, instanceApi } from '../api';
import { errorMessage } from '../errors';
import { useI18n } from '../i18n';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * 删除实例的确认框，总览和实例设置共用。
 * 要输入实例名才能确认，可以选择是否连同备份删除；待迁移的实例只移除记录，不删文件。
 * 删除请求在这里发：失败时弹窗不关、原因显示在弹窗里，成功后才通知调用方。
 */
export function DeleteInstanceDialog({
  instance,
  onDeleted,
  onCancel,
}: {
  /** 要删除的实例；为 null 时弹窗关闭。 */
  instance: InstanceInfo | null;
  onDeleted: (instance: InstanceInfo) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [deleteBackups, setDeleteBackups] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const instanceId = instance?.id;

  // 每次打开都回到默认：连同备份删除，不带上一次的失败提示。
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
