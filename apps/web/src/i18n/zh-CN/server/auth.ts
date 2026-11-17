import type { AUTH_MESSAGES } from '@mystry/shared';

/** 服务端消息（auth）的简体中文翻译；英文模板在 packages/shared/src/messages/auth.ts。 */
export default {
  'server.auth.invalidSetupToken': '初始化令牌无效',
  'server.auth.invalidCredentialFormat': '用户名或密码格式不正确',
  'server.auth.invalidCredentials': '用户名或密码错误',
  'server.auth.usernameTooShort': '用户名至少 {min} 个字符',
  'server.auth.usernameTooLong': '用户名最多 {max} 个字符',
  'server.auth.passwordTooShort': '密码至少 {min} 位',
  'server.auth.passwordTooLong': '密码最多 {max} 位',
  'server.auth.passwordTooManyBytes': '密码最多 {max} 字节',
  'server.auth.alreadyInitialized': '管理员已初始化',
  'server.auth.currentPasswordIncorrect': '当前密码不正确',
  'server.auth.noAdministrator': '还没有管理员账号',
  'server.auth.launcherLocalOnly': '启动器接口仅允许本机访问',
  'server.auth.invalidLauncherToken': '启动器令牌无效',
  'server.auth.launcherShutdownUnsupported': '当前运行方式不支持启动器关闭',
} satisfies Record<keyof typeof AUTH_MESSAGES, string>;
