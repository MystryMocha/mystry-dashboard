import type en from '../en/login';

/** 登录与首次初始化页、登录态文案（繁體中文）。 */
export default {
  'login.footer': 'Mystry Dashboard v{version} · Minecraft Java 伺服器管理面板',
  'login.unavailable.title': '面板服務無法使用',
  'login.unavailable.checking': '正在檢查…',
  'login.unavailable.recheck': '重新檢查',
  'login.status.connectError': '無法連線至面板服務：{message}',

  'login.setup.title': '初始化管理員',
  'login.setup.subtitle': '這是首次啟動，請建立管理員帳號。',
  'login.signin.title': '登入面板',
  'login.signin.subtitle': '使用管理員帳號登入 Mystry Dashboard。',

  'login.form.username': '使用者名稱',
  'login.form.setupToken': '初始化權杖',
  'login.form.password': '密碼',
  'login.form.setupTokenHelp': '用啟動器開啟面板時，權杖已自動複製到剪貼簿，按 Ctrl+V 貼上即可。剪貼簿裡沒有時，請開啟面板設定檔（可攜版和 Linux 為 config/panel.env，Windows 原始碼版為 .env），複製 SETUP_TOKEN 的值。',
  'login.form.passwordHelp': '密碼至少需要 12 個字元，請妥善記住，面板目前不支援密碼復原。',

  'login.submit.busy': '處理中…',
  'login.submit.setup': '建立並進入',
  'login.submit.signin': '登入',
} satisfies Record<keyof typeof en, string>;
