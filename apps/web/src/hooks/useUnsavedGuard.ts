import { useEffect } from 'react';
import { useBlocker } from 'react-router-dom';

/**
 * 有未保存修改或正在保存时拦截站内导航和关闭页面。
 * 保存期间被拦下的导航，在保存成功后自动继续。
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
