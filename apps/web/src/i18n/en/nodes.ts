/** 本机环境页文案（英文主表）。 */
export default {
  'nodes.status.online': 'Online',
  'nodes.status.offline': 'Offline',
  'nodes.status.stale': 'Status May Be Outdated',

  'nodes.subtitle': 'Basic information about the computer running the panel and your Minecraft servers.',
  'nodes.load.staleNotice': 'This data may be out of date. Showing the last node data that loaded successfully.',
  'nodes.load.retry': 'Retry',
  'nodes.load.loading': 'Loading node info…',
  'nodes.empty.body': 'No nodes.',
  'nodes.empty.refresh': 'Refresh Nodes',

  'nodes.local.label': 'This machine',
  'nodes.local.defaultName': 'Local Node',
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
