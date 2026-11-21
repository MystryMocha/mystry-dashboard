import type { ReactNode } from 'react';
import type { TaskInfo } from '@mystry/shared';
import { useI18n } from '../i18n';

/** Clamps task progress to 0–100, treating non-finite values as 0. */
export function clampProgress(progress: number): number {
  return Number.isFinite(progress) ? Math.min(100, Math.max(0, progress)) : 0;
}

/** Task progress on the deploy and import pages: the current step text plus a progress bar; action is the button to the right of the percentage (such as "Cancel install"). */
export function TaskProgress({ task, label, action }: { task: TaskInfo; label: string; action?: ReactNode }) {
  const { tm } = useI18n();
  return <ProgressBar text={tm(task.messageI18n, task.message)} progress={task.progress} label={label} action={action} />;
}

/** Text + percentage + progress bar; progress that is not a background task (such as a browser folder upload) uses it too, looking the same as task progress. */
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
