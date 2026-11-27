import type en from '../en/console';

/** 控制台文案（繁體中文）。 */
export default {
  // 面板写入终端的提示前缀；着色函数会同时识别所有语言的前缀
  'console.prefix.panel': '[面板]',
  'console.prefix.error': '[錯誤]',

  // 写入终端的面板提示
  'console.system.reconnecting_one': '{prefix} {reason}，{count} 秒後重新連線…',
  'console.system.reconnecting_other': '{prefix} {reason}，{count} 秒後重新連線…',
  'console.system.reconnected': '{prefix} 主控台已重新連線',
  'console.system.disconnected': '主控台連線已中斷',
  'console.system.closedPolicy': '{prefix} 連線已被伺服器關閉（限制或驗證原因），請點選「重新連線」重試。',
  'console.system.closedTooLarge': '{prefix} 主控台訊息超出單訊框大小限制，連線已關閉，請點選「重新連線」重試。',
  'console.system.closedTooMany': '{prefix} 主控台連線數已達上限，請關閉其他主控台分頁後點選「重新連線」。',

  // 连接状态
  'console.status.connected': '即時日誌已連線',
  'console.status.connecting': '主控台連線中…',
  'console.status.disconnected': '連線已中斷',
  'console.status.offline': '實例未執行',

  // 工具按钮与复制
  'console.tool.reconnect': '重新連線',
  'console.tool.clear': '清除畫面',
  'console.tool.copyTitle': '複製全部輸出',
  'console.tool.copy': '複製日誌',
  'console.copy.empty': '目前沒有可複製的日誌。',
  'console.copy.done': '日誌已複製。',
  'console.copy.failed': '無法複製：瀏覽器剪貼簿無法使用或權限遭拒，請手動選取日誌後複製。',
  'console.tool.screenReader': '螢幕閱讀器模式',
  'console.tool.screenReaderTitle': '讓螢幕閱讀器可以逐行瀏覽日誌，並朗讀新輸出',

  // 终端输出区（读屏）
  'console.output.label': '主控台輸出',
  'console.output.tooMuchOutput': '輸出太多，無法全部朗讀，請逐行瀏覽日誌查看其餘內容。',

  // 命令输入
  'console.input.label': '主控台指令',
  'console.input.placeholder': '輸入主控台指令（例如 list、say Hello、op 玩家名稱），按 Enter 傳送',
  'console.input.placeholderConnecting': '連線中…',
  'console.input.placeholderDisconnected': '主控台已中斷連線，重新連線後可傳送指令。',
  'console.input.placeholderStopped': '實例已停止，啟動後即可傳送指令',

  // 常用命令
  'console.quick.label': '常用指令',
  'console.quick.sendTitle': '向伺服器傳送 /{command}',
  'console.quick.list': '玩家清單',
  'console.quick.saveAll': '儲存世界',
  'console.quick.tps': 'Tick 效能',
  'console.quick.whitelist': '白名單',
  'console.quick.help': '指令說明',
} satisfies Record<keyof typeof en, string>;
