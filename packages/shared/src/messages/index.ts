/**
 * 服务端面向用户的消息契约：服务端只返回稳定的消息键与参数，并附带渲染好的英文文本；
 * Web 按当前界面语言用同一个键翻译，缺键或旧数据没有键时显示英文文本。
 * 键统一以 `server.<区域>.` 开头，避免与 Web 自身文案键重名。
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
} as const;

export type ServerMessageKey = keyof typeof SERVER_MESSAGES;

/** 参数可以是文本、数字，或另一条可翻译消息（例如「清理失败：{reason}」里的原因）。 */
export type PanelMessageParam = string | number | PanelMessage;
export type PanelMessageParams = Record<string, PanelMessageParam>;

export interface PanelMessage {
  key: ServerMessageKey;
  params?: PanelMessageParams;
}

/** 错误响应体：`error` 始终是英文文本，供脚本与旧客户端直接显示；`code` / `params` 供 Web 翻译。 */
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

/** 按模板填入参数；嵌套消息先用同一个 lookup 渲染。lookup 返回 undefined 时回落英文模板。 */
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
