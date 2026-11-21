/** Console strings (English primary table). */
export default {
  // Prefix of notices the panel writes to the terminal; the coloring function recognizes the prefixes of all languages
  'console.prefix.panel': '[Panel]',
  'console.prefix.error': '[Error]',

  // Panel notices written to the terminal
  'console.system.reconnecting_one': '{prefix} {reason}. Reconnecting in {count} second…',
  'console.system.reconnecting_other': '{prefix} {reason}. Reconnecting in {count} seconds…',
  'console.system.reconnected': '{prefix} Console reconnected',
  'console.system.disconnected': 'Console connection lost',

  // Connection status
  'console.status.connected': 'Live log connected',
  'console.status.connecting': 'Connecting to console…',
  'console.status.offline': 'Instance not running',

  // Tool buttons and copy
  'console.tool.clear': 'Clear Screen',
  'console.tool.copyTitle': 'Copy All Output',
  'console.tool.copy': 'Copy Log',
  'console.copy.empty': 'There\'s no log to copy yet.',
  'console.copy.done': 'Log copied.',
  'console.copy.failed': 'Couldn\'t copy. The browser clipboard is unavailable or permission was denied. Select the log and copy it manually.',
  'console.tool.screenReader': 'Screen Reader Mode',
  'console.tool.screenReaderTitle': 'Let screen readers browse the log line by line and read new output aloud',

  // Terminal output area (screen reader)
  'console.output.label': 'Console Output',
  'console.output.tooMuchOutput': 'Too much output to read aloud. Browse the log lines to read the rest.',

  // Command input
  'console.input.label': 'Console Command',
  'console.input.placeholder': 'Enter a console command (such as list, say Hello, or op <player>) and press Enter to send',
  'console.input.placeholderConnecting': 'Connecting…',
  'console.input.placeholderStopped': 'The instance is stopped. Start it to send commands.',

  // Common commands
  'console.quick.label': 'Common Commands',
  'console.quick.sendTitle': 'Send /{command} to the server',
  'console.quick.list': 'Player List',
  'console.quick.saveAll': 'Save World',
  'console.quick.tps': 'Tick Rate',
  'console.quick.whitelist': 'Whitelist',
  'console.quick.help': 'Command Help',
} satisfies Record<string, string>;
