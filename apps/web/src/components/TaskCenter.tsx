import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { Download, FolderDown, Inbox, ListChecks, Package, RefreshCw, Rocket, X, type LucideIcon } from 'lucide-react';
import type { TaskInfo } from '@mystry/shared';
import { useTaskCenter } from '../task-center-store';
import { clampProgress } from './TaskProgress';

const typeLabel: Record<TaskInfo['type'], string> = {
  download: '下载核心',
  extract: '解压文件',
  deploy: '部署实例',
  import: '导入服务端',
};

const typeIcon: Record<TaskInfo['type'], LucideIcon> = {
  download: Download,
  extract: Package,
  deploy: Rocket,
  import: FolderDown,
};

const statusLabel: Record<TaskInfo['status'], string> = {
  pending: '排队中',
  running: '进行中',
  completed: '已完成',
  failed: '失败',
};

function formatTime(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** 顶栏的任务中心按钮，点击后像通知中心一样从右侧浮出任务列表与进度。 */
export function TaskCenter() {
  const { tasks, error, loading, activeCount, lastSuccessAt, retry } = useTaskCenter();
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
        aria-label={open ? '关闭任务中心' : `打开任务中心，${activeCount} 个任务进行中`}
        aria-expanded={open}
        aria-controls={drawerId}
        onClick={() => setOpen((value) => !value)}
        title="任务中心"
      >
        <ListChecks size={18} aria-hidden="true" />
        <span className="toolbar-label">任务中心</span>
        {activeCount > 0 ? (
          <span className="toolbar-badge is-active" aria-hidden="true">{activeCount}</span>
        ) : tasks.length > 0 ? (
          <span className="toolbar-badge" aria-hidden="true">{tasks.length}</span>
        ) : null}
      </button>

      {createPortal(<dialog
        id={drawerId}
        ref={drawerRef}
        className="task-drawer"
        onCancel={(event) => { event.preventDefault(); closeDrawer(); }}
        onClose={() => {
          // 忽略快速重开或严格模式清理留下的旧关闭事件。
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
            <h2 id={titleId} className="drawer-title">任务中心</h2>
            {activeCount > 0 && <span className="count-badge is-accent">{activeCount} 进行中</span>}
          </div>
          <div className="drawer-tools">
            <button
              className="btn btn-icon btn-plain"
              type="button"
              title="刷新任务"
              aria-label="刷新任务"
              onClick={() => retry()}
            >
              <RefreshCw size={15} aria-hidden="true" />
            </button>
            <button
              className="btn btn-icon btn-plain"
              type="button"
              title="关闭"
              aria-label="关闭任务中心"
              onClick={closeDrawer}
            >
              <X size={17} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="drawer-body">
          {stale && (
            <div className="callout callout-danger">
              <div>
                <strong>状态可能已过期：{error}</strong>
                {lastSuccessAt && <p>上次成功同步：{formatTime(lastSuccessAt)}</p>}
              </div>
            </div>
          )}

          {loading && (
            <p className="drawer-hint">
              <span className="spinner spinner-sm" aria-hidden="true" />
              正在读取任务列表…
            </p>
          )}

          {!loading && !error && tasks.length === 0 && (
            <div className="empty-state empty-state-compact">
              <span className="empty-icon" aria-hidden="true"><Inbox size={26} /></span>
              <h3>暂无任务</h3>
              <p>开始部署或导入后，进度会显示在这里。</p>
            </div>
          )}

          {tasks.map((task) => {
            const Icon = typeIcon[task.type] ?? Package;
            const active = task.status === 'pending' || task.status === 'running';
            return (
              <article key={task.id} className={`task-card status-${task.status}`}>
                <div className="task-card-head">
                  <span className="task-card-icon" aria-hidden="true"><Icon size={16} /></span>
                  <span className="task-card-title">{typeLabel[task.type]}</span>
                  <span className="task-card-status">
                    {task.status === 'running' ? `${task.progress}% 进行中` : statusLabel[task.status]}
                  </span>
                </div>

                {active && (
                  <div className="progress" role="progressbar" aria-label={`${typeLabel[task.type]}进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={clampProgress(task.progress)}>
                    <div className="progress-fill" style={{ width: `${clampProgress(task.progress)}%` }} />
                  </div>
                )}

                {task.message && <p className="task-card-message">{task.message}</p>}
                {task.status === 'failed' && task.error && <p className="task-card-error">{task.error}</p>}

                <div className="task-card-foot">
                  <time>{formatTime(task.createdAt)}</time>
                  {task.result?.instanceId && (task.status === 'completed' || task.status === 'failed') && (
                    <Link to={`/instances/${task.result.instanceId}`} onClick={closeDrawer} className="link">
                      查看实例 →
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
