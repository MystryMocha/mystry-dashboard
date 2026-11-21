import { useEffect } from 'react';

/** The polling interval shared by page data. */
export const POLL_INTERVAL_MS = 5_000;

/**
 * Runs once immediately on mount, then repeats at a fixed interval; skipped while the page is hidden, and run once right away when it returns to the foreground.
 * A change of callback (such as switching instances) restarts the timer and runs immediately.
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
