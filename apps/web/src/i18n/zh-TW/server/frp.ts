import type { FRP_MESSAGES } from '@mystry/shared';

/** 服務端訊息（frp）的繁體中文翻譯；英文模板在 packages/shared/src/messages/frp.ts。 */
export default {
  'server.frp.invalidParams': '聯機設定包含不支援的欄位或格式不正確',
  'server.frp.endpointNotFound': '找不到這個穿透伺服器',
  'server.frp.endpointInUse': '還有實例在使用這個穿透伺服器，請先關閉那個實例的聯機',
  'server.frp.endpointNameRequired': '穿透伺服器名稱不能為空',
  'server.frp.hostInvalid': '請填寫主機名稱或 IP 位址，不要帶協定、路徑或連接埠',
  'server.frp.tokenRequired': '需要填寫穿透權杖',
  'server.frp.tokenInvalid': '穿透權杖包含無法儲存的字元',
  'server.frp.remotePortRequired': '請選擇朋友要連線的公開連接埠',
  'server.frp.remotePortInUse': '這個穿透伺服器上的另一個實例已經使用了該公開連接埠',
  'server.frp.instanceNotFound': '實例不存在',
  'server.frp.serverIpBlocked': '請先清空 server.properties 裡的 server-ip。遊戲必須在這台電腦上接受連線，不能只監聽某個區域網路位址',
  'server.frp.localPortIsPanel': '遊戲連接埠和面板連接埠相同。開放聯機前請先修改 server-port',
  'server.frp.localPortInvalid': 'server.properties 裡的遊戲連接埠不是有效連接埠',
  'server.frp.clientMissing': '尚未安裝官方 frp 用戶端',
  'server.frp.platformUnsupported': '這個作業系統沒有釘選版本的官方 frp 用戶端',
  'server.frp.downloadFailed': '官方 frp 用戶端下載失敗',
  'server.frp.checksumMismatch': '下載的 frp 用戶端與釘選的檢查碼不一致，已捨棄',
  'server.frp.extractFailed': '官方 frp 用戶端壓縮檔無法解壓縮',
  'server.frp.notRunning': '請先啟動實例再開放隧道。只有遊戲在執行時朋友才能連線',
  'server.frp.startFailed': '隧道用戶端啟動失敗',
  'server.frp.loginFailed': '隧道用戶端登入失敗。請檢查位址、連接埠、權杖、傳輸協定和 TLS 設定',
  'server.frp.proxyFailed': '穿透伺服器拒絕了遊戲隧道。公開連接埠可能已被占用',
  'server.frp.exited': '隧道用戶端已結束。遊戲執行後再次儲存聯機設定即可重試',
  'server.frp.visitorUnavailable': '下載朋友設定前，需要先使用內網隧道',
} satisfies Record<keyof typeof FRP_MESSAGES, string>;
