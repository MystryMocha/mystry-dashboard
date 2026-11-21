/** Instance workspace shell and instance settings strings (English primary table). */
export default {
  // Workspace header and tabs
  'instance.header.backTitle': 'Back to Instances',
  'instance.tabs.label': 'Instance Sections',

  // Panel-managed instance directory (for the migration notice and the install path placeholder on the settings page)
  'instance.path.managed': '<panel data directory>/instances/{id}',

  // Migrate to the managed directory
  'instance.migration.title': 'Migrate Instance Files',
  'instance.migration.instructions': 'Use your system file manager to copy the old instance files into the instance folder under the panel data directory:',
  'instance.migration.note': 'The panel doesn\'t read or delete the old directory. After copying, select "Complete Migration" to use the instance again.',
  'instance.migration.checking': 'Checking…',
  'instance.migration.adopt': 'Complete Migration',

  // Restart / force stop confirmation
  'instance.restart.title': 'Restart instance "{name}"?',
  'instance.restart.description': 'Restarting interrupts the game process and disconnects all online players. Unsaved world data may be lost.',
  'instance.restart.confirm': 'Restart',
  'instance.forceStop.title': 'Force stop instance "{name}"?',
  'instance.forceStop.description': 'Force stopping ends the process immediately and may corrupt the world. Try a normal "Stop" first.',
  'instance.forceStop.confirm': 'Force Stop',

  // Instance settings
  'instance.settings.section.basic': 'Basic Info',
  'instance.settings.section.runtime': 'Runtime',
  'instance.settings.section.eula': 'License Agreement',
  'instance.settings.section.danger': 'Danger Zone',
  'instance.settings.delete.desc': "Permanently deletes the instance folder and all its files. This can't be undone.",
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

  // Start failure reason notice (above the console)
  'instance.startIssue.eula.title': 'Agree to the Minecraft EULA to start this server',
  'instance.startIssue.eula.body': 'A Minecraft server runs only after you accept the <link>Minecraft EULA</link>. Selecting "Agree and Start" means you have read and agree to it. The panel then writes eula.txt and starts the server.',
  'instance.startIssue.eula.action': 'Agree and Start',
  'instance.startIssue.java.title': 'This server needs Java {java}',
  'instance.startIssue.java.titleUnknown': 'This server needs a different Java version',
  'instance.startIssue.javaTooNew.body': 'The Java that started it is too new, so the server stopped right away. Install Java {java}. Then open Settings, select "Rescan", choose Java {java}, save, and start again.',
  'instance.startIssue.javaTooOld.body': 'The Java that started it is too old, so the server stopped right away. Install Java {java}. Then open Settings, select "Rescan", choose Java {java}, save, and start again.',
  'instance.startIssue.java.bodyUnknown': 'The Java that started it doesn\'t match this server, so it stopped right away. Check which Java version the server or modpack asks for and install it. Then open Settings, select "Rescan", choose that Java, save, and start again.',
  'instance.startIssue.java.openSettings': 'Open Settings',
  'instance.startIssue.javaUnavailable.title': 'The Java chosen for this server is no longer available',
  'instance.startIssue.javaUnavailable.body': 'The server can\'t start with it. Open Settings, select "Rescan", choose a Java, save, and start again.',

  // Next-step hint after a successful start (above the console)
  'instance.ready.title': 'The server is up. You can join now.',
  'instance.ready.body': 'Want players to join? Multiplayer shows the join address.',
  'instance.ready.action': 'Invite Players',
  'instance.ready.dismiss': 'Don\'t Show Again',

  // Save bar (shared by settings and the config editor): appears only when there are changes
  'instance.saveBar.dirty_one': '{count} unsaved change',
  'instance.saveBar.dirty_other': '{count} unsaved changes',
  'instance.saveBar.discard': 'Discard Changes',
  'instance.saveBar.savedRestart': 'Saved. Restart the instance to apply.',
  'instance.saveBar.restart': 'Restart Instance',

  // Unsaved changes dialog (shared by settings and the config editor)
  'instance.unsaved.savingDescription': 'You\'ll leave automatically once saving finishes. You can\'t discard or cancel while saving.',
  'instance.unsaved.confirm': 'Discard and Leave',
} satisfies Record<string, string>;
