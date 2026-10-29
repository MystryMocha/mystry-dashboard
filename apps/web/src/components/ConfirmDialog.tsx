import { useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../i18n';

/**
 * 通用确认弹窗：替代原生 confirm()。
 * 传入 requireText 时，必须输入完全一致的文本才能确认（用于删除实例等高危操作）。
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel: confirmLabelProp,
  danger = false,
  busy = false,
  confirmDisabled = false,
  requireText,
  error = '',
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  /** 表单内容尚未通过校验时禁用确认，但不进入 busy 锁。 */
  confirmDisabled?: boolean;
  /** 需要输入完全一致的确认文本（如实例名） */
  requireText?: string;
  /** 操作失败的提示：显示在弹窗内（模态打开时页面其余部分不可达），出现时由读屏立即播报。 */
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const confirmLabel = confirmLabelProp ?? t('action.confirm');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState('');
  const titleId = useId();
  const inputId = useId();
  const errorId = useId();
  const errorRef = useRef<HTMLParagraphElement>(null);
  /** 同一打开周期内只触发一次取消，避免 close 事件与按钮 onClick 双路径重复调用。 */
  const cancelHandledRef = useRef(false);

  function handleCancel(): void {
    // 请求执行期间禁止 Escape、遮罩和关闭事件绕过 busy 锁。
    if (busy || cancelHandledRef.current) return;
    cancelHandledRef.current = true;
    onCancel();
  }

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (open) setTyped('');
    cancelHandledRef.current = false;
  }, [open]);

  // 表单较长时错误可能在可视区外，出现时滚到可见位置。
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [error]);

  const needText = Boolean(requireText);
  const canConfirm = !busy && !confirmDisabled && (!needText || typed === requireText);

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog"
      aria-labelledby={titleId}
      aria-describedby={error ? errorId : undefined}
      onClose={handleCancel}
      onCancel={(event) => {
        event.preventDefault();
        handleCancel();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) handleCancel();
      }}
    >
      <div className="confirm-dialog-panel">
        <h2 id={titleId} className="confirm-dialog-title">
          {title}
        </h2>
        <div className="confirm-dialog-body">
          {description}
          {needText && (
            <div className="field">
              <label htmlFor={inputId}>
                {t('dialog.confirm.requireText', { text: requireText ?? '' })}
              </label>
              <input
                id={inputId}
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                autoComplete="off"
                autoFocus
              />
            </div>
          )}
          {/* role="alert" 元素插入时读屏会立即播报；放在可滚动正文末尾，紧挨确认按钮。 */}
          {error && (
            <p ref={errorRef} id={errorId} className="callout callout-danger" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="confirm-dialog-footer">
          <button className="btn" type="button" disabled={busy} onClick={handleCancel}>
            {t('action.cancel')}
          </button>
          <button
            className={`btn ${danger ? 'btn-destructive' : 'btn-primary'}`}
            type="button"
            disabled={!canConfirm}
            onClick={onConfirm}
          >
            {busy ? t('dialog.confirm.busy') : confirmLabel}
          </button>
        </footer>
      </div>
    </dialog>
  );
}
