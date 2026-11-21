import type en from '../en/nodes';

/** 本机环境页文案（繁體中文）。 */
export default {
  'nodes.status.online': '線上',
  'nodes.status.offline': '離線',
  'nodes.status.stale': '狀態可能已過期',

  'nodes.load.staleNotice': '顯示的是上次載入的資料，可能已過期。',
  'nodes.load.retry': '重試載入',
  'nodes.load.loading': '正在讀取本機資訊…',
  'nodes.empty.body': '讀不到本機資訊。',
  'nodes.empty.refresh': '重新讀取',

  'nodes.local.label': '本機資訊',
  'nodes.local.defaultName': '本機',
  'nodes.spec.os': '作業系統',
  'nodes.spec.cpu': 'CPU 架構 / 核心',
  'nodes.spec.threads_one': '{count} 個執行緒',
  'nodes.spec.threads_other': '{count} 個執行緒',
  'nodes.spec.memory': '實體記憶體總量',
  'nodes.spec.instances': '實例數量',
  'nodes.spec.instanceCount_one': '{count} 個伺服器實例',
  'nodes.spec.instanceCount_other': '{count} 個伺服器實例',

  'nodes.remote.title': '其他節點清單',
  'nodes.remote.desc_one': '遠端節點 · {count} 個實例 · 最近心跳 {lastSeen}',
  'nodes.remote.desc_other': '遠端節點 · {count} 個實例 · 最近心跳 {lastSeen}',

  'nodes.delete.title': '刪除節點「{name}」？',
  'nodes.delete.body': '只能刪除沒有關聯實例的遠端節點。刪除後無法復原。',
  'nodes.delete.confirm': '確認刪除',
} satisfies Record<keyof typeof en, string>;
