import type { InstanceInfo } from '@mystry/shared';

type InstanceStatus = InstanceInfo['status'];

export const instanceStatusLabel: Record<string, string> = {
  stopped: '已停止',
  starting: '启动中',
  running: '运行中',
  stopping: '停止中',
  crashed: '已崩溃',
};

export function canStartInstance(status: InstanceStatus): boolean {
  return status === 'stopped' || status === 'crashed';
}

export function canStopInstance(status: InstanceStatus): boolean {
  return status === 'running';
}

export function isLifecycleBusy(status: InstanceStatus): boolean {
  return status === 'starting' || status === 'stopping';
}

/** 进程仍可能存活：允许强制停止，不允许删除。 */
export function isProcessAlive(status: InstanceStatus): boolean {
  return status === 'running' || status === 'starting' || status === 'stopping';
}
