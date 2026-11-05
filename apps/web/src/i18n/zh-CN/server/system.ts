import type { SYSTEM_MESSAGES } from '@mystry/shared';

/** 服务端消息（system）的简体中文翻译；英文模板在 packages/shared/src/messages/system.ts。 */
export default {
  // 节点
  'server.system.nodeNotFound': '节点不存在',
  'server.system.nodeInvalidParams': '节点参数包含不支持的字段或格式不正确',
  'server.system.remoteNodeCreationDisabled': '当前版本不支持创建远程节点',
  'server.system.remoteNodeSecretDisabled': '当前版本暂不支持远程节点密钥操作',
  'server.system.nodeNameRequired': '节点名称不能为空',
  'server.system.localNodeDelete': '本机节点不可删除',
  'server.system.nodeHasInstances': '该节点下还有实例，请先迁移或删除这些实例',
  'server.system.localNodeNoSecret': '本机节点无需密钥',

  // 下载来源
  'server.system.downloadSourceInvalid': '请选择支持的下载来源',
  'server.system.downloadAllSourcesFailed': '{name} 在所有下载来源都下载失败。{attempts}请稍后重试，或到「本机环境」页更换下载来源。',
  'server.system.metadataAllSourcesFailed': '所有来源都无法读取版本信息。{attempts}请稍后重试，或到「本机环境」页更换下载来源。',
  'server.system.downloadAttempt': '{source}：{reason}。{next}',
  'server.system.downloadReasonHttp': '服务器返回 HTTP {status}',
  'server.system.downloadReasonTimeout': '请求超时',
  'server.system.downloadReasonNetwork': '无法连接服务器',
  'server.system.downloadReasonInvalid': '无法读取返回内容',
  'server.system.downloadReasonChecksum': '文件校验失败，已丢弃',
  'server.system.downloadReasonTooLarge': '文件超过面板允许的大小',
  'server.system.downloadChecksumMismatch': '下载的文件校验值不符，已丢弃',

  // 主机监测告警
  'server.system.metricsCpuHigh': '主机 CPU 持续偏高',
  'server.system.metricsMemoryHigh': '主机内存持续偏高',
  'server.system.metricsDiskLow': '数据盘剩余空间不足',
} satisfies Record<keyof typeof SYSTEM_MESSAGES, string>;
