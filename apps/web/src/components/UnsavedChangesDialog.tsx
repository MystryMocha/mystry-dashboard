import type { Blocker } from 'react-router-dom';
import { ConfirmDialog } from './ConfirmDialog';

/** 配合 useUnsavedGuard：导航被拦下时询问是否放弃修改；保存期间只提示等待。 */
export function UnsavedChangesDialog({
  blocker,
  saving,
  subject,
  description,
}: {
  blocker: Blocker;
  saving: boolean;
  /** 被编辑的对象，如「设置」「配置」。 */
  subject: string;
  description: string;
}) {
  return (
    <ConfirmDialog
      open={blocker.state === 'blocked'}
      title={saving ? `正在保存${subject}…` : `放弃未保存的${subject}修改？`}
      description={saving ? '保存完成后会自动继续离开；保存期间无法放弃或取消。' : description}
      confirmLabel="放弃修改并离开"
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
