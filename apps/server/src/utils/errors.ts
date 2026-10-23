import {
  renderPanelMessage,
  type ApiErrorBody,
  type PanelMessage,
  type PanelMessageParam,
  type PanelMessageParams,
  type ServerMessageKey,
} from '@mystry/shared';

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

/**
 * 面向用户的错误：携带共享消息键与参数，`message` 为渲染好的英文文本（日志与脚本可读）。
 * 不用 `code` 字段名，避免与 Node.js errno 判断（hasErrorCode）混淆。
 */
export class PanelError extends Error {
  readonly messageKey: ServerMessageKey;
  readonly params?: PanelMessageParams;
  /** 由路由或全局错误处理器使用的 HTTP 状态码；未指定时由调用方决定。 */
  readonly statusCode?: number;

  constructor(
    key: ServerMessageKey,
    params?: PanelMessageParams,
    options?: { statusCode?: number; cause?: unknown },
  ) {
    super(renderPanelMessage({ key, params }), options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PanelError';
    this.messageKey = key;
    this.params = params;
    this.statusCode = options?.statusCode;
  }

  toPanelMessage(): PanelMessage {
    return this.params ? { key: this.messageKey, params: this.params } : { key: this.messageKey };
  }
}

export function isPanelError(error: unknown): error is PanelError {
  return error instanceof PanelError;
}

/** 可翻译错误返回消息键；原始系统或第三方错误返回 undefined，由调用方保留英文/原文文本。 */
export function toPanelMessage(error: unknown): PanelMessage | undefined {
  return error instanceof PanelError ? error.toPanelMessage() : undefined;
}

/** 作为另一条消息的参数（如「清理失败：{reason}」）：可翻译错误嵌套为消息，其余取原文。 */
export function errorParam(error: unknown): PanelMessageParam {
  return toPanelMessage(error) ?? errorMessage(error);
}

/** 由消息键直接构造错误响应体。 */
export function panelErrorBody(key: ServerMessageKey, params?: PanelMessageParams): ApiErrorBody {
  const body: ApiErrorBody = { error: renderPanelMessage({ key, params }), code: key };
  if (params) body.params = params;
  return body;
}

/** 由捕获到的异常构造错误响应体：可翻译错误带上键和参数，其余只返回原文。 */
export function errorBody(error: unknown): ApiErrorBody {
  if (error instanceof PanelError) return panelErrorBody(error.messageKey, error.params);
  return { error: errorMessage(error) };
}

/** 面板主动中止时使用的原因（超时、取消等）均为 PanelError；其余原因（如无参 abort()）统一视为取消。 */
export function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof PanelError) return signal.reason;
  return new PanelError('server.tasks.aborted');
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}
