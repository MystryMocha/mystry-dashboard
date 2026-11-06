import type { AUTH_MESSAGES } from '@mystry/shared';

/** 服务端消息（auth）的繁體中文翻译；英文模板在 packages/shared/src/messages/auth.ts。 */
export default {
  'server.auth.invalidSetupToken': '初始化權杖無效',
  'server.auth.invalidCredentialFormat': '使用者名稱或密碼格式不正確',
  'server.auth.invalidCredentials': '使用者名稱或密碼錯誤',
  'server.auth.usernameTooShort': '使用者名稱至少需要 {min} 個字元',
  'server.auth.usernameTooLong': '使用者名稱最多 {max} 個字元',
  'server.auth.passwordTooShort': '密碼至少需要 {min} 個字元',
  'server.auth.passwordTooLong': '密碼最多 {max} 個字元',
  'server.auth.passwordTooManyBytes': '密碼最多 {max} 位元組（bcrypt 截斷上限）',
  'server.auth.alreadyInitialized': '管理員帳號已完成初始化',
  'server.auth.currentPasswordIncorrect': '目前的密碼不正確',
  'server.auth.noAdministrator': '還沒有管理員帳號',
  'server.auth.launcherLocalOnly': '啟動器介面僅允許本機存取',
  'server.auth.invalidLauncherToken': '啟動器權杖無效',
  'server.auth.launcherShutdownUnsupported': '目前的執行方式不支援透過啟動器關閉',
} satisfies Record<keyof typeof AUTH_MESSAGES, string>;
