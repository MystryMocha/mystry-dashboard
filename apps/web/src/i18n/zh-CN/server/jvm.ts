import type { JVM_MESSAGES } from '@mystry/shared';

/** 服务端消息（jvm）的简体中文翻译；英文模板在 packages/shared/src/messages/jvm.ts。 */
export default {
  'server.jvm.issue.argsTooLong': 'JVM 参数不能超过 {max} 个字符',
  'server.jvm.issue.unclosedQuote': 'JVM 参数包含未闭合的引号',
  'server.jvm.issue.xmsCount': 'JVM 参数必须且只能包含一个 -Xms 初始内存参数',
  'server.jvm.issue.xmxCount': 'JVM 参数必须且只能包含一个 -Xmx 最大内存参数',
  'server.jvm.issue.xmsFormat': '初始内存格式无效，请使用例如 -Xms1G 或 -Xms1024M',
  'server.jvm.issue.xmxFormat': '最大内存格式无效，请使用例如 -Xmx4G 或 -Xmx4096M',
  'server.jvm.issue.memoryOrder': '初始内存不能大于最大内存',
  'server.jvm.issue.memoryHigh': '最大内存接近或超过主机可安全分配范围，请为系统和面板保留内存',
  'server.jvm.issue.panelOwnedArgument': '参数 {argument} 由面板管理，不能写入 JVM 参数',
  'server.jvm.issue.gcConflict': '垃圾回收器参数不能重复，也不能同时选择多个回收器',
  'server.jvm.issue.presetCoreMismatch': '{preset} 仅适用于 {cores} 核心',
  'server.jvm.issue.javaMajorUnknown': '{preset} 尚未确认所选 Java 版本是否兼容',
  'server.jvm.issue.presetJavaMismatch': '{preset} 未验证支持 Java {java}',
  'server.jvm.issue.paperMemoryMismatch': 'Paper Aikar 方案要求 Xms 与 Xmx 相同',
  'server.jvm.issue.paperMemoryLow': 'PaperMC 建议为 Aikar 参数分配至少 6 GiB 内存',

  'server.jvm.javaInstall.queued': '等待安装 Java {major}',
  'server.jvm.javaInstall.downloading': '正在下载 Java {major}（{percent}%）',
  'server.jvm.javaInstall.extracting': '正在解压 Java {major}',
  'server.jvm.javaInstall.verifying': '正在检查 Java {major}',
  'server.jvm.javaInstall.unsupportedMajor': '面板不能自动安装 Java {major}。',
  'server.jvm.javaInstall.platformUnsupported': '这个系统上面板不能自动安装 Java。请自己下载安装 Java，再点「重新探测」。',
  'server.jvm.javaInstall.downloadFailed': 'Java {major} 没能下载下来。如果这里访问 GitHub 很慢或打不开，请把下载来源改成国内镜像再试，或者自己下载安装 Java。',
  'server.jvm.javaInstall.checksumMismatch': '下载的 Java {major} 和钉死的校验值不一致，已丢弃。',
  'server.jvm.javaInstall.extractFailed': 'Java {major} 的压缩包没能解压。',
  'server.jvm.javaInstall.verifyFailed': '装好的 Java {major} 运行不正常，没有加入列表。',

  'server.jvm.preset.compatibility': '兼容优先',
  'server.jvm.preset.g1Balanced': 'G1 均衡',
  'server.jvm.preset.paperAikar': 'Paper Aikar',
} satisfies Record<keyof typeof JVM_MESSAGES, string>;
