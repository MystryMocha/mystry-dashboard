import type en from '../en/console';

/** 控制台文案（简体中文）。 */
export default {
  // 面板写入终端的提示前缀；服务端 process-manager 也写中文「[面板]」
  'console.prefix.panel': '[面板]',
  'console.prefix.error': '[错误]',

  // 写入终端的面板提示
  'console.system.reconnecting_one': '{prefix} {reason}，{count} 秒后重连…',
  'console.system.reconnecting_other': '{prefix} {reason}，{count} 秒后重连…',
  'console.system.reconnected': '{prefix} 控制台已重新连接',
  'console.system.disconnected': '控制台连接已断开',
  'console.system.sessionChanged': '登录会话已变更',
  'console.system.rateLimited': '命令发送过于频繁',
  'console.system.sendBacklog': '网络传输跟不上控制台输出',
  'console.system.tooManyConnections': '控制台连接数已达上限',
  'console.system.closedPolicy': '{prefix} 连接已被服务端关闭，可点击「重新连接」重试。',
  'console.system.closedTooLarge': '{prefix} 控制台消息超出单帧大小限制，连接已关闭，可点击「重新连接」重试。',

  // 连接状态
  'console.status.connected': '实时日志已连接',
  'console.status.connecting': '控制台正在连接…',
  'console.status.disconnected': '连接已断开',
  'console.status.offline': '实例未运行',
  'console.status.detached': '独立运行中，无实时日志',

  // 工具按钮与复制
  'console.tool.reconnect': '重新连接',
  'console.tool.clear': '清空屏幕',
  'console.tool.copyTitle': '复制全部输出',
  'console.tool.copy': '复制日志',
  'console.copy.empty': '暂无可复制的日志。',
  'console.copy.done': '日志已复制。',
  'console.copy.failed': '复制失败：浏览器剪贴板不可用或权限被拒绝，请手动选择日志并复制。',
  'console.tool.screenReader': '读屏模式',
  'console.tool.screenReaderTitle': '让读屏软件可以逐行浏览日志，并朗读新输出',

  // 终端输出区（读屏）
  'console.output.label': '控制台输出',
  'console.output.tooMuchOutput': '输出太多，无法全部朗读，请逐行浏览日志查看其余内容。',

  // 命令输入
  'console.input.label': '控制台命令',
  'console.input.placeholder': '输入控制台命令（如 list、say Hello、op 玩家名），按回车发送',
  'console.input.placeholderConnecting': '连接中…',
  'console.input.placeholderDisconnected': '控制台已断开，重新连接后可发送命令。',
  'console.input.placeholderStopped': '实例已停止，启动后可发送命令',
  'console.input.placeholderDetached': '面板无法向独立运行的进程发送命令',

  // 常用命令
  'console.quick.label': '常用命令',
  'console.quick.sendTitle': '向服务器发送 /{command}',
  'console.quick.list': '玩家列表',
  'console.quick.saveAll': '保存世界',
  'console.quick.tps': '刻率性能',
  'console.quick.whitelist': '白名单',
  'console.quick.help': '命令帮助',
} satisfies Record<keyof typeof en, string>;
