/** User-facing server messages: common (expired authentication, internal errors, request validation). Values are English templates with `{name}` placeholders; the Web string tables translate other languages by key. */
export const COMMON_MESSAGES = {
  'server.common.internal': 'Internal server error.',
  'server.common.requestFailed': 'Request failed.',
  'server.common.invalidRequest': 'Invalid request: {detail}',
  'server.common.notFound': 'API endpoint not found.',
  'server.common.shuttingDown': 'The panel is shutting down.',
  'server.common.unauthorized': 'Your session has expired. Sign in again.',
  'server.common.tooManyRequests': 'Too many requests. Try again later.',
  'server.common.requestTimeout': 'The request timed out.',
} as const satisfies Record<string, string>;
