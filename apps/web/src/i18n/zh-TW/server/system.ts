import type { SYSTEM_MESSAGES } from '@mystry/shared';

/** 服务端消息（system）的繁體中文翻译；英文模板在 packages/shared/src/messages/system.ts。 */
export default {
  // 节点
  'server.system.nodeNotFound': '節點不存在',
  'server.system.nodeInvalidParams': '節點參數包含不支援的欄位或格式不正確',
  'server.system.remoteNodeCreationDisabled': '目前版本不支援建立遠端節點',
  'server.system.remoteNodeSecretDisabled': '目前版本暫不支援遠端節點金鑰操作',
  'server.system.nodeNameRequired': '節點名稱不能為空',
  'server.system.localNodeDelete': '本機節點不可刪除',
  'server.system.nodeHasInstances': '此節點下還有實例，請先遷移或刪除這些實例',
  'server.system.localNodeNoSecret': '本機節點不需要金鑰',

  // 下载来源
  'server.system.downloadSourceInvalid': '請選擇支援的下載來源',
  'server.system.downloadAllSourcesFailed': '{name} 在所有下載來源都下載失敗。{attempts}請稍後再試，或到「面板設定」頁更換下載來源。',
  'server.system.metadataAllSourcesFailed': '所有來源都無法讀取版本資訊。{attempts}請稍後再試，或到「面板設定」頁更換下載來源。',
  'server.system.downloadAttempt': '{source}：{reason}。{next}',
  'server.system.downloadReasonHttp': '伺服器回傳 HTTP {status}',
  'server.system.downloadReasonTimeout': '要求逾時',
  'server.system.downloadReasonNetwork': '無法連線至伺服器',
  'server.system.downloadReasonInvalid': '無法讀取回傳內容',
  'server.system.downloadReasonChecksum': '檔案校驗失敗，已捨棄',
  'server.system.downloadReasonTooLarge': '檔案超過面板允許的大小',
  'server.system.downloadReasonInsecure': '伺服器重新導向到不使用 HTTPS 的網址',
  'server.system.downloadChecksumMismatch': '下載的檔案校驗值不符，已捨棄',
  'server.system.downloadInsecureRedirect': '下載被重新導向到不使用 HTTPS 的網址，已停止',

  // 主机监测告警
  'server.system.metricsCpuHigh': '主機 CPU 持續偏高',
  'server.system.metricsMemoryHigh': '主機記憶體持續偏高',
  'server.system.metricsDiskLow': '資料磁碟剩餘空間不足',
} satisfies Record<keyof typeof SYSTEM_MESSAGES, string>;
