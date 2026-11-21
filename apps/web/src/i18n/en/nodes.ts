/** Local environment page strings (English primary table). */
export default {
  'nodes.status.online': 'Online',
  'nodes.status.offline': 'Offline',
  'nodes.status.stale': 'Status May Be Outdated',

  'nodes.load.staleNotice': 'Showing the last data that loaded. It may be out of date.',
  'nodes.load.retry': 'Retry',
  'nodes.load.loading': 'Loading machine info…',
  'nodes.empty.body': 'Machine info could not be read.',
  'nodes.empty.refresh': 'Load Again',

  'nodes.local.label': 'This machine',
  'nodes.local.defaultName': 'This Machine',
  'nodes.spec.os': 'Operating System',
  'nodes.spec.cpu': 'CPU Architecture / Cores',
  'nodes.spec.threads_one': '{count} thread',
  'nodes.spec.threads_other': '{count} threads',
  'nodes.spec.memory': 'Total Physical Memory',
  'nodes.spec.instances': 'Instances',
  'nodes.spec.instanceCount_one': '{count} server instance',
  'nodes.spec.instanceCount_other': '{count} server instances',

  'nodes.remote.title': 'Other Nodes',
  'nodes.remote.desc_one': 'Remote node · {count} instance · Last heartbeat {lastSeen}',
  'nodes.remote.desc_other': 'Remote node · {count} instances · Last heartbeat {lastSeen}',

  'nodes.delete.title': 'Delete node "{name}"?',
  'nodes.delete.body': "Only remote nodes with no instances can be deleted. This can't be undone.",
  'nodes.delete.confirm': 'Delete',
} satisfies Record<string, string>;
