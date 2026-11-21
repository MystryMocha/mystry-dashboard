import type { Blocker } from 'react-router-dom';
import { useI18n } from '../i18n';
import { ConfirmDialog } from './ConfirmDialog';

/** Works with useUnsavedGuard: asks whether to discard changes when a navigation is blocked; during a save it only says to wait. */
export function UnsavedChangesDialog({
  blocker,
  saving,
  title,
  savingTitle,
  description,
}: {
  blocker: Blocker;
  saving: boolean;
  /** The title asking whether to discard, such as "Discard unsaved settings changes?"; the whole sentence is passed in by the caller, so each language can adjust word order. */
  title: string;
  /** The title during a save, such as "Saving settings…". */
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
