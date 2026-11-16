import type en from '../en/jvm';

/** JVM 参数配置器、EULA 勾选与 Java 运行时选择文案（繁體中文）。 */
export default {
  // JVM 参数配置器
  'jvm.section.ariaLabel': 'JVM 設定',
  'jvm.detected.legend': '偵測到 user_jvm_args.txt，請確認處理方式',
  'jvm.detected.keep': '沿用偵測到的參數',
  'jvm.detected.recommended': '使用面板建議',
  'jvm.detected.custom': '自訂設定',
  'jvm.raw.label': '原始 JVM 參數（修正錯誤後會回到引導模式）',
  'jvm.memory.max.label': '最大記憶體（MiB）',
  'jvm.memory.help.withHost': '建議 {recommended} MiB · 主機總記憶體約 {total} GiB',
  'jvm.memory.help.noHost': '建議 {recommended} MiB · 無法讀取主機記憶體',
  'jvm.preset.label': '最佳化方案',
  'jvm.preset.compatibility.label': '相容優先',
  'jvm.preset.compatibility.description': '只設定初始與最大記憶體，不附加 GC 調校參數。',
  'jvm.preset.g1-balanced.label': 'G1 均衡',
  'jvm.preset.g1-balanced.description': '使用保守的 G1 暫停目標，適合一般伺服器。',
  'jvm.preset.paper-aikar.label': 'Paper Aikar',
  'jvm.preset.paper-aikar.description': 'PaperMC 官方的 Aikar 參數；建議至少分配 6 GiB。',
  'jvm.preset.custom.option': '自訂（不附加預設方案）',
  'jvm.preset.custom.description': '保留無法歸類的自訂參數。',
  'jvm.preset.source': '凍結版本 {version} · 複核於 {date} · <link>檢視官方來源</link>',
  'jvm.advanced.summary': '進階 JVM 參數',
  'jvm.xms.manual': '手動設定初始記憶體 Xms',
  'jvm.xms.label': '初始記憶體（MiB）',
  'jvm.extra.label': '附加參數',
  'jvm.extra.placeholder': '例如 -Dfile.encoding=UTF-8',
  'jvm.extra.help': '記憶體和啟動目標由面板管理，請勿在這裡重複填寫。',
  'jvm.preview.ariaLabel': '最終 JVM 參數',
  'jvm.preview.title': '最終參數',
  'jvm.preview.empty': '目前沒有可解析的參數',

  // Java 运行时选择
  'java.runtime.label': 'Java 執行環境',
  'java.runtime.systemDefault': '系統預設 Java',
  'java.runtime.option': 'Java {version} · {path}',
  'java.runtime.optionUnavailable': 'Java {version} · {path}（無法使用）',
  'java.runtime.unknownVersion': '未知版本',
  'java.runtime.rescan': '重新偵測',
  'java.runtime.rescanning': '偵測中…',
  'java.runtime.rescan.title': '重新掃描本機的 Java 安裝目錄',
  'java.default.checking': '正在檢查系統預設 Java…',
  'java.default.available': '系統預設 Java 可以使用',
  'java.default.availableWithVersion': '系統預設 Java 可以使用 · {version}',
  'java.default.missing': '找不到系統預設 Java，請先安裝 Java 後點「重新偵測」',
  'java.help.default': '未選擇時使用系統預設 Java；電腦上安裝了多個 Java 時，可以在上方選擇要使用的版本。',
  'java.help.recommended': '目前的 Minecraft {mcVersion} 建議使用 Java {java}。',
  'java.warn.mismatch.selected': '所選的 Java 是 Java {actual}，建議使用 Java {recommended}；版本不符時伺服器可能無法啟動。',
  'java.warn.mismatch.default': '系統預設 Java 是 Java {actual}，建議使用 Java {recommended}；版本不符時伺服器可能無法啟動。',
  'java.warn.unavailable': '之前選擇的 Java 已無法使用，儲存前請點「重新偵測」並重新選擇。',
  'java.error.load': '無法讀取本機的 Java 清單：{error}',
  'java.download.version': '下載 Java {java}',
  'java.download.any': '下載 Java',

  // EULA 勾选
  'eula.agree': '我已閱讀並同意 <link>Minecraft EULA</link>（面板會據此寫入 eula.txt）',

  // 懒加载下拉框
  'select.placeholder': '請選擇',
  'select.empty': '目前沒有選項',
  'select.loadMore': '向下捲動以載入更多…',
} satisfies Record<keyof typeof en, string>;
