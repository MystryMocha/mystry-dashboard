import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { Archive, Download, FolderDown, History, Inbox, ListChecks, Package, RefreshCw, Rocket, X, type LucideIcon } from 'lucide-react';
import type { TaskInfo } from '@mystry/shared';
import { useI18n, type MessageKey } from '../i18n';
import { useTaskCenter } from '../task-center-store';
import { clampProgress } from './TaskProgress';

const typeLabel: Record<TaskInfo['type'], MessageKey> = {
  download: 'tasks.type.download',
  extract: 'tasks.type.extract',
  deploy: 'tasks.type.deploy',
  import: 'tasks.type.import',
  backup: 'tasks.type.backup',
  restore: 'tasks.type.restore',
};

const typeIcon: Record<TaskInfo['type'], LucideIcon> = {
  download: Download,
  extract: Package,
  deploy: Rocket,
  import: FolderDown,
  backup: Archive,
  restore: History,
};

const statusLabel: Record<TaskInfo['status'], MessageKey> = {
  pending: 'task.status.pending',
  running: 'task.status.running',
  completed: 'task.status.completed',
  failed: 'task.status.failed',
};

/**
 * A cancelled task is still failed in the data and is recognized by the key of its progress message: both ones the user cancelled and ones cancelled at panel shutdown count.
 * A cancel is not an error, so the card uses "Cancelled" and a neutral color, not the red "Failed".
 */
function isCancelled(task: TaskInfo): boolean {
  return task.status === 'failed' && task.messageI18n?.key === 'server.tasks.cancelled';
}

const TASK_TIME_FORMAT: Intl.DateTimeFormatOptions = { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' };

/** The task center button in the top bar; clicking it floats out the task list and progress from the right, like a notification center. */
export function TaskCenter() {
  const { t, tp, tm, fmt } = useI18n();
  const { tasks, error, loading, activeCount, lastSuccessAt, retry } = useTaskCenter();
  const formatTime = (iso: string | null): string => (iso ? fmt.dateTime(iso, TASK_TIME_FORMAT) : '');
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDialogElement>(null);
  const drawerId = useId();
  const titleId = useId();

  useEffect(() => {
    const dialog = drawerRef.current;
    if (!open || !dialog) return;
    dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, [open]);

  function closeDrawer() {
    drawerRef.current?.close();
    setOpen(false);
    toggleRef.current?.focus();
  }

  const stale = Boolean(error);

  return (
    <>
      <button
        ref={toggleRef}
        type="button"
        className="toolbar-button toolbar-button-labeled"
        aria-label={open ? t('tasks.center.close') : tp('tasks.center.open', activeCount)}
        aria-expanded={open}
        aria-controls={drawerId}
        onClick={() => setOpen((value) => !value)}
        title={t('tasks.center.title')}
      >
        <ListChecks size={18} aria-hidden="true" />
        <span className="toolbar-label">{t('tasks.center.title')}</span>
        {/* The number means only tasks in progress; it is not shown when no task is running, since the number of history records is not something to deal with. */}
        {activeCount > 0 && <span className="toolbar-badge is-active" aria-hidden="true">{activeCount}</span>}
      </button>

      {createPortal(<dialog
        id={drawerId}
        ref={drawerRef}
        className="task-drawer"
        onCancel={(event) => { event.preventDefault(); closeDrawer(); }}
        onClose={() => {
          // Ignore old close events left by a quick reopen or strict mode cleanup.
          if (drawerRef.current?.open) return;
          setOpen(false);
          toggleRef.current?.focus();
        }}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const rect = event.currentTarget.getBoundingClientRect();
          if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDrawer();
        }}
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="drawer-header">
          <div className="drawer-title-group">
            <h2 id={titleId} className="drawer-title">{t('tasks.center.title')}</h2>
            {activeCount > 0 && <span className="count-badge is-accent">{t('tasks.center.activeBadge', { count: fmt.number(activeCount) })}</span>}
          </div>
          <div className="drawer-tools">
            <button
              className="btn btn-icon btn-plain"
              type="button"
              title={t('tasks.center.refresh')}
              aria-label={t('tasks.center.refresh')}
              onClick={() => retry()}
            >
              <RefreshCw size={15} aria-hidden="true" />
            </button>
            <button
              className="btn btn-icon btn-plain"
              type="button"
              title={t('action.close')}
              aria-label={t('tasks.center.close')}
              onClick={closeDrawer}
            >
              <X size={17} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="drawer-body">
          {stale && (
            <div className="callout callout-danger" role="alert">
              <div>
                <strong>{t('tasks.center.stale', { error })}</strong>
                {lastSuccessAt && <p>{t('tasks.center.lastSync', { time: formatTime(lastSuccessAt) })}</p>}
              </div>
            </div>
          )}

          {loading && (
            <p className="drawer-hint">
              <span className="spinner spinner-sm" aria-hidden="true" />
              {t('tasks.center.loading')}
            </p>
          )}

          {!loading && !error && tasks.length === 0 && (
            <div className="empty-state empty-state-compact">
              <span className="empty-icon" aria-hidden="true"><Inbox size={26} /></span>
              <h3>{t('tasks.center.empty.title')}</h3>
              <p>{t('tasks.center.empty.body')}</p>
            </div>
          )}

          {tasks.map((task) => {
            const Icon = typeIcon[task.type] ?? Package;
            const active = task.status === 'pending' || task.status === 'running';
            // The message after a task ends is often the same as the status word (both "Completed"), and the duplicate one is not shown.
            const cancelled = isCancelled(task);
            const statusText = t(cancelled ? 'task.status.cancelled' : statusLabel[task.status]);
            const message = task.message ? tm(task.messageI18n, task.message) : '';
            const showMessage = message !== '' && (active || message !== statusText);
            return (
              <article key={task.id} className={`task-card status-${cancelled ? 'cancelled' : task.status}`}>
                <div className="task-card-head">
                  <span className="task-card-icon" aria-hidden="true"><Icon size={16} /></span>
                  <span className="task-card-title">{t(typeLabel[task.type])}</span>
                  <span className="task-card-status">
                    {task.status === 'running'
                      ? t('tasks.card.runningProgress', { percent: fmt.percent(task.progress, 0) })
                      : statusText}
                  </span>
                </div>

                {active && (
                  <div className="progress" role="progressbar" aria-label={t('tasks.card.progressLabel', { type: t(typeLabel[task.type]) })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={clampProgress(task.progress)}>
                    <div className="progress-fill" style={{ width: `${clampProgress(task.progress)}%` }} />
                  </div>
                )}

                {showMessage && <p className="task-card-message">{message}</p>}
                {/* The reason for a cancel (cancelled by the user, cancelled at panel shutdown) is an explanation, not an error, so no red text. */}
                {task.status === 'failed' && task.error && (
                  <p className={cancelled ? 'task-card-message' : 'task-card-error'}>{tm(task.errorI18n, task.error)}</p>
                )}

                <div className="task-card-foot">
                  <time>{formatTime(task.createdAt)}</time>
                  {task.result?.instanceId && (task.status === 'completed' || task.status === 'failed') && (
                    <Link to={`/instances/${task.result.instanceId}`} onClick={closeDrawer} className="link">
                      {t('tasks.card.viewInstance')}
                    </Link>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </dialog>, document.body)}
    </>
  );
}
