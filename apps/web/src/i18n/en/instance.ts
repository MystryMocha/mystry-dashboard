/** 实例工作台外壳与实例设置文案（英文主表）。 */
export default {
  // 工作台头部与标签页
  'instance.header.backTitle': 'Back to Instances',
  'instance.tabs.label': 'Instance Sections',

  // 面板托管的实例目录（用于迁移提示与设置页的安装路径占位）
  'instance.path.managed': '<panel data directory>/instances/{id}',

  // 迁移到托管目录
  'instance.migration.title': 'Migrate Instance Files',
  'instance.migration.instructions': 'Use your system file manager to copy the old instance files into the instance folder under the panel data directory:',
  'instance.migration.note': 'The panel doesn\'t read or delete the old directory. After copying, select "Complete Migration" to use the instance again.',
  'instance.migration.checking': 'Checking…',
  'instance.migration.adopt': 'Complete Migration',

  // 重启 / 强制停止确认
  'instance.restart.title': 'Restart instance "{name}"?',
  'instance.restart.description': 'Restarting interrupts the game process and disconnects all online players. Unsaved world data may be lost.',
  'instance.restart.confirm': 'Restart',
  'instance.forceStop.title': 'Force stop instance "{name}"?',
  'instance.forceStop.description': 'Force stopping ends the process immediately and may corrupt the world. Try a normal "Stop" first.',
  'instance.forceStop.confirm': 'Force Stop',

  // 实例设置
  'instance.settings.section.basic': 'Basic Info',
  'instance.settings.section.runtime': 'Runtime',
  'instance.settings.section.eula': 'License Agreement',
  'instance.settings.name.label': 'Name',
  'instance.settings.jarFile.label': 'Jar File Name',
  'instance.settings.launchFile.label': 'Launch File',
  'instance.settings.launchFile.argsHelp': 'Forge and NeoForge start from this argument file. The panel found it when the server was deployed or imported, so it can\'t be changed here.',
  'instance.settings.launchFile.pendingValue': 'Not installed',
  'instance.settings.launchFile.pendingHelp': 'The mod loader hasn\'t finished installing, so there\'s no file to start yet. Redeploy the instance, or check the Task Center for why the installation failed.',
  'instance.settings.installPath.label': 'Install Path',
  'instance.settings.installPath.help': 'The panel manages the instance directory. It can\'t be changed after creation.',
  'instance.settings.status.saved': 'Settings saved.',
  'instance.settings.save': 'Save Settings',
  'instance.settings.unsaved.title': 'Discard unsaved changes to settings?',
  'instance.settings.unsaved.savingTitle': 'Saving settings…',
  'instance.settings.unsaved.description': 'If you leave Settings, your unsaved instance settings will be lost.',

  // 启动失败原因提示（控制台上方）
  'instance.startIssue.eula.title': 'Agree to the Minecraft EULA to start this server',
  'instance.startIssue.eula.body': 'A Minecraft server runs only after you accept the <link>Minecraft EULA</link>. Selecting "Agree and Start" means you have read and agree to it. The panel then writes eula.txt and starts the server.',
  'instance.startIssue.eula.action': 'Agree and Start',
  'instance.startIssue.java.title': 'This server needs Java {java}',
  'instance.startIssue.java.titleUnknown': 'This server needs a different Java version',
  'instance.startIssue.javaTooNew.body': 'The Java that started it is too new, so the server stopped right away. Install Java {java}. Then open Settings, select "Rescan", choose Java {java}, save, and start again.',
  'instance.startIssue.javaTooOld.body': 'The Java that started it is too old, so the server stopped right away. Install Java {java}. Then open Settings, select "Rescan", choose Java {java}, save, and start again.',
  'instance.startIssue.java.bodyUnknown': 'The Java that started it doesn\'t match this server, so it stopped right away. Check which Java version the server or modpack asks for and install it. Then open Settings, select "Rescan", choose that Java, save, and start again.',
  'instance.startIssue.java.openSettings': 'Open Settings',

  // 启动成功后的下一步提示（控制台上方）
  'instance.ready.title': 'The server is up. You can join now.',
  'instance.ready.body': 'Want players to join? Multiplayer shows the join address.',
  'instance.ready.action': 'Invite Players',
  'instance.ready.dismiss': 'Don\'t Show Again',

  // 保存栏（设置与参数配置共用）：有修改才出现
  'instance.saveBar.dirty_one': '{count} unsaved change',
  'instance.saveBar.dirty_other': '{count} unsaved changes',
  'instance.saveBar.discard': 'Discard Changes',
  'instance.saveBar.savedRestart': 'Saved. Restart the instance to apply.',
  'instance.saveBar.restart': 'Restart Instance',

  // 未保存修改弹窗（设置与参数配置共用）
  'instance.unsaved.savingDescription': 'You\'ll leave automatically once saving finishes. You can\'t discard or cancel while saving.',
  'instance.unsaved.confirm': 'Discard and Leave',
} satisfies Record<string, string>;
