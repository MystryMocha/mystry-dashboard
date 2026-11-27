import type { ServerMessageKey } from '@mystry/shared';
import { abortError, PanelError } from '../utils/errors.js';

/** PaperMC requires the User-Agent to state the software name and contact info */
export const USER_AGENT = 'MinecraftMystryDashboard/0.2 (+https://github.com/MystryMocha/mystry-dashboard)';

export type TimeoutAbort = {
  signal: AbortSignal;
  /** The error to throw when a request fails: checks parent signal cancellation, timeout and this controller's abort in turn, and returns the original when it is none of them. */
  errorFor(error: unknown): unknown;
  /** Resets the timer from now when progress arrives, turning the aborter into a stall/idle timeout. */
  reset(): void;
  dispose(): void;
};

/** An aborter controlled by both the parent signal and a timeout, used for core downloads and metadata requests; the timeout reason is a translatable PanelError. */
export function createTimeoutAbort(
  parent: AbortSignal | undefined,
  timeoutMs: number,
  timeoutKey: ServerMessageKey,
): TimeoutAbort {
  const controller = new AbortController();
  let timedOut = false;
  let disposed = false;
  let timer: NodeJS.Timeout | null = null;
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent) {
    parent.addEventListener('abort', abortFromParent, { once: true });
    if (parent.aborted) abortFromParent();
  }
  const arm = () => {
    if (disposed || controller.signal.aborted) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new PanelError(timeoutKey));
    }, timeoutMs);
  };
  arm();
  return {
    signal: controller.signal,
    errorFor(error) {
      if (parent?.aborted) return abortError(parent);
      if (timedOut) return new PanelError(timeoutKey);
      if (controller.signal.aborted) return abortError(controller.signal);
      return error;
    },
    reset() {
      arm();
    },
    dispose() {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      parent?.removeEventListener('abort', abortFromParent);
    },
  };
}
