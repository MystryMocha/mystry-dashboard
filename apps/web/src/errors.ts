import { isPanelMessage } from '@mystry/shared';
import { tm } from './i18n';

/**
 * Turns any exception into displayable error text.
 * Translatable errors returned by the server (ApiError and other exceptions carrying messageI18n) are shown in the current UI language; the rest use their original text.
 */
export function errorMessage(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'messageI18n' in error && isPanelMessage(error.messageI18n)) {
    return tm(error.messageI18n, error instanceof Error ? error.message : undefined);
  }
  return error instanceof Error ? error.message : String(error);
}

/** No error needs to be shown when a request is aborted (component unmount, user cancel). */
export function isAbortError(error: unknown): boolean {
  return error !== null
    && typeof error === 'object'
    && 'name' in error
    && error.name === 'AbortError';
}
