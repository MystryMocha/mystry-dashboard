import type { COMMON_MESSAGES } from '@mystry/shared';

/** 服务端消息（common）的简体中文翻译；英文模板在 packages/shared/src/messages/common.ts。 */
export default {
  'server.common.internal': '服务器内部错误',
  'server.common.requestFailed': '请求失败',
  'server.common.invalidRequest': '请求参数无效：{detail}',
  'server.common.notFound': '接口不存在',
  'server.common.shuttingDown': '面板正在关闭',
  'server.common.unauthorized': '登录已失效，请重新登录',
  'server.common.tooManyRequests': '请求过于频繁，请稍后重试',
} satisfies Record<keyof typeof COMMON_MESSAGES, string>;
