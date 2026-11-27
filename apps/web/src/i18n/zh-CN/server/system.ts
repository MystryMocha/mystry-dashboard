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
  'server.system.autoRestartInvalid': '崩溃后自动重启的数值须为允许范围内的整数',
  'server.system.downloadSourceInvalid': '请选择支持的下载来源',
  'server.system.downloadAllSourcesFailed': '{name} 在所有下载来源都下载失败。{attempts}请稍后重试，或到「面板设置」页更换下载来源。',
  'server.system.metadataAllSourcesFailed': '所有来源都无法读取版本信息。{attempts}请稍后重试，或到「面板设置」页更换下载来源。',
  'server.system.downloadAttempt': '{source}：{reason}。{next}',
  'server.system.downloadReasonHttp': '服务器返回 HTTP {status}',
  'server.system.downloadReasonTimeout': '请求超时',
  'server.system.downloadReasonNetwork': '无法连接服务器',
  'server.system.downloadReasonInvalid': '无法读取返回内容',
  'server.system.downloadReasonChecksum': '文件校验失败，已丢弃',
  'server.system.downloadReasonTooLarge': '文件超过面板允许的大小',
  'server.system.downloadReasonInsecure': '服务器跳转到了不使用 HTTPS 的地址',
  'server.system.downloadChecksumMismatch': '下载的文件校验值不符，已丢弃',
  'server.system.downloadInsecureRedirect': '下载被跳转到不使用 HTTPS 的地址，已停止',

  // 主机监测告警
  'server.system.metricsCpuHigh': '主机 CPU 持续偏高',
  'server.system.metricsMemoryHigh': '主机内存持续偏高',
  'server.system.metricsDiskLow': '数据盘剩余空间不足',

  // 概览统计
  'server.system.statsRangeInvalid': '请选择支持的时间范围（24 小时、7 天或 30 天）',
} satisfies Record<keyof typeof SYSTEM_MESSAGES, string>;
