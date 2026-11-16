import type en from '../en/instance';

/** 实例工作台外壳与实例设置文案（繁體中文）。 */
export default {
  // 工作台头部与标签页
  'instance.header.backTitle': '返回總覽',
  'instance.header.version': '版本 {version}',
  'instance.tabs.label': '實例功能',

  // 面板托管的实例目录（用于迁移提示与设置页的安装路径占位）
  'instance.path.managed': '面板資料目錄/instances/{id}',

  // 迁移到托管目录
  'instance.migration.title': '接管託管目錄',
  'instance.migration.instructions': '請使用系統的檔案總管，將舊實例的檔案複製到面板資料目錄下的實例資料夾：',
  'instance.migration.note': '面板不會讀取或刪除舊目錄。複製完成後按一下「接管託管目錄」，成功後即可恢復實例操作。',
  'instance.migration.checking': '檢查中…',
  'instance.migration.adopt': '接管託管目錄',

  // 重启 / 强制停止确认
  'instance.restart.title': '要重新啟動實例「{name}」嗎？',
  'instance.restart.description': '重新啟動會中斷目前的遊戲程序並中斷所有線上玩家的連線，尚未儲存的世界資料可能會遺失。',
  'instance.restart.confirm': '確認重新啟動',
  'instance.forceStop.title': '要強制停止實例「{name}」嗎？',
  'instance.forceStop.description': '強制停止會立即結束程序，可能導致世界損毀。建議先嘗試一般的「停止」。',
  'instance.forceStop.confirm': '確認強制停止',

  // 实例设置
  'instance.settings.section.basic': '基本資訊',
  'instance.settings.section.runtime': '執行環境',
  'instance.settings.section.eula': '授權協議',
  'instance.settings.name.label': '名稱',
  'instance.settings.jarFile.label': 'Jar 檔名',
  'instance.settings.installPath.label': '安裝路徑',
  'instance.settings.installPath.help': '實例目錄由面板託管，建立後無法修改。',
  'instance.settings.status.dirty': '有尚未儲存的設定。',
  'instance.settings.status.saved': '設定已儲存。',
  'instance.settings.status.idle': '修改後按「儲存設定」即可生效。',
  'instance.settings.save': '儲存設定',
  'instance.settings.unsaved.title': '要捨棄尚未儲存的設定修改嗎？',
  'instance.settings.unsaved.savingTitle': '正在儲存設定…',
  'instance.settings.unsaved.description': '離開設定頁面會遺失尚未儲存的實例設定。',

  // 启动失败原因提示（控制台上方）
  'instance.startIssue.eula.title': '同意 Minecraft EULA 後才能啟動這個伺服器',
  'instance.startIssue.eula.body': 'Minecraft 伺服器必須先同意 <link>Minecraft EULA</link> 才能執行。點「同意並啟動」表示你已閱讀並同意該協議，面板會寫入 eula.txt 並啟動伺服器。',
  'instance.startIssue.eula.action': '同意並啟動',
  'instance.startIssue.java.title': '這個伺服器需要 Java {java}',
  'instance.startIssue.java.titleUnknown': '這個伺服器需要換一個 Java 版本',
  'instance.startIssue.javaTooNew.body': '啟動時使用的 Java 版本太新，伺服器剛啟動就結束了。請安裝 Java {java}，然後開啟「實例設定」，點「重新偵測」，選擇 Java {java}，儲存後再啟動。',
  'instance.startIssue.javaTooOld.body': '啟動時使用的 Java 版本太舊，伺服器剛啟動就結束了。請安裝 Java {java}，然後開啟「實例設定」，點「重新偵測」，選擇 Java {java}，儲存後再啟動。',
  'instance.startIssue.java.bodyUnknown': '啟動時使用的 Java 版本和這個伺服器不相符，伺服器剛啟動就結束了。請查看伺服器端或整合包要求的 Java 版本並安裝，然後開啟「實例設定」，點「重新偵測」，選擇它，儲存後再啟動。',
  'instance.startIssue.java.openSettings': '開啟實例設定',

  // 未保存修改弹窗（设置与参数配置共用）
  'instance.unsaved.savingDescription': '儲存完成後會自動繼續離開；儲存期間無法捨棄或取消。',
  'instance.unsaved.confirm': '捨棄修改並離開',
} satisfies Record<keyof typeof en, string>;
