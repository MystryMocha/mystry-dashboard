import { useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../i18n';

/**
 * Generic confirmation dialog: replaces the native confirm().
 * When requireText is passed, exactly matching text must be typed to confirm (for high-risk actions such as deleting an instance).
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
  /** Disables confirm while the form content has not passed validation, without entering the busy lock. */
  confirmDisabled?: boolean;
  /** Exactly matching confirmation text is required (such as the instance name) */
  requireText?: string;
  /** Message for a failed action: shown inside the dialog (the rest of the page is unreachable while the modal is open), and announced by screen readers as soon as it appears. */
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
  /** Cancel fires only once within one open cycle, so the close event and the button's onClick do not both call it. */
  const cancelHandledRef = useRef(false);

  function handleCancel(): void {
    // While the request is running, Escape, the backdrop and the close event are not allowed to bypass the busy lock.
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

  // With a long form the error may be outside the visible area, so it is scrolled into view when it appears.
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
          {/* A role="alert" element is announced by screen readers as soon as it is inserted; it sits at the end of the scrollable body, right next to the confirm button. */}
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
