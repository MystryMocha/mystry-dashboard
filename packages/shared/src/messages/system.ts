/** 服务端返回给用户的消息：系统监测、节点与数据目录锁。值为英文模板，`{name}` 为参数占位；其他语言由 Web 文案表按键翻译。 */
export const SYSTEM_MESSAGES = {
  // 节点
  'server.system.nodeNotFound': 'Node not found.',
  'server.system.nodeInvalidParams': 'The node parameters contain unsupported fields or are malformed.',
  'server.system.remoteNodeCreationDisabled': 'This version does not support creating remote nodes.',
  'server.system.remoteNodeSecretDisabled': 'This version does not support remote node secret operations yet.',
  'server.system.nodeNameRequired': 'The node name cannot be empty.',
  'server.system.localNodeDelete': 'The local node cannot be deleted.',
  'server.system.nodeHasInstances': 'This node still has instances. Move or delete them first.',
  'server.system.localNodeNoSecret': 'The local node does not need a secret.',

  // 主机监测告警
  'server.system.metricsCpuHigh': 'Host CPU has stayed high',
  'server.system.metricsMemoryHigh': 'Host memory has stayed high',
  'server.system.metricsDiskLow': 'Data disk is low on space',
} as const satisfies Record<string, string>;
