import { isPanelMessage } from '@mystry/shared';
import { tm } from './i18n';

/**
 * 把任意异常转成可展示的错误文案。
 * 服务端返回的可翻译错误（ApiError 等带 messageI18n 的异常）按当前界面语言显示，其余用原文。
 */
export function errorMessage(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'messageI18n' in error && isPanelMessage(error.messageI18n)) {
    return tm(error.messageI18n, error instanceof Error ? error.message : undefined);
  }
  return error instanceof Error ? error.message : String(error);
}

/** 请求被中止（组件卸载、用户取消）时不需要提示错误。 */
export function isAbortError(error: unknown): boolean {
  return error !== null
    && typeof error === 'object'
    && 'name' in error
    && error.name === 'AbortError';
}
