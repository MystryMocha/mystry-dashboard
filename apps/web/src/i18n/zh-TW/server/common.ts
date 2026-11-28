import type { COMMON_MESSAGES } from '@mystry/shared';

/** 服务端消息（common）的繁體中文翻译；英文模板在 packages/shared/src/messages/common.ts。 */
export default {
  'server.common.internal': '伺服器內部錯誤',
  'server.common.requestFailed': '請求失敗',
  'server.common.invalidRequest': '請求參數無效：{detail}',
  'server.common.notFound': 'API 不存在',
  'server.common.shuttingDown': '面板正在關閉',
  'server.common.unauthorized': '登入已失效，請重新登入',
  'server.common.tooManyRequests': '請求過於頻繁，請稍後再試',
  'server.common.requestTimeout': '請求逾時',
  'server.common.bodyTooLarge': '請求內容超過面板可接受的大小',
} satisfies Record<keyof typeof COMMON_MESSAGES, string>;
