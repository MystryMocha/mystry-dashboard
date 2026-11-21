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

/** Checks for a Node.js errno (such as ENOENT) or a panel-defined error code. */
export function hasErrorCode(error: unknown, code: string): boolean {
  return error !== null
    && typeof error === 'object'
    && 'code' in error
    && error.code === code;
}

/**
 * User-facing error: carries a shared message key and params; `message` is the rendered English text (readable in logs and scripts).
 * The field is not named `code`, to avoid confusion with Node.js errno checks (hasErrorCode).
 */
export class PanelError extends Error {
  readonly messageKey: ServerMessageKey;
  readonly params?: PanelMessageParams;
  /** HTTP status code used by routes or the global error handler; decided by the caller when not specified. */
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

/** Returns the message key for translatable errors; returns undefined for raw system or third-party errors, leaving the caller to keep the English/original text. */
export function toPanelMessage(error: unknown): PanelMessage | undefined {
  return error instanceof PanelError ? error.toPanelMessage() : undefined;
}

/** As a param of another message (such as "Cleanup failed: {reason}"): translatable errors are nested as messages, the rest use their original text. */
export function errorParam(error: unknown): PanelMessageParam {
  return toPanelMessage(error) ?? errorMessage(error);
}

/** Builds an error response body directly from a message key. */
export function panelErrorBody(key: ServerMessageKey, params?: PanelMessageParams): ApiErrorBody {
  const body: ApiErrorBody = { error: renderPanelMessage({ key, params }), code: key };
  if (params) body.params = params;
  return body;
}

/** Builds an error response body from a caught exception: translatable errors carry the key and params, the rest return only the original text. */
export function errorBody(error: unknown): ApiErrorBody {
  if (error instanceof PanelError) return panelErrorBody(error.messageKey, error.params);
  return { error: errorMessage(error) };
}

/** Reasons the panel uses when it aborts on its own (timeout, cancel, etc.) are all PanelError; any other reason (such as abort() with no argument) is treated as a cancel. */
export function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof PanelError) return signal.reason;
  return new PanelError('server.tasks.aborted');
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}
