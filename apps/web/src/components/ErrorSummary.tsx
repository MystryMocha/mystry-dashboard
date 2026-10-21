import { useEffect, useId, useState } from 'react';
import { useDialogOpen } from '../hooks/useDialogOpen';
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
    try {
      await navigator.clipboard.writeText(error);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    }
  }

  return (
    <>
      <section className="error-summary" role="alert" aria-labelledby={titleId}>
        <div className="error-summary-content">
          <strong id={titleId}>{title}</strong>
          <p>{createErrorPreview(error)}</p>
        </div>
        <div className="error-summary-actions">
          <button className="btn btn-ghost" type="button" onClick={() => void copyError()}>
            {copyStatus === 'copied' ? '已复制' : copyStatus === 'failed' ? '复制失败' : '复制错误'}
          </button>
          {hasDetails && (
            <button className="btn btn-ghost" type="button" onClick={() => setShowDetails(true)}>
              查看详情
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
              <p>完整错误内容，可复制后用于排查。</p>
            </div>
            <button
              className="btn btn-ghost"
              type="button"
              aria-label="关闭错误详情"
              onClick={() => setShowDetails(false)}
            >
              关闭
            </button>
          </header>
          <pre className="error-dialog-output">{error}</pre>
          <footer className="error-dialog-footer">
            <span className="muted" aria-live="polite">
              {copyStatus === 'copied'
                ? '错误内容已复制到剪贴板'
                : copyStatus === 'failed'
                  ? '复制失败，请在内容区域中手动选择复制'
                  : ''}
            </span>
            <button className="btn" type="button" onClick={() => void copyError()}>
              {copyStatus === 'copied' ? '已复制' : '复制全部'}
            </button>
          </footer>
        </div>
      </dialog>
    </>
  );
}
