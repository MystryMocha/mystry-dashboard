import type { INSTANCE_MESSAGES } from '@mystry/shared';

/** 服务端消息（instance）的繁體中文翻译；英文模板在 packages/shared/src/messages/instance.ts。 */
export default {
  // 实例接口
  'server.instance.notFound': '實例不存在',
  'server.instance.invalidParams': '實例參數包含不支援的欄位或格式不正確',
  'server.instance.nameRequired': '名稱不能為空',
  'server.instance.commandInvalid': '指令過長、為空或包含不支援的欄位',

  // 创建、注册、删除与接管
  'server.instance.javaRuntimeInvalid': '所選 Java 執行環境不存在或無法使用，請重新掃描後再選擇',
  'server.instance.selectedNodeNotFound': '所選節點不存在',
  'server.instance.remoteNodeUnsupported': '目前版本不支援在遠端節點上建立實例',
  'server.instance.createDbFailed': '建立實例失敗：資料庫未寫入實例記錄',
  'server.instance.defaultDirNotEmpty': '預設實例資料夾必須為空，拒絕接管既有資料夾',
  'server.instance.createDirFailed': '無法建立或寫入安裝資料夾：{dir}（{reason}）',
  'server.instance.registerDirMissing': '實例資料夾不存在，無法註冊實例',
  'server.instance.registerDirEmpty': '實例資料夾為空，無法註冊實例',
  'server.instance.deleteRunning': '請先停止實例再刪除',
  'server.instance.deleteDbFailed': '刪除實例失敗：資料庫記錄未刪除',
  'server.instance.adoptRunning': '請先停止實例再完成遷移',
  'server.instance.adoptAlreadyManaged': '實例已經在面板資料目錄裡，不需要遷移',
  'server.instance.adoptDirEmpty': '預設實例資料夾不能為空',
  'server.instance.adoptDirFailed': '無法完成遷移：{reason}',
  'server.instance.adoptMarkerInvalid': '無法完成遷移：實例資料夾裡的面板標記檔案無效，或屬於其他實例',
  'server.instance.adoptStateChanged': '遷移失敗：實例狀態已變更，請重試',
  'server.instance.propertiesNotRegularFile': 'server.properties 不是一般檔案',

  // 进程启停
  'server.instance.startShuttingDown': '面板正在關閉，無法啟動實例',
  'server.instance.startCancelledShuttingDown': '面板正在關閉，已取消啟動',
  'server.instance.alreadyRunning': '實例已在執行或正在啟動／停止',
  'server.instance.forgeArgsMissing': '找不到 Forge/NeoForge 啟動參數檔案：{path}，請重新部署該實例',
  'server.instance.modloaderNotInstalled': 'Forge/NeoForge 尚未完成安裝，請重新部署，或在任務中心查看安裝失敗原因',
  'server.instance.jarMissing': '找不到伺服器 jar：{jar}',
  'server.instance.notRunning': '實例未在執行',
  'server.instance.stillStarting': '實例正在啟動中，請稍後再試',
  'server.instance.stopPending': '實例仍在停止中，請等候或選擇強制停止',
  'server.instance.forceStopPending': '實例仍在強制終止中，請稍候',
  'server.instance.stopStdinUnavailable': '實例輸入串流無法使用，無法傳送停止指令',
  'server.instance.stopWriteFailed': '停止指令寫入失敗',
  'server.instance.forgetRunning': '執行中的實例不能清除程序狀態',
  'server.instance.orphanProcessRunning': '此實例上次啟動的伺服器程序（PID {pid}）仍在執行中，請先停止後再繼續操作',
  'server.instance.orphanStopRequiresForce': '殘留的伺服器程序（PID {pid}）在 Windows 上已無法接收主控台指令，請改用「強制停止」',
  'server.instance.orphanStopPending': '殘留的伺服器程序（PID {pid}）仍在停止中，請等候或選擇強制停止',
  'server.instance.orphanForceStopPending': '殘留的伺服器程序（PID {pid}）仍在強制終止中，請稍候',
  'server.instance.orphanSignalFailed': '停止殘留的伺服器程序（PID {pid}）失敗：{reason}',

  // 控制台命令
  'server.instance.commandNotRunning': '實例未在執行，無法傳送指令',
  'server.instance.commandEmpty': '指令不能為空',
  'server.instance.commandControlChars': '指令不能包含換行或控制字元',
  'server.instance.commandTooLarge': '指令超過大小限制（{limit} 位元組）',
  'server.instance.stdinBusy': '主控台輸入暫存區忙碌中，請稍後重試',
  'server.instance.stdinUnavailable': '實例輸入串流無法使用',
  'server.instance.stdinTooLarge': '主控台輸入暫存區超過大小限制（{limit} 位元組）',
  'server.instance.commandWriteFailed': '指令寫入失敗，實例輸入串流無法使用',

  // 控制台连接
  'server.instance.consoleTicketLimit': '主控台連線要求太多，請稍後再試',
  'server.instance.consoleTicketMissing': '缺少主控台連線憑證，請重新整理頁面後重試',
  'server.instance.consoleTicketInvalid': '主控台連線憑證無效或已過期，請重新整理頁面後重試',
  'server.instance.consoleMessageTooLarge': '主控台訊息超過大小限制（{limit} 位元組）',
  'server.instance.consoleCommandRateLimited': '傳送指令過於頻繁，請稍後重試',

  // 写入控制台日志的面板提示
  'server.instance.consoleProcessStartFailed': '[面板] 程序啟動失敗：{reason}',
  'server.instance.consoleProcessExited': '[面板] 程序已結束（結束代碼 {code}，訊號 {signal}）',
  'server.instance.consoleNone': '無',

  // Java 运行时
  'server.instance.javaRuntimeUnavailable': '所選 Java 執行環境無法使用，請重新掃描後再選擇',
  'server.instance.javaRuntimeFileMissing': 'Java 執行環境檔案不存在：{path}，請重新掃描後再選擇',
  'server.instance.javaRuntimePathUnresolved': '無法解析 Java 執行環境路徑：{path}，請重新掃描後再選擇',
  'server.instance.javaRuntimePathChanged': 'Java 執行環境路徑已變更，請重新掃描後再選擇',
  'server.instance.javaRuntimeVerifyFailed': '所選 Java 執行環境無法通過驗證，請重新掃描後再選擇',
} satisfies Record<keyof typeof INSTANCE_MESSAGES, string>;
