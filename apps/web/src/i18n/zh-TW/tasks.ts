import type en from '../en/tasks';

/** 任务中心、通用弹窗、错误汇总、菜单与请求错误文案（繁體中文）。 */
export default {
  'tasks.type.download': '下載核心',
  'tasks.type.extract': '解壓縮檔案',
  'tasks.type.deploy': '部署實例',
  'tasks.type.import': '匯入伺服器',
  'tasks.type.backup': '備份伺服器',
  'tasks.type.restore': '還原備份',

  'tasks.center.title': '任務中心',
  'tasks.center.open_one': '開啟任務中心，{count} 個任務進行中',
  'tasks.center.open_other': '開啟任務中心，{count} 個任務進行中',
  'tasks.center.close': '關閉任務中心',
  'tasks.center.refresh': '重新整理任務',
  'tasks.center.activeBadge': '{count} 個進行中',
  'tasks.center.stale': '狀態可能已過期：{error}',
  'tasks.center.lastSync': '上次成功同步：{time}',
  'tasks.center.loading': '正在載入任務清單…',
  'tasks.center.empty.title': '尚無任務',
  'tasks.center.empty.body': '開始部署或匯入後，進度會顯示在這裡。',
  'tasks.card.runningProgress': '{percent} 進行中',
  'tasks.card.progressLabel': '{type}進度',
  'tasks.card.viewInstance': '檢視實例',

  'menu.more': '更多操作',

  'dialog.confirm.requireText': '請輸入「{text}」以確認操作',
  'dialog.confirm.busy': '處理中…',

  'dialog.error.copy': '複製錯誤',
  'dialog.error.copied': '已複製',
  'dialog.error.copyFailed': '複製失敗',
  'dialog.error.viewDetails': '檢視詳細資料',
  'dialog.error.detailHint': '完整的錯誤內容，可以複製後用於排查問題。',
  'dialog.error.closeLabel': '關閉錯誤詳細資料',
  'dialog.error.copiedStatus': '錯誤內容已複製到剪貼簿',
  'dialog.error.copyFailedStatus': '複製失敗，請在內容區域中手動選取並複製',
  'dialog.error.copyAll': '全部複製',

  'request.failed': '請求失敗（{status}）',
  'request.aborted': '操作已取消',
  'request.download.popupBlocked': '瀏覽器封鎖了下載視窗，請允許彈出式視窗後再試一次',
  'request.download.ticketExpiredRetry': '下載連結已過期，請再試一次',
  'request.download.ticketExpired': '下載連結已過期',
  'request.download.failed': '檔案下載失敗',
  'request.stopPending': '伺服器仍在儲存，請稍候或選擇強制停止',
  'request.taskFailed': '任務失敗',
} satisfies Record<keyof typeof en, string>;
