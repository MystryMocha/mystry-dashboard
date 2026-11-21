import type { ReactNode } from 'react';
import type { TaskInfo } from '@mystry/shared';
import { useI18n } from '../i18n';

/** 把任务进度截到 0–100，非有限值按 0 处理。 */
export function clampProgress(progress: number): number {
  return Number.isFinite(progress) ? Math.min(100, Math.max(0, progress)) : 0;
}

/** 部署、导入页的任务进度：当前步骤文案加进度条；action 是百分比右边的按钮（比如「取消安装」）。 */
export function TaskProgress({ task, label, action }: { task: TaskInfo; label: string; action?: ReactNode }) {
  const { tm } = useI18n();
  return <ProgressBar text={tm(task.messageI18n, task.message)} progress={task.progress} label={label} action={action} />;
}

/** 文案 + 百分比 + 进度条；不是后台任务的进度（比如浏览器上传文件夹）也用它，样子和任务进度一致。 */
export function ProgressBar({ text, progress, label, action }: {
  text: ReactNode;
  progress: number;
  label: string;
  action?: ReactNode;
}) {
  const { fmt } = useI18n();
  const value = clampProgress(progress);
  return (
    <div className="task-progress" aria-live="polite">
      <div className="task-progress-text">
        <span>{text}</span>
        <span className="task-progress-value">{fmt.percent(Math.round(value), 0)}</span>
        {action}
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
