import type en from '../en/nodes';

/** 本机环境页文案（繁體中文）。 */
export default {
  'nodes.status.online': '線上',
  'nodes.status.offline': '離線',
  'nodes.status.stale': '狀態可能已過期',

  'nodes.subtitle': '執行面板與 Minecraft 伺服器的這台電腦的基本資訊。',
  'nodes.load.staleNotice': '顯示的是上次載入的資料，可能已過期。',
  'nodes.load.retry': '重試載入',
  'nodes.load.loading': '正在載入節點資訊…',
  'nodes.empty.body': '尚無節點。',
  'nodes.empty.refresh': '重新整理節點',

  'nodes.local.label': '本機資訊',
  'nodes.local.defaultName': '本機節點',
  'nodes.spec.os': '作業系統',
  'nodes.spec.cpu': 'CPU 架構 / 核心',
  'nodes.spec.threads_one': '{count} 個執行緒',
  'nodes.spec.threads_other': '{count} 個執行緒',
  'nodes.spec.memory': '實體記憶體總量',
  'nodes.spec.instances': '實例數量',
  'nodes.spec.instanceCount_one': '{count} 個伺服器實例',
  'nodes.spec.instanceCount_other': '{count} 個伺服器實例',

  'nodes.session.title': '登入',
  'nodes.session.lead': '設定登入後多久需要重新輸入密碼。',
  'nodes.session.label': '登入有效期限',
  'nodes.session.option.2h': '2 小時',
  'nodes.session.option.12h': '12 小時（預設）',
  'nodes.session.option.1d': '1 天',
  'nodes.session.option.7d': '7 天',
  'nodes.session.option.30d': '30 天',
  'nodes.session.option.never': '不過期',
  'nodes.session.help': '改短後，登入已超過新時長的裝置需要重新登入；改長後，這台裝置立即按新時長計算，其他裝置下次登入後生效。',
  'nodes.session.never.desc': '選「不過期」後，登入過的裝置會一直保持登入，直到修改密碼。開啟了「在其他裝置上開啟」時請謹慎使用。',
  'nodes.session.saved': '已儲存，這台裝置的登入已按新時長計算。',

  'nodes.downloadSource.title': '下載來源',
  'nodes.downloadSource.lead': '選擇面板從哪裡下載伺服器檔案和連線用戶端。',
  'nodes.downloadSource.official': '官方來源',
  'nodes.downloadSource.china': '中國大陸鏡像',
  'nodes.downloadSource.official.desc': '檔案直接來自 Mojang、PaperMC、FabricMC、Forge、NeoForge 和 GitHub，面板不會連線至第三方鏡像。',
  'nodes.downloadSource.china.desc': 'Vanilla、Forge、NeoForge 和版本清單使用 BMCLAPI，frp 和 EasyTier 使用公共 GitHub 鏡像。鏡像下載的檔案都會先核對校驗值再使用，因此部署 Vanilla 時仍會從 Mojang 讀取提供校驗值的版本清單；鏡像失敗時自動改用官方來源。',
  'nodes.downloadSource.china.limits': 'Paper 和 Fabric 的伺服器檔案沒有可靠的鏡像，仍從官方網站下載。Forge 和 NeoForge 安裝程式的部分檔案仍要連線至 Mojang，伺服器第一次啟動時也可能再下載檔案。',
  'nodes.downloadSource.saved': '已儲存，之後的下載使用這個來源。',
  'nodes.downloadSource.hint': '下載來源：{source}。',
  'nodes.downloadSource.hint.change': '變更',
  'nodes.downloadSource.hint.done': '完成',

  'nodes.remote.title': '其他節點清單',
  'nodes.remote.desc_one': '遠端節點 · {count} 個實例 · 最近心跳 {lastSeen}',
  'nodes.remote.desc_other': '遠端節點 · {count} 個實例 · 最近心跳 {lastSeen}',

  'nodes.delete.title': '刪除節點「{name}」？',
  'nodes.delete.body': '只能刪除沒有關聯實例的遠端節點。刪除後無法復原。',
  'nodes.delete.confirm': '確認刪除',
} satisfies Record<keyof typeof en, string>;
