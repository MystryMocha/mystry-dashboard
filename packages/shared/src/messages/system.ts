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

  // 下载来源
  'server.system.downloadSourceInvalid': 'Choose a supported download source.',
  'server.system.downloadAllSourcesFailed': "{name} couldn't be downloaded from any source. {attempts}Try again later, or change the download source on the Panel Settings page.",
  'server.system.metadataAllSourcesFailed': "Version information couldn't be loaded from any source. {attempts}Try again later, or change the download source on the Panel Settings page.",
  'server.system.downloadAttempt': '{source}: {reason}. {next}',
  'server.system.downloadReasonHttp': 'the server returned HTTP {status}',
  'server.system.downloadReasonTimeout': 'the request timed out',
  'server.system.downloadReasonNetwork': "the server couldn't be reached",
  'server.system.downloadReasonInvalid': 'the response could not be read',
  'server.system.downloadReasonChecksum': 'the file failed its checksum check and was discarded',
  'server.system.downloadReasonTooLarge': 'the file is larger than the panel allows',
  'server.system.downloadReasonInsecure': 'the server redirected to an address without HTTPS',
  'server.system.downloadChecksumMismatch': 'The downloaded file did not match its checksum and was discarded.',
  'server.system.downloadInsecureRedirect': 'The download was redirected to an address without HTTPS, so it was stopped.',

  // 主机监测告警
  'server.system.metricsCpuHigh': 'Host CPU has stayed high',
  'server.system.metricsMemoryHigh': 'Host memory has stayed high',
  'server.system.metricsDiskLow': 'Data disk is low on space',
} as const satisfies Record<string, string>;
