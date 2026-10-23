import type { JVM_MESSAGES } from '@mystry/shared';

/** 服务端消息（jvm）的繁體中文翻译；英文模板在 packages/shared/src/messages/jvm.ts。 */
export default {
  'server.jvm.issue.argsTooLong': 'JVM 參數不能超過 {max} 個字元',
  'server.jvm.issue.unclosedQuote': 'JVM 參數包含未閉合的引號',
  'server.jvm.issue.xmsCount': 'JVM 參數必須包含一個且只能有一個 -Xms 初始記憶體參數',
  'server.jvm.issue.xmxCount': 'JVM 參數必須包含一個且只能有一個 -Xmx 最大記憶體參數',
  'server.jvm.issue.xmsFormat': '初始記憶體格式無效，請使用例如 -Xms1G 或 -Xms1024M',
  'server.jvm.issue.xmxFormat': '最大記憶體格式無效，請使用例如 -Xmx4G 或 -Xmx4096M',
  'server.jvm.issue.memoryOrder': '初始記憶體不能大於最大記憶體',
  'server.jvm.issue.memoryHigh': '最大記憶體接近或超過主機可安全分配的範圍，請為系統和面板保留記憶體',
  'server.jvm.issue.panelOwnedArgument': '參數 {argument} 由面板管理，不能寫入 JVM 參數',
  'server.jvm.issue.gcConflict': '垃圾回收器參數不能重複，也不能同時選擇多個回收器',
  'server.jvm.issue.presetCoreMismatch': '{preset} 僅適用於 {cores} 核心',
  'server.jvm.issue.javaMajorUnknown': '{preset} 尚未確認是否相容所選的 Java 版本',
  'server.jvm.issue.presetJavaMismatch': '{preset} 未經驗證支援 Java {java}',
  'server.jvm.issue.paperMemoryMismatch': 'Paper Aikar 方案要求 Xms 與 Xmx 相同',
  'server.jvm.issue.paperMemoryLow': 'PaperMC 建議為 Aikar 參數分配至少 6 GiB 記憶體',

  'server.jvm.preset.compatibility': '相容優先',
  'server.jvm.preset.g1Balanced': 'G1 均衡',
  'server.jvm.preset.paperAikar': 'Paper Aikar',
} satisfies Record<keyof typeof JVM_MESSAGES, string>;
