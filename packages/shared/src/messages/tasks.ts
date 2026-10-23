/** 服务端返回给用户的消息：后台任务队列与进度。值为英文模板，`{name}` 为参数占位；其他语言由 Web 文案表按键翻译。 */
export const TASKS_MESSAGES = {
  'server.tasks.queued': 'Queued',
  'server.tasks.completed': 'Completed',
  'server.tasks.failed': 'Failed',
  'server.tasks.cancelled': 'Cancelled',
  'server.tasks.interrupted': 'Interrupted',
  'server.tasks.capacity': 'Too many tasks are queued. Try again later.',
  'server.tasks.shuttingDown': 'The panel is shutting down and no longer accepts new tasks.',
  'server.tasks.cancelledByShutdown': 'The panel is shutting down, so the task was cancelled.',
  'server.tasks.timeout': 'The task timed out.',
  'server.tasks.aborted': 'The task was cancelled.',
  'server.tasks.notFound': 'Task not found.',
  'server.tasks.restartLost': 'The panel restarted and in-memory tasks can\'t be resumed. Submit it again.',
  'server.tasks.restartLostKeptInstance': 'The panel restarted and in-memory tasks can\'t be resumed. The instance folder was kept. Submit it again or check the task manually.',
  'server.tasks.restartCleanupFailed': 'The panel restarted and the unfinished task can\'t be resumed. Cleaning up its temporary folder failed: {reason}',
  'server.tasks.stagingMarkerMismatch': 'The task marker in the temporary folder doesn\'t match the task record, so automatic cleanup was skipped.',
} as const satisfies Record<string, string>;
