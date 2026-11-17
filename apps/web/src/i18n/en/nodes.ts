/** 本机环境页文案（英文主表）。 */
export default {
  'nodes.status.online': 'Online',
  'nodes.status.offline': 'Offline',
  'nodes.status.stale': 'Status May Be Outdated',

  'nodes.subtitle': 'Basic information about the computer running the panel and your Minecraft servers.',
  'nodes.load.staleNotice': 'Showing the last data that loaded. It may be out of date.',
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

  'nodes.downloadSource.title': 'Download Source',
  'nodes.downloadSource.lead': 'Choose where the panel downloads server files and multiplayer clients.',
  'nodes.downloadSource.official': 'Official',
  'nodes.downloadSource.china': 'China Mirrors',
  'nodes.downloadSource.official.desc': 'Files come straight from Mojang, PaperMC, FabricMC, Forge, NeoForge, and GitHub. The panel never contacts third-party mirrors.',
  'nodes.downloadSource.china.desc': 'Vanilla, Forge, NeoForge, and version lists use BMCLAPI, and frp and EasyTier use public GitHub mirrors. Mirrored files are checked against their checksums before use, so deploying Vanilla still reads the version manifest from Mojang, where those checksums come from. If a mirror fails, the panel falls back to the official source.',
  'nodes.downloadSource.china.limits': "Paper and Fabric server files don't have a reliable mirror, so they still come from the official sites. Forge and NeoForge installers still contact Mojang for some files, and a server can download more files the first time it starts.",
  'nodes.downloadSource.saved': 'Saved. New downloads use this source.',
  'nodes.downloadSource.hint': 'Download source: {source}.',
  'nodes.downloadSource.hint.change': 'Change',
  'nodes.downloadSource.hint.done': 'Done',

  'nodes.remote.title': 'Other Nodes',
  'nodes.remote.desc_one': 'Remote node · {count} instance · Last heartbeat {lastSeen}',
  'nodes.remote.desc_other': 'Remote node · {count} instances · Last heartbeat {lastSeen}',

  'nodes.delete.title': 'Delete node "{name}"?',
  'nodes.delete.body': "Only remote nodes with no instances can be deleted. This can't be undone.",
  'nodes.delete.confirm': 'Delete',
} satisfies Record<string, string>;
