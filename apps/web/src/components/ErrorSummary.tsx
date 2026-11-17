import { useEffect, useId, useState } from 'react';
import { copyText } from '../clipboard';
import { useDialogOpen } from '../hooks/useDialogOpen';
import { useI18n } from '../i18n';
import '../deploy-error.css';

// 页面只保留紧凑摘要，完整错误交给受限尺寸的详情弹窗展示。
const ERROR_PREVIEW_MAX_LENGTH = 240;

function createErrorPreview(message: string): string {
  const normalized = message.replace(/\s+/g, ' ').trim();
  if (normalized.length <= ERROR_PREVIEW_MAX_LENGTH) return normalized;
  return `${normalized.slice(0, ERROR_PREVIEW_MAX_LENGTH - 1)}…`;
}

/**
 * 长错误的摘要卡片：可复制全文，内容较长时可打开详情弹窗。
 * 调用方以错误文本作为 key，错误变化时复制状态和弹窗随之重置。
 */
export function ErrorSummary({
  title,
  detailTitle,
  error,
}: {
  title: string;
  detailTitle: string;
  error: string;
}) {
  const { t } = useI18n();
  const [showDetails, setShowDetails] = useState(false);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const dialogRef = useDialogOpen(showDetails);
  const titleId = useId();
  const dialogTitleId = useId();
  const hasDetails = error.includes('\n') || error.length > ERROR_PREVIEW_MAX_LENGTH;

  useEffect(() => {
    if (copyStatus === 'idle') return;
    const timer = window.setTimeout(() => setCopyStatus('idle'), 2_000);
    return () => window.clearTimeout(timer);
  }, [copyStatus]);

  async function copyError(): Promise<void> {
    setCopyStatus(await copyText(error) ? 'copied' : 'failed');
  }

  return (
    <>
      <section className="error-summary" role="alert" aria-labelledby={titleId}>
        <div className="error-summary-content">
          <strong id={titleId}>{title}</strong>
          <p>{createErrorPreview(error)}</p>
        </div>
        <div className="error-summary-actions">
          <button className="btn btn-sm" type="button" onClick={() => void copyError()}>
            {copyStatus === 'copied'
              ? t('dialog.error.copied')
              : copyStatus === 'failed'
                ? t('dialog.error.copyFailed')
                : t('dialog.error.copy')}
          </button>
          {hasDetails && (
            <button className="btn btn-sm" type="button" onClick={() => setShowDetails(true)}>
              {t('dialog.error.viewDetails')}
            </button>
          )}
        </div>
      </section>

      <dialog
        ref={dialogRef}
        className="error-dialog"
        aria-labelledby={dialogTitleId}
        onClose={() => setShowDetails(false)}
        onCancel={(event) => {
          event.preventDefault();
          setShowDetails(false);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          setShowDetails(false);
        }}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) setShowDetails(false);
        }}
      >
        <div className="error-dialog-panel">
          <header className="error-dialog-header">
            <div>
              <h2 id={dialogTitleId}>{detailTitle}</h2>
              <p>{t('dialog.error.detailHint')}</p>
            </div>
            <button
              className="btn btn-plain"
              type="button"
              aria-label={t('dialog.error.closeLabel')}
              onClick={() => setShowDetails(false)}
            >
              {t('action.close')}
            </button>
          </header>
          <pre className="error-dialog-output">{error}</pre>
          <footer className="error-dialog-footer">
            <span className="muted" aria-live="polite">
              {copyStatus === 'copied'
                ? t('dialog.error.copiedStatus')
                : copyStatus === 'failed'
                  ? t('dialog.error.copyFailedStatus')
                  : ''}
            </span>
            <button className="btn btn-primary" type="button" onClick={() => void copyError()}>
              {copyStatus === 'copied' ? t('dialog.error.copied') : t('dialog.error.copyAll')}
            </button>
          </footer>
        </div>
      </dialog>
    </>
  );
}
