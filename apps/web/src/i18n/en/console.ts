/** 控制台文案（英文主表）。 */
export default {
  // 面板写入终端的提示前缀；着色函数会同时识别所有语言的前缀
  'console.prefix.panel': '[Panel]',
  'console.prefix.error': '[Error]',

  // 写入终端的面板提示
  'console.system.reconnecting_one': '{prefix} {reason}. Reconnecting in {count} second…',
  'console.system.reconnecting_other': '{prefix} {reason}. Reconnecting in {count} seconds…',
  'console.system.reconnected': '{prefix} Console reconnected',
  'console.system.disconnected': 'Console connection lost',

  // 连接状态
  'console.status.connected': 'Live log connected',
  'console.status.connecting': 'Connecting to console…',
  'console.status.offline': 'Instance not running',

  // 工具按钮与复制
  'console.tool.clear': 'Clear Screen',
  'console.tool.copyTitle': 'Copy All Output',
  'console.tool.copy': 'Copy Log',
  'console.copy.empty': 'There\'s no log to copy yet.',
  'console.copy.done': 'Log copied.',
  'console.copy.failed': 'Couldn\'t copy. The browser clipboard is unavailable or permission was denied. Select the log and copy it manually.',
  'console.tool.screenReader': 'Screen Reader Mode',
  'console.tool.screenReaderTitle': 'Let screen readers browse the log line by line and read new output aloud',

  // 终端输出区（读屏）
  'console.output.label': 'Console Output',
  'console.output.tooMuchOutput': 'Too much output to read aloud. Browse the log lines to read the rest.',

  // 命令输入
  'console.input.label': 'Console Command',
  'console.input.placeholder': 'Enter a console command (such as list, say Hello, or op <player>) and press Enter to send',
  'console.input.placeholderConnecting': 'Connecting…',
  'console.input.placeholderStopped': 'The instance is stopped. Start it to send commands.',

  // 常用命令
  'console.quick.label': 'Common Commands',
  'console.quick.sendTitle': 'Send /{command} to the server',
  'console.quick.list': 'Player List',
  'console.quick.saveAll': 'Save World',
  'console.quick.tps': 'Tick Rate',
  'console.quick.whitelist': 'Whitelist',
  'console.quick.help': 'Command Help',
} satisfies Record<string, string>;
