/** 把任意异常转成可展示的错误文案。 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 请求被中止（组件卸载、用户取消）时不需要提示错误。 */
export function isAbortError(error: unknown): boolean {
  return error !== null
    && typeof error === 'object'
    && 'name' in error
    && error.name === 'AbortError';
}
