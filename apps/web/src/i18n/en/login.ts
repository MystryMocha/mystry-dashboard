/** Login and first-time setup page, and sign-in state strings (English primary table). */
export default {
  'login.footer': 'Mystry Dashboard v{version}',
  'login.unavailable.title': 'Panel Service Unavailable',
  'login.unavailable.checking': 'Checking…',
  'login.unavailable.recheck': 'Check Again',
  'login.status.connectError': "Couldn't connect to the panel service: {message}",

  'login.setup.title': 'Set Up Administrator',
  'login.setup.subtitle': 'This is the first launch. Create an administrator account.',
  'login.signin.title': 'Sign In',

  'login.form.username': 'Username',
  'login.form.setupToken': 'Setup Token',
  'login.form.password': 'Password',
  'login.form.setupTokenHelp': 'Copy the value of SETUP_TOKEN from the panel config file: config/panel.env for the portable and Linux builds, .env for the Windows source build.',
  'login.form.setupTokenCount': '{count} / {max}',
  'login.form.setupTokenLength': 'The token is {max} characters long. This one has {count}.',
  'login.form.passwordHelp': 'Use at least 12 characters.',
  'login.forgot': 'Forgot the password? Reset it on the computer running the panel. On Windows, double-click mdash.cmd and choose Reset the administrator password. On Linux, run <cmd>./mdash reset-password</cmd> (<cmd>./mdash.sh reset-password</cmd> for the source build).',

  'login.submit.busy': 'Working…',
  'login.submit.setup': 'Create and Continue',
  'login.submit.signin': 'Sign In',
} satisfies Record<string, string>;
