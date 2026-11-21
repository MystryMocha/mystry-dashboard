import type en from '../en/nodes';

/** 本机环境页文案（简体中文）。 */
export default {
  'nodes.status.online': '在线',
  'nodes.status.offline': '离线',
  'nodes.status.stale': '状态可能已过期',

  'nodes.load.staleNotice': '显示的是上次加载到的数据，可能已过期。',
  'nodes.load.retry': '重试加载',
  'nodes.load.loading': '正在读取本机信息…',
  'nodes.empty.body': '读不到本机信息。',
  'nodes.empty.refresh': '重新读取',

  'nodes.local.label': '本机信息',
  'nodes.local.defaultName': '本机',
  'nodes.spec.os': '操作系统',
  'nodes.spec.cpu': 'CPU 架构 / 核心',
  'nodes.spec.threads_one': '{count} 线程',
  'nodes.spec.threads_other': '{count} 线程',
  'nodes.spec.memory': '物理内存总量',
  'nodes.spec.instances': '实例数量',
  'nodes.spec.instanceCount_one': '{count} 个服务实例',
  'nodes.spec.instanceCount_other': '{count} 个服务实例',

  'nodes.session.title': '登录',
  'nodes.session.lead': '设置登录后多久需要重新输入密码。',
  'nodes.session.label': '登录有效期',
  'nodes.session.option.2h': '2 小时',
  'nodes.session.option.12h': '12 小时（默认）',
  'nodes.session.option.1d': '1 天',
  'nodes.session.option.7d': '7 天',
  'nodes.session.option.30d': '30 天',
  'nodes.session.option.never': '不过期',
  'nodes.session.help': '改短后，登录已超过新时长的设备需要重新登录；改长后，这台设备马上按新时长计算，其他设备下次登录后生效。',
  'nodes.session.never.desc': '选「不过期」后，登录过的设备会一直保持登录，直到修改密码。开启了「在其他设备上打开」时请谨慎使用。',
  'nodes.session.saved': '已保存，这台设备的登录已按新时长计算。',

  'nodes.downloadSource.title': '下载来源',
  'nodes.downloadSource.lead': '选择面板从哪里下载服务端文件和联机客户端。',
  'nodes.downloadSource.official': '官方来源',
  'nodes.downloadSource.china': '国内镜像',
  'nodes.downloadSource.official.desc': '文件直接来自 Mojang、PaperMC、FabricMC、Forge、NeoForge 和 GitHub，面板不会连接第三方镜像。',
  'nodes.downloadSource.china.desc': 'Vanilla、Forge、NeoForge 和版本列表使用 BMCLAPI，frp 和 EasyTier 使用公共 GitHub 镜像。镜像下载的文件都会先核对校验值再使用，因此部署 Vanilla 时仍会从 Mojang 读取提供校验值的版本清单；镜像失败时自动改用官方来源。',
  'nodes.downloadSource.china.limits': 'Paper 和 Fabric 的服务端文件没有可靠的镜像，仍从官方网站下载。Forge 和 NeoForge 安装器的部分文件仍要连接 Mojang，服务端第一次启动时也可能再下载文件。',
  'nodes.downloadSource.saved': '已保存，之后的下载使用这个来源。',
  'nodes.downloadSource.hint': '下载来源：{source}。',
  'nodes.downloadSource.hint.change': '更改',
  'nodes.downloadSource.hint.done': '完成',

  'nodes.remote.title': '其他节点列表',
  'nodes.remote.desc_one': '远程节点 · {count} 个实例 · 最近心跳 {lastSeen}',
  'nodes.remote.desc_other': '远程节点 · {count} 个实例 · 最近心跳 {lastSeen}',

  'nodes.delete.title': '删除节点「{name}」？',
  'nodes.delete.body': '仅可删除没有关联实例的远程节点。删除后无法恢复。',
  'nodes.delete.confirm': '确认删除',
} satisfies Record<keyof typeof en, string>;
