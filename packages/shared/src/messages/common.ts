/** 服务端返回给用户的消息：通用（认证失效、内部错误、请求校验）。值为英文模板，`{name}` 为参数占位；其他语言由 Web 文案表按键翻译。 */
export const COMMON_MESSAGES = {
  'server.common.internal': 'Internal server error.',
  'server.common.requestFailed': 'Request failed.',
  'server.common.invalidRequest': 'Invalid request: {detail}',
  'server.common.notFound': 'API endpoint not found.',
  'server.common.shuttingDown': 'The panel is shutting down.',
  'server.common.unauthorized': 'Your session has expired. Sign in again.',
  'server.common.tooManyRequests': 'Too many requests. Try again later.',
} as const satisfies Record<string, string>;
