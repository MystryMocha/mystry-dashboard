import { useEffect } from 'react';
import { useBlocker } from 'react-router-dom';

/**
 * Blocks in-app navigation and closing the page while there are unsaved changes or a save is in progress.
 * A navigation blocked during a save continues automatically once the save succeeds.
 */
export function useUnsavedGuard(dirty: boolean, saving: boolean) {
  const blocker = useBlocker(dirty || saving);

  useEffect(() => {
    if (blocker.state === 'blocked' && !dirty && !saving) blocker.proceed();
  }, [blocker, dirty, saving]);

  useEffect(() => {
    if (!dirty) return;
    function preventUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = true;
    }
    window.addEventListener('beforeunload', preventUnload);
    return () => window.removeEventListener('beforeunload', preventUnload);
  }, [dirty]);

  return blocker;
}
