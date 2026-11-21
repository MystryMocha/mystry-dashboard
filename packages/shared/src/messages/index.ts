/**
 * Contract for user-facing server messages: the server returns only a stable message key and params, plus the rendered English text;
 * Web translates by the same key in the current UI language, and shows the English text when the key is missing or legacy data has no key.
 * All keys start with `server.<area>.` so they do not collide with Web's own string keys.
 */
import { AUTH_MESSAGES } from './auth.js';
import { BACKUPS_MESSAGES } from './backups.js';
import { COMMON_MESSAGES } from './common.js';
import { DEPLOY_MESSAGES } from './deploy.js';
import { FILES_MESSAGES } from './files.js';
import { IMPORTS_MESSAGES } from './imports.js';
import { INSTANCE_MESSAGES } from './instance.js';
import { JVM_MESSAGES } from './jvm.js';
import { SYSTEM_MESSAGES } from './system.js';
import { TASKS_MESSAGES } from './tasks.js';
import { FRP_MESSAGES } from './frp.js';
import { LAN_MESSAGES } from './lan.js';
import { REMOTE_ACCESS_MESSAGES } from './remote-access.js';

export {
  AUTH_MESSAGES,
  BACKUPS_MESSAGES,
  COMMON_MESSAGES,
  DEPLOY_MESSAGES,
  FILES_MESSAGES,
  IMPORTS_MESSAGES,
  INSTANCE_MESSAGES,
  JVM_MESSAGES,
  SYSTEM_MESSAGES,
  TASKS_MESSAGES,
  FRP_MESSAGES,
  LAN_MESSAGES,
  REMOTE_ACCESS_MESSAGES,
};

export const SERVER_MESSAGES = {
  ...COMMON_MESSAGES,
  ...AUTH_MESSAGES,
  ...FILES_MESSAGES,
  ...DEPLOY_MESSAGES,
  ...IMPORTS_MESSAGES,
  ...INSTANCE_MESSAGES,
  ...SYSTEM_MESSAGES,
  ...TASKS_MESSAGES,
  ...JVM_MESSAGES,
  ...BACKUPS_MESSAGES,
  ...FRP_MESSAGES,
  ...LAN_MESSAGES,
  ...REMOTE_ACCESS_MESSAGES,
} as const;

export type ServerMessageKey = keyof typeof SERVER_MESSAGES;

/** A param can be text, a number, or another translatable message (for example the reason in "Cleanup failed: {reason}"). */
export type PanelMessageParam = string | number | PanelMessage;
export type PanelMessageParams = Record<string, PanelMessageParam>;

export interface PanelMessage {
  key: ServerMessageKey;
  params?: PanelMessageParams;
}

/** Error response body: `error` is always English text, for scripts and older clients to show directly; `code` / `params` are for Web to translate. */
export interface ApiErrorBody {
  error: string;
  code?: ServerMessageKey;
  params?: PanelMessageParams;
}

export function isServerMessageKey(value: unknown): value is ServerMessageKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SERVER_MESSAGES, value);
}

export function isPanelMessage(value: unknown): value is PanelMessage {
  return value !== null
    && typeof value === 'object'
    && isServerMessageKey((value as { key?: unknown }).key);
}

/** Fills params into the template; nested messages are rendered first with the same lookup. Falls back to the English template when lookup returns undefined. */
export function renderPanelMessage(
  message: PanelMessage,
  lookup: (key: string) => string | undefined = () => undefined,
): string {
  const template = lookup(message.key) ?? SERVER_MESSAGES[message.key] ?? message.key;
  const params = message.params;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return match;
    const value = params[name]!;
    return typeof value === 'object' ? renderPanelMessage(value, lookup) : String(value);
  });
}
