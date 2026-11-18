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
  'login.signin.subtitle': '使用管理员账号登录 Mystry Dashboard。',

  'login.form.username': '用户名',
  'login.form.setupToken': '初始化令牌',
  'login.form.password': '密码',
  'login.form.setupTokenHelp': '从面板配置文件复制 SETUP_TOKEN 的值。便携版和 Linux 版在 config/panel.env，Windows 源码版在 .env。',
  'login.form.passwordHelp': '密码至少 12 个字符。',

  'login.submit.busy': '处理中…',
  'login.submit.setup': '创建并进入',
  'login.submit.signin': '登录',
} satisfies Record<keyof typeof en, string>;
