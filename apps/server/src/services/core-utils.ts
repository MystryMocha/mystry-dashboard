import type { ServerMessageKey } from '@mystry/shared';
import { abortError, PanelError } from '../utils/errors.js';

/** PaperMC 要求 User-Agent 标明软件名与联系方式 */
export const USER_AGENT = 'MinecraftMystryDashboard/0.2 (+https://github.com/MystryWorks/mystry-dashboard)';

export type TimeoutAbort = {
  signal: AbortSignal;
  /** 请求失败时应抛出的错误：依次检查父信号取消、超时、本控制器中止，都不是时原样返回。 */
  errorFor(error: unknown): unknown;
  dispose(): void;
};

/** 同时受父信号和超时控制的中止器，用于核心下载和元数据请求；超时原因为可翻译的 PanelError。 */
export function createTimeoutAbort(
  parent: AbortSignal | undefined,
  timeoutMs: number,
  timeoutKey: ServerMessageKey,
): TimeoutAbort {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent) {
    parent.addEventListener('abort', abortFromParent, { once: true });
    if (parent.aborted) abortFromParent();
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new PanelError(timeoutKey));
  }, timeoutMs);
  return {
    signal: controller.signal,
    errorFor(error) {
      if (parent?.aborted) return abortError(parent);
      if (timedOut) return new PanelError(timeoutKey);
      if (controller.signal.aborted) return abortError(controller.signal);
      return error;
    },
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abortFromParent);
    },
  };
}
