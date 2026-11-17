import type { REMOTE_ACCESS_MESSAGES } from '@mystry/shared';

/** 服務端訊息（從其他裝置存取、面板內建網路、公用位址）的繁體中文翻譯；英文模板在 packages/shared/src/messages/remote-access.ts。 */
export default {
  'server.remoteAccess.invalidRequest': '存取設定的格式不正確',
  'server.remoteAccess.managedByConfig': '存取方式由設定檔裡的 HOST 決定，不能在這裡修改',
  'server.remoteAccess.interfaceRequired': '請先選擇一張網路卡',
  'server.remoteAccess.interfaceGone': '網路卡「{name}」不在了，請重新選擇',
  'server.remoteAccess.noAddress': '這台電腦沒有其他裝置連得到的網路位址',
  'server.remoteAccess.listenFailed': '面板無法在任何位址上監聽。{port} 連接埠可能被別的程式佔用',
  'server.remoteAccess.certificateFailed': 'HTTPS 憑證產生或讀取失敗',
  'server.remoteAccess.launcherUnavailable': '面板正在啟動或關閉，暫時不能修改存取方式',
  'server.panelNetwork.invalidRequest': '面板網路設定的格式不正確',
  'server.panelNetwork.unsupportedPlatform': '這個系統上不能使用面板內建的網路',
  'server.panelNetwork.notEnabled': '請先開啟面板內建的網路',
  'server.panelNetwork.tooManyPeers': '最多新增 {max} 個自訂節點',
  'server.panelNetwork.noPeers': '至少填寫一個節點，或者保留社群共享節點',
  'server.panelNetwork.startFailed': 'EasyTier 啟動失敗',
  'server.panelNetwork.exited': 'EasyTier 意外停止。請關閉後重新開啟面板內建的網路',
  'server.publicHost.invalid': '請填寫公用 IP 或網域，例如 203.0.113.10 或 mc.example.com',
  'server.publicHost.hasPort': '連接埠不用填，會自動使用伺服器的遊戲連接埠',
} satisfies Record<keyof typeof REMOTE_ACCESS_MESSAGES, string>;
