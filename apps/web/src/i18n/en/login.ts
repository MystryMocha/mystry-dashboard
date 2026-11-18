/** 登录与首次初始化页、登录态文案（英文主表）。 */
export default {
  'login.footer': 'Mystry Dashboard v{version}',
  'login.unavailable.title': 'Panel Service Unavailable',
  'login.unavailable.checking': 'Checking…',
  'login.unavailable.recheck': 'Check Again',
  'login.status.connectError': "Couldn't connect to the panel service: {message}",

  'login.setup.title': 'Set Up Administrator',
  'login.setup.subtitle': 'This is the first launch. Create an administrator account.',
  'login.signin.title': 'Sign In',
  'login.signin.subtitle': 'Sign in to Mystry Dashboard with your administrator account.',

  'login.form.username': 'Username',
  'login.form.setupToken': 'Setup Token',
  'login.form.password': 'Password',
  'login.form.setupTokenHelp': 'Copy the value of SETUP_TOKEN from the panel config file: config/panel.env for the portable and Linux builds, .env for the Windows source build.',
  'login.form.passwordHelp': 'Use at least 12 characters.',

  'login.submit.busy': 'Working…',
  'login.submit.setup': 'Create and Continue',
  'login.submit.signin': 'Sign In',
} satisfies Record<string, string>;
