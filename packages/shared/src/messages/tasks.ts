/** User-facing server messages: background task queue and progress. Values are English templates with `{name}` placeholders; the Web string tables translate other languages by key. */
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
  'server.tasks.cancelledByUser': 'You cancelled this task.',
  'server.tasks.notFound': 'Task not found.',
  'server.tasks.restartLost': 'The panel restarted, so this unfinished task can\'t continue. Start it again.',
  'server.tasks.restartLostKeptInstance': 'The panel restarted, so this unfinished task can\'t continue. The instance folder was kept. Start it again, or check the instance yourself.',
  'server.tasks.restartCleanupFailed': 'The panel restarted and the unfinished task can\'t be resumed. Cleaning up its temporary folder failed: {reason}',
  'server.tasks.stagingMarkerMismatch': 'The task marker in the temporary folder doesn\'t match the task record, so automatic cleanup was skipped.',
} as const satisfies Record<string, string>;
