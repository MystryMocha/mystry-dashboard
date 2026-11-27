import type { InstanceInfo } from '@mystry/shared';
import type { MessageKey } from './i18n';

type InstanceStatus = InstanceInfo['status'];

/** Glossary key for an instance status; returns null for an unknown status, and the caller displays it as is. */
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

/**
 * Whether the server is up: run by the panel, or left running by an earlier panel process and confirmed to be the same
 * server. Its status alone reads "stopped" in the second case, because the panel no longer holds the process.
 */
export function isServerRunning(instance: Pick<InstanceInfo, 'status' | 'orphanProcess'>): boolean {
  return instance.status === 'running' || instance.orphanProcess?.state === 'alive';
}

/** The process may still be alive: force stop is allowed, delete is not. */
export function isProcessAlive(status: InstanceStatus): boolean {
  return status === 'running' || status === 'starting' || status === 'stopping';
}
