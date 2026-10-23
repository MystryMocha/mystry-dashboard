/** 服务端返回给用户的消息：登录、初始化与启动器关闭接口。值为英文模板，`{name}` 为参数占位；其他语言由 Web 文案表按键翻译。 */
export const AUTH_MESSAGES = {
  'server.auth.invalidSetupToken': 'The setup token is invalid.',
  'server.auth.invalidCredentialFormat': 'The username or password format is invalid.',
  'server.auth.invalidCredentials': 'The username or password is incorrect.',
  'server.auth.usernameTooShort': 'The username must be at least {min} characters.',
  'server.auth.usernameTooLong': 'The username can be at most {max} characters.',
  'server.auth.passwordTooShort': 'The password must be at least {min} characters.',
  'server.auth.passwordTooLong': 'The password can be at most {max} characters.',
  'server.auth.passwordTooManyBytes': 'The password can be at most {max} bytes (the bcrypt limit).',
  'server.auth.alreadyInitialized': 'The administrator account is already set up.',
  'server.auth.launcherLocalOnly': 'The shutdown endpoint only accepts requests from this computer.',
  'server.auth.invalidLauncherToken': 'The launcher token is invalid.',
  'server.auth.launcherShutdownUnsupported': "Launcher shutdown isn't supported in the current run mode.",
} as const satisfies Record<string, string>;
