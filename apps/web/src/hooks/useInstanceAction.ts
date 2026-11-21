import { useState } from 'react';
import { errorMessage } from '../errors';

/**
 * Busy flag and error message for instance actions (start/stop, delete).
 * After an action ends, whether it succeeded or failed, the instance is re-read, so the UI state follows the server.
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
