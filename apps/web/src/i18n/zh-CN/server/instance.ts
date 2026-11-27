import type { INSTANCE_MESSAGES } from '@mystry/shared';

/** 服务端消息（instance）的简体中文翻译；英文模板在 packages/shared/src/messages/instance.ts。 */
export default {
  // 实例接口
  'server.instance.notFound': '实例不存在',
  'server.instance.invalidParams': '实例参数包含不支持的字段或格式不正确',
  'server.instance.nameRequired': '名称不能为空',
  'server.instance.commandInvalid': '命令过长、为空或包含不支持的字段',

  // 创建、注册、删除与接管
  'server.instance.javaRuntimeInvalid': '所选 Java 运行时不存在或不可用，请重新扫描后再选择',
  'server.instance.selectedNodeNotFound': '所选节点不存在',
  'server.instance.remoteNodeUnsupported': '当前版本不支持在远程节点上创建实例',
  'server.instance.createDbFailed': '创建实例失败：数据库未写入实例记录',
  'server.instance.defaultDirNotEmpty': '默认实例目录必须为空，拒绝接管已有目录',
  'server.instance.createDirFailed': '无法创建或写入安装目录：{dir}（{reason}）',
  'server.instance.registerDirMissing': '实例目录不存在，无法注册实例',
  'server.instance.registerDirEmpty': '实例目录为空，无法注册实例',
  'server.instance.deleteRunning': '请先停止实例再删除',
  'server.instance.deleteDbFailed': '删除实例失败：数据库记录未删除',
  'server.instance.adoptRunning': '请先停止实例再完成迁移',
  'server.instance.adoptAlreadyManaged': '实例已经在面板数据目录里，不需要迁移',
  'server.instance.adoptDirEmpty': '默认实例目录不能为空',
  'server.instance.adoptDirFailed': '无法完成迁移：{reason}',
  'server.instance.adoptMarkerInvalid': '无法完成迁移：实例文件夹里的面板标记文件无效，或属于另一个实例',
  'server.instance.adoptStateChanged': '迁移失败：实例状态已变化，请重试',
  'server.instance.propertiesNotRegularFile': 'server.properties 不是普通文件',

  // 进程启停
  'server.instance.startShuttingDown': '面板正在关闭，无法启动实例',
  'server.instance.startCancelledShuttingDown': '面板正在关闭，已取消启动',
  'server.instance.alreadyRunning': '实例已在运行或正在启停',
  'server.instance.forgeArgsMissing': '找不到 Forge/NeoForge 启动参数文件：{path}，请重新部署该实例',
  'server.instance.modloaderNotInstalled': 'Forge/NeoForge 尚未完成安装，请重新部署，或在任务中心查看安装失败原因',
  'server.instance.jarMissing': '找不到服务端 jar：{jar}',
  'server.instance.notRunning': '实例未在运行',
  'server.instance.stillStarting': '实例正在启动中，请稍后再试',
  'server.instance.stopPending': '实例仍在停止中，请等待或选择强制停止',
  'server.instance.forceStopPending': '实例仍在强制终止中，请稍候',
  'server.instance.stopStdinUnavailable': '实例输入流不可用，无法发送停止命令',
  'server.instance.stopWriteFailed': '停止命令写入失败',
  'server.instance.forgetRunning': '运行中的实例不能清理进程状态',
  'server.instance.orphanProcessRunning': '该实例上次启动的服务器进程（PID {pid}）仍在运行，请先停止后再继续操作',
  'server.instance.orphanStopRequiresForce': '残留的服务器进程（PID {pid}）在 Windows 上已无法接收控制台命令，请改用「强制停止」',
  'server.instance.orphanStopPending': '残留的服务器进程（PID {pid}）仍在停止中，请等待或选择强制停止',
  'server.instance.orphanForceStopPending': '残留的服务器进程（PID {pid}）仍在强制终止中，请稍候',
  'server.instance.orphanSignalFailed': '停止残留的服务器进程（PID {pid}）失败：{reason}',

  // 控制台命令
  'server.instance.commandNotRunning': '实例未在运行，无法发送命令',
  'server.instance.commandEmpty': '命令不能为空',
  'server.instance.commandControlChars': '命令不能包含换行或控制字符',
  'server.instance.commandTooLarge': '命令超过大小限制（{limit} 字节）',
  'server.instance.stdinBusy': '控制台输入缓冲繁忙，请稍后重试',
  'server.instance.stdinUnavailable': '实例输入流不可用',
  'server.instance.stdinTooLarge': '控制台输入缓冲超过大小限制（{limit} 字节）',
  'server.instance.commandWriteFailed': '命令写入失败，实例输入流不可用',

  // 控制台连接
  'server.instance.consoleTicketLimit': '控制台连接请求太多，请稍后重试',
  'server.instance.consoleTicketMissing': '缺少控制台连接凭证，请刷新页面后重试',
  'server.instance.consoleTicketInvalid': '控制台连接凭证无效或已过期，请刷新页面后重试',
  'server.instance.consoleMessageTooLarge': '控制台消息超过大小限制（{limit} 字节）',
  'server.instance.consoleCommandRateLimited': '发送命令过于频繁，请稍后重试',

  // 写入控制台日志的面板提示
  'server.instance.consoleProcessStartFailed': '[面板] 进程启动失败：{reason}',
  'server.instance.consoleProcessExited': '[面板] 进程已退出（退出码 {code}，信号 {signal}）',
  'server.instance.consoleNone': '无',

  // Java 运行时
  'server.instance.javaRuntimeUnavailable': '所选 Java 运行时不可用，请重新扫描后再选择',
  'server.instance.javaRuntimeFileMissing': 'Java 运行时文件不存在：{path}，请重新扫描后再选择',
  'server.instance.javaRuntimePathUnresolved': '无法解析 Java 运行时路径：{path}，请重新扫描后再选择',
  'server.instance.javaRuntimePathChanged': 'Java 运行时路径已变化，请重新扫描后再选择',
  'server.instance.javaRuntimeVerifyFailed': '所选 Java 运行时无法通过验证，请重新扫描后再选择',
} satisfies Record<keyof typeof INSTANCE_MESSAGES, string>;
