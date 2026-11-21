import type { TASKS_MESSAGES } from '@mystry/shared';

/** 服务端消息（tasks）的简体中文翻译；英文模板在 packages/shared/src/messages/tasks.ts。 */
export default {
  'server.tasks.queued': '排队中',
  'server.tasks.completed': '完成',
  'server.tasks.failed': '失败',
  'server.tasks.cancelled': '已取消',
  'server.tasks.interrupted': '已中断',
  'server.tasks.capacity': '排队的任务过多，请稍后重试',
  'server.tasks.shuttingDown': '面板正在关闭，不再接受新任务',
  'server.tasks.cancelledByShutdown': '面板正在关闭，任务已取消',
  'server.tasks.timeout': '任务执行超时',
  'server.tasks.aborted': '任务已取消',
  'server.tasks.cancelledByUser': '你取消了这个任务',
  'server.tasks.notFound': '任务不存在',
  'server.tasks.restartLost': '面板重启过，未完成的任务无法继续，请重新操作',
  'server.tasks.restartLostKeptInstance': '面板重启过，未完成的任务无法继续。实例文件夹已保留，请重新操作或自行检查实例',
  'server.tasks.restartCleanupFailed': '面板重启，未完成的任务无法恢复；临时目录清理失败：{reason}',
  'server.tasks.stagingMarkerMismatch': '临时目录中的任务标记与任务记录不匹配，已跳过自动清理',
} satisfies Record<keyof typeof TASKS_MESSAGES, string>;
