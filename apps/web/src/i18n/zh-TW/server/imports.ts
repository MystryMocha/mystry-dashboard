import type { IMPORTS_MESSAGES } from '@mystry/shared';

/** 服务端消息（imports）的繁體中文翻译；英文模板在 packages/shared/src/messages/imports.ts。 */
export default {
  'server.imports.existing.invalidParams': '既有伺服器匯入參數包含不支援的欄位或格式不正確',
  'server.imports.nameRequired': '實例名稱不能空白',
  'server.imports.zip.singleFileOnly': 'ZIP 預覽只接受一個安裝包檔案',
  'server.imports.zip.oneArchiveOnly': '只能上傳一個 ZIP 安裝包',
  'server.imports.zip.tooLarge': '上傳的檔案超過大小限制',
  'server.imports.zip.missing': '請上傳 ZIP 安裝包',
  'server.imports.zip.invalidConfirmParams': 'ZIP 匯入確認參數包含不支援的欄位或格式不正確',

  'server.imports.progress.writingInstance': '寫入實例資料夾…',
  'server.imports.progress.registering': '登錄實例…',

  'server.imports.zip.task.queued': '正在匯入安裝包…',
  'server.imports.zip.progress.extracting': '正在解壓縮安裝包…',
  'server.imports.zip.progress.validating': '檢查實例檔案…',
  'server.imports.zip.progress.done': '匯入完成',
  'server.imports.zip.duplicateRootPath': 'ZIP 根目錄有重複的路徑：{name}',
  'server.imports.zip.noLaunchTarget': '安裝包中找不到可用的伺服器 jar 或 Forge/NeoForge 啟動參數檔',

  'server.imports.preview.notFound': 'ZIP 匯入預覽不存在',
  'server.imports.preview.expired': 'ZIP 匯入預覽已過期，請重新上傳',
  'server.imports.preview.replaceWhileConfirming': '目前的 ZIP 匯入預覽正在確認，請稍後再替換',
  'server.imports.preview.capacity': 'ZIP 匯入預覽數量已滿，請稍後再試',
  'server.imports.preview.cancelWhileConfirming': 'ZIP 匯入預覽正在確認，無法取消',
  'server.imports.preview.alreadyConfirmed': 'ZIP 匯入預覽已確認，請勿重複提交',
  'server.imports.preview.confirming': 'ZIP 匯入預覽正在確認，請勿重複提交',

  'server.imports.existing.invalidSourceId': '匯入資料夾名稱無效',
  'server.imports.existing.outsideImportDir': '匯入資料夾必須位於面板資料目錄的 imports 資料夾下',
  'server.imports.existing.managedMarker': '此資料夾包含面板實例標記，不能作為匯入來源',
  'server.imports.existing.precheckIncomplete': '快速預檢未找到啟動檔；提交後會在匯入任務中進行完整檢查',
  'server.imports.existing.noLaunchTarget': '找不到伺服器 jar 或 Forge/NeoForge 啟動參數檔',

  'server.imports.existing.task.queued': '等待複製既有伺服器…',
  'server.imports.existing.progress.validating': '正在檢查既有伺服器資料夾…',
  'server.imports.existing.progress.copyStart': '開始複製既有伺服器…',
  'server.imports.existing.progress.copying': '正在複製既有伺服器… {copied}/{total} 項',
  'server.imports.existing.progress.confirmingLaunch': '正在確認啟動檔…',
  'server.imports.existing.progress.done': '既有伺服器已複製到面板管理的資料夾',
  'server.imports.existing.tooManyEntries': '既有伺服器的檔案項目超過上限 {limit}',
  'server.imports.existing.tooLarge': '既有伺服器總大小超過上限 {limit} 位元組',
  'server.imports.existing.markerRefused': '匯入資料夾包含面板實例標記，拒絕複製',
  'server.imports.existing.symlink': '匯入資料夾不能包含符號連結或目錄連接點：{path}',
  'server.imports.existing.specialFile': '匯入資料夾包含不支援的特殊檔案：{path}',
  'server.imports.existing.diskSpace': '面板資料目錄的剩餘空間不足，無法複製既有伺服器',
  'server.imports.existing.missingLaunchTarget': '匯入資料夾中找不到可用的伺服器 jar 或 Forge/NeoForge 啟動參數檔',
  'server.imports.existing.copiedNoLaunchTarget': '複製完成後找不到可用的伺服器啟動檔',

  'server.imports.launchScan.timeout': 'Forge/NeoForge 啟動檔掃描逾時',
  'server.imports.launchScan.tooManyEntries': 'Forge/NeoForge 啟動檔掃描項目過多',
  'server.imports.launchScan.tooDeep': 'Forge/NeoForge 啟動檔掃描層級過深',
  'server.imports.launchScan.symlink': '啟動檔資料夾不能包含符號連結或目錄連接點',

  'server.imports.staging.lost': '部署暫存檔案已遺失，無法完成實例建立，請重新部署',
  'server.imports.staging.instanceDirExists': '實例資料夾已存在，拒絕覆寫既有資料',

  'server.imports.jvmFile.readFailed': '無法讀取 user_jvm_args.txt：{reason}',
  'server.imports.jvmFile.notRegular': 'user_jvm_args.txt 必須是一般檔案，不能是連結或特殊檔案',
  'server.imports.jvmFile.tooLarge': 'user_jvm_args.txt 超過 64 KiB，無法自動沿用',
} satisfies Record<keyof typeof IMPORTS_MESSAGES, string>;
