/** User-facing server messages: sign-in, initial setup and the launcher shutdown endpoint. Values are English templates with `{name}` placeholders; the Web string tables translate other languages by key. */
export const AUTH_MESSAGES = {
  'server.auth.invalidSetupToken': 'The setup token is invalid.',
  'server.auth.invalidCredentialFormat': 'The username or password format is invalid.',
  'server.auth.invalidCredentials': 'The username or password is incorrect.',
  'server.auth.usernameTooShort': 'The username must be at least {min} characters.',
  'server.auth.usernameTooLong': 'The username can be at most {max} characters.',
  'server.auth.passwordTooShort': 'The password must be at least {min} characters.',
  'server.auth.passwordTooLong': 'The password can be at most {max} characters.',
  'server.auth.passwordTooManyBytes': 'The password can be at most {max} bytes.',
  'server.auth.alreadyInitialized': 'The administrator account is already set up.',
  'server.auth.currentPasswordIncorrect': 'The current password is incorrect.',
  'server.auth.noAdministrator': "There's no administrator account yet.",
  'server.auth.launcherLocalOnly': 'The launcher endpoints only accept requests from this computer.',
  'server.auth.invalidLauncherToken': 'The launcher token is invalid.',
  'server.auth.launcherShutdownUnsupported': "Launcher shutdown isn't supported in the current run mode.",
  'server.auth.sessionDurationInvalid': 'Choose one of the listed sign-in durations.',
} as const satisfies Record<string, string>;
