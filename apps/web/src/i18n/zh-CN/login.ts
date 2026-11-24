import type en from '../en/login';

/** 登录与首次初始化页、登录态文案（简体中文）。 */
export default {
  'login.footer': 'Mystry Dashboard v{version}',
  'login.unavailable.title': '面板服务不可用',
  'login.unavailable.checking': '正在检查…',
  'login.unavailable.recheck': '重新检查',
  'login.status.connectError': '无法连接面板服务：{message}',

  'login.setup.title': '初始化管理员',
  'login.setup.subtitle': '首次启动，请创建管理员账号。',
  'login.signin.title': '登录面板',

  'login.form.username': '用户名',
  'login.form.setupToken': '初始化令牌',
  'login.form.password': '密码',
  'login.form.setupTokenHelp': '从面板配置文件复制 SETUP_TOKEN 的值。便携版和 Linux 版在 config/panel.env，Windows 源码版在 .env。',
  'login.form.setupTokenCount': '{count} / {max}',
  'login.form.setupTokenLength': '令牌是 {max} 个字符，现在有 {count} 个。',
  'login.form.passwordHelp': '密码至少 12 个字符。',
  'login.forgot': '忘记密码时，在运行面板的电脑上重置：Windows 上双击 mdash.cmd，选「重置管理员密码」；Linux 上执行 <cmd>./mdash reset-password</cmd>，源码版为 <cmd>./mdash.sh reset-password</cmd>。',

  'login.submit.busy': '处理中…',
  'login.submit.setup': '创建并进入',
  'login.submit.signin': '登录',
} satisfies Record<keyof typeof en, string>;
