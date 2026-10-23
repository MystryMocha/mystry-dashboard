import type en from '../en/nodes';

/** 本机环境页文案（简体中文）。 */
export default {
  'nodes.status.online': '在线',
  'nodes.status.offline': '离线',
  'nodes.status.stale': '状态可能已过期',

  'nodes.subtitle': '运行面板和 Minecraft 服务器的这台电脑的基本信息。',
  'nodes.load.staleNotice': '当前数据可能已过期，正在显示上次成功加载的节点数据。',
  'nodes.load.retry': '重试加载',
  'nodes.load.loading': '正在加载节点信息…',
  'nodes.empty.body': '暂无节点。',
  'nodes.empty.refresh': '刷新节点',

  'nodes.local.label': '本机信息',
  'nodes.local.defaultName': '本机节点',
  'nodes.spec.os': '操作系统',
  'nodes.spec.cpu': 'CPU 架构 / 核心',
  'nodes.spec.threads_one': '{count} 线程',
  'nodes.spec.threads_other': '{count} 线程',
  'nodes.spec.memory': '物理内存总量',
  'nodes.spec.instances': '实例数量',
  'nodes.spec.instanceCount_one': '{count} 个服务实例',
  'nodes.spec.instanceCount_other': '{count} 个服务实例',

  'nodes.remote.title': '其他节点列表',
  'nodes.remote.desc_one': '远程节点 · {count} 个实例 · 最近心跳 {lastSeen}',
  'nodes.remote.desc_other': '远程节点 · {count} 个实例 · 最近心跳 {lastSeen}',

  'nodes.delete.title': '删除节点「{name}」？',
  'nodes.delete.body': '仅可删除没有关联实例的远程节点。删除后无法恢复。',
  'nodes.delete.confirm': '确认删除',
} satisfies Record<keyof typeof en, string>;
