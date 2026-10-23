import type { TaskInfo } from '@mystry/shared';
import { useI18n } from '../i18n';

/** 把任务进度截到 0–100，非有限值按 0 处理。 */
export function clampProgress(progress: number): number {
  return Number.isFinite(progress) ? Math.min(100, Math.max(0, progress)) : 0;
}

/** 部署、导入页的任务进度：当前步骤文案加进度条。 */
export function TaskProgress({ task, label }: { task: TaskInfo; label: string }) {
  const { fmt } = useI18n();
  const value = clampProgress(task.progress);
  return (
    <div className="task-progress" aria-live="polite">
      <div className="task-progress-text">
        <span>{task.message}</span>
        <span className="task-progress-value">{fmt.percent(Math.round(value), 0)}</span>
      </div>
      <div
        className="progress"
        role="progressbar"
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="progress-fill" style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}
