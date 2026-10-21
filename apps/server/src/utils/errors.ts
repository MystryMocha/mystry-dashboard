export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 判断 Node.js errno（如 ENOENT）或面板自定义错误码。 */
export function hasErrorCode(error: unknown, code: string): boolean {
  return error !== null
    && typeof error === 'object'
    && 'code' in error
    && error.code === code;
}

/** 面板主动中止时使用的原因；其余原因（如无参 abort() 产生的 AbortError）统一视为取消。 */
const KNOWN_ABORT_REASONS = ['任务执行超时', '任务已取消', '核心下载超时', '核心元数据请求超时'];

export function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error && KNOWN_ABORT_REASONS.includes(signal.reason.message)) {
    return signal.reason;
  }
  return new Error('任务已取消');
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}
