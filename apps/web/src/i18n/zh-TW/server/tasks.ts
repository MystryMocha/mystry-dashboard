import type { TASKS_MESSAGES } from '@mystry/shared';

/** 服务端消息（tasks）的繁體中文翻译；英文模板在 packages/shared/src/messages/tasks.ts。 */
export default {
  'server.tasks.queued': '排隊中',
  'server.tasks.completed': '完成',
  'server.tasks.failed': '失敗',
  'server.tasks.cancelled': '已取消',
  'server.tasks.interrupted': '已中斷',
  'server.tasks.capacity': '排隊的任務過多，請稍後再試',
  'server.tasks.shuttingDown': '面板正在關閉，不再接受新任務',
  'server.tasks.cancelledByShutdown': '面板正在關閉，任務已取消',
  'server.tasks.timeout': '任務執行逾時',
  'server.tasks.aborted': '任務已取消',
  'server.tasks.cancelledByUser': '你取消了這個任務',
  'server.tasks.notFound': '任務不存在',
  'server.tasks.restartLost': '面板重新啟動過，未完成的任務無法繼續，請重新操作',
  'server.tasks.restartLostKeptInstance': '面板重新啟動過，未完成的任務無法繼續。實例資料夾已保留，請重新操作或自行檢查實例',
  'server.tasks.restartCleanupFailed': '面板已重新啟動，未完成的任務無法恢復；暫存資料夾清理失敗：{reason}',
  'server.tasks.stagingMarkerMismatch': '暫存資料夾中的任務標記與任務紀錄不符，已略過自動清理',
} satisfies Record<keyof typeof TASKS_MESSAGES, string>;
