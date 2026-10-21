import type { TaskInfo } from '@mystry/shared';

/** 把任务进度截到 0–100，非有限值按 0 处理。 */
export function clampProgress(progress: number): number {
  return Number.isFinite(progress) ? Math.min(100, Math.max(0, progress)) : 0;
}

/** 部署、导入页的任务进度：当前步骤文案加进度条。 */
export function TaskProgress({ task, label }: { task: TaskInfo; label: string }) {
  const value = clampProgress(task.progress);
  return (
    <div className="task-progress" aria-live="polite">
      <div className="muted">
        {task.message}（{Math.round(value)}%）
      </div>
      <div
        className="metric-bar"
        role="progressbar"
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="metric-bar-fill" style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}
