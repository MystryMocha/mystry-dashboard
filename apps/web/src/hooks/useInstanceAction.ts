import { useState } from 'react';
import { errorMessage } from '../errors';

/**
 * 实例操作（启停、删除）的忙碌标记和错误提示。
 * 操作结束后无论成败都重新读取实例，界面状态以服务端为准。
 */
export function useInstanceAction(reload: () => Promise<void>) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function run(instanceId: string, operation: () => Promise<unknown>): Promise<void> {
    setBusyId(instanceId);
    setError('');
    try {
      await operation();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      await reload();
      setBusyId(null);
    }
  }

  return { busyId, error, setError, run };
}
