import type { Blocker } from 'react-router-dom';
import { useI18n } from '../i18n';
import { ConfirmDialog } from './ConfirmDialog';

/** 配合 useUnsavedGuard：导航被拦下时询问是否放弃修改；保存期间只提示等待。 */
export function UnsavedChangesDialog({
  blocker,
  saving,
  title,
  savingTitle,
  description,
}: {
  blocker: Blocker;
  saving: boolean;
  /** 询问是否放弃的标题，如「放弃未保存的设置修改？」；整句由调用方传入，便于各语言调整语序。 */
  title: string;
  /** 保存期间的标题，如「正在保存设置…」。 */
  savingTitle: string;
  description: string;
}) {
  const { t } = useI18n();
  return (
    <ConfirmDialog
      open={blocker.state === 'blocked'}
      title={saving ? savingTitle : title}
      description={saving ? t('instance.unsaved.savingDescription') : description}
      confirmLabel={t('instance.unsaved.confirm')}
      danger={!saving}
      busy={saving}
      onConfirm={() => {
        if (!saving && blocker.state === 'blocked') blocker.proceed();
      }}
      onCancel={() => {
        if (!saving && blocker.state === 'blocked') blocker.reset();
      }}
    />
  );
}
