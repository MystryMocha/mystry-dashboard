import { useEffect } from 'react';

/** 页面数据统一的轮询间隔。 */
export const POLL_INTERVAL_MS = 5_000;

/**
 * 挂载时立即执行一次，之后按固定间隔重复；页面隐藏时跳过，回到前台立即补一次。
 * callback 变化（如切换实例）会重新开始计时并立即执行。
 */
export function usePolling(callback: () => unknown, intervalMs = POLL_INTERVAL_MS): void {
  useEffect(() => {
    const runIfVisible = () => {
      if (!document.hidden) void callback();
    };
    void callback();
    const timer = window.setInterval(runIfVisible, intervalMs);
    document.addEventListener('visibilitychange', runIfVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', runIfVisible);
    };
  }, [callback, intervalMs]);
}
