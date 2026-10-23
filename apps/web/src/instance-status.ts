import type { InstanceInfo } from '@mystry/shared';
import type { MessageKey } from './i18n';

type InstanceStatus = InstanceInfo['status'];

/** 实例状态对应的术语表键；未知状态返回 null，由调用方原样显示。 */
export function instanceStatusKey(status: string): MessageKey | null {
  switch (status) {
    case 'stopped': return 'instance.status.stopped';
    case 'starting': return 'instance.status.starting';
    case 'running': return 'instance.status.running';
    case 'stopping': return 'instance.status.stopping';
    case 'crashed': return 'instance.status.crashed';
    default: return null;
  }
}

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
