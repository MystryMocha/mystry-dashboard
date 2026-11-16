import type { DEPLOY_MESSAGES } from '@mystry/shared';

/** 服务端消息（deploy）的繁體中文翻译；英文模板在 packages/shared/src/messages/deploy.ts。 */
export default {
  'server.deploy.unsupportedCore': '不支援的核心類型',
  'server.deploy.invalidParams': '部署參數包含不支援的欄位或格式不正確',
  'server.deploy.missingParams': '缺少必要參數',
  'server.deploy.downloadTimeout': '核心下載逾時',
  'server.deploy.metadataTimeout': '核心中繼資料請求逾時',

  // 核心下载
  'server.deploy.downloadHttpFailed': '下載失敗（HTTP {status}）：{url}',
  'server.deploy.downloadTooLarge': '核心下載檔案超過大小限制',

  // 核心元数据
  'server.deploy.metadataTooLarge': '核心中繼資料超過大小限制',
  'server.deploy.metadataNoBody': '核心中繼資料回應沒有內容',
  'server.deploy.metadataHttpFailed': '請求失敗（HTTP {status}）：{url}',
  'server.deploy.neoforgeVersionInvalid': '無法解析 NeoForge 版本：{version}',
  'server.deploy.vanillaVersionNotFound': '找不到 Vanilla 版本：{version}',
  'server.deploy.vanillaNoServerJar': '此版本沒有官方伺服器 jar：{version}',
  'server.deploy.vanillaManifestNeedsMojang': '部署 Vanilla 時，即使選了國內鏡像也要從 Mojang 讀取版本清單（鏡像檔案的校驗值來自它），這次沒能讀取。{attempts}請確認能連上 launchermeta.mojang.com 後重試。',
  'server.deploy.vanillaMetadataUntrusted': 'Vanilla {version} 的版本資訊無法核對：網址不在 Mojang 官方伺服器上，或缺少校驗值',
  'server.deploy.paperNoBuilds': 'Paper {version} 沒有可用的建置',
  'server.deploy.paperBuildNotFound': 'Paper {version} 沒有建置 #{build}',
  'server.deploy.paperNoDownloadUrl': 'Paper {version}#{build} 缺少下載網址',
  'server.deploy.fabricNoVersions': 'Fabric {version} 沒有可用的 Loader 或 Installer 版本',

  // 部署流程
  'server.deploy.loaderNoVersions': '{coreType} {mcVersion} 沒有可用版本',
  'server.deploy.launchTargetNotFound': '安裝已完成，但找不到可啟動的伺服器 jar 或啟動參數檔案',

  // 安装器（Forge / NeoForge）
  'server.deploy.installerExitCode': '安裝程式結束代碼 {exitCode}\n{output}',
  'server.deploy.installerExitUnknown': '安裝程式結束代碼不明\n{output}',
  'server.deploy.installerDownloadFailed': '安裝程式下載相依套件失敗（{detail}）。{libraries}請檢查網路、Proxy 或防火牆後重新部署。',
  'server.deploy.installerFailedLibraries': '失敗的相依套件：{libraries}；',
  'server.deploy.installerRetried': '已自動重試 {count} 次，{detail}',
  'server.deploy.installerHostReason': '{host} {reason}',
  'server.deploy.installerReason.connectFailed': '連線失敗',
  'server.deploy.installerReason.readTimeout': '讀取逾時',
  'server.deploy.installerReason.dnsFailed': '網域名稱解析失敗',
  'server.deploy.installerReason.tlsFailed': 'TLS 連線失敗',

  // 部署任务进度
  'server.deploy.progress.deploying': '正在部署 {coreType} {mcVersion}',
  'server.deploy.progress.resolvingLoader': '解析 Forge/NeoForge 版本…',
  'server.deploy.progress.usingCachedInstaller': '使用本機快取的安裝程式…',
  'server.deploy.progress.downloadingInstaller': '下載安裝程式…',
  'server.deploy.progress.downloadingInstallerPercent': '下載安裝程式 {percent}%',
  'server.deploy.progress.downloadingInstallerFrom': '從 {source} 下載安裝程式 {percent}%',
  'server.deploy.progress.prefetchingLibraries': '透過鏡像下載安裝程式相依檔案（{done}/{total}）…',
  'server.deploy.progress.runningInstaller': '執行 --installServer…',
  'server.deploy.progress.detectingLaunch': '偵測啟動檔案…',
  'server.deploy.progress.writingInstance': '寫入實例資料夾…',
  'server.deploy.progress.resolvingUrl': '解析下載網址…',
  'server.deploy.progress.usingCache': '使用本機快取…',
  'server.deploy.progress.startingDownload': '開始下載核心…',
  'server.deploy.progress.downloading': '下載中 {percent}%',
  'server.deploy.progress.downloadingFrom': '從 {source} 下載 {percent}%',
  'server.deploy.progress.writingConfig': '寫入啟動設定…',
  'server.deploy.progress.completed': '部署完成',
  'server.deploy.progress.installerDownloading': '安裝程式正在下載 {name}…',
  'server.deploy.progress.installerDownloadingUnknown': '安裝程式正在下載相依檔案…',
  'server.deploy.progress.installerDownloadsDone': '安裝程式已完成 {count} 個下載…',
  'server.deploy.progress.installerNetworkIssue': '安裝程式下載遇到網路問題，正在繼續處理…',
  'server.deploy.progress.installerRetrying': '安裝程式下載不完整，正在自動重試（{attempt}/{max}）…',
} satisfies Record<keyof typeof DEPLOY_MESSAGES, string>;
