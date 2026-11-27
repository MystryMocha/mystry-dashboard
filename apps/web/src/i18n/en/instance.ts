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
  'instance.forceStop.descriptionDetached': 'Force stopping ends the process immediately and may corrupt the world. The panel cannot send this process the "stop" command; an OP player in the game can run /stop to save the world first.',
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

  // Restart after a crash: the countdown in place of Start, and the line inside the console window
  'instance.autoRestart.countdown_one': 'Restarting in {count} Second',
  'instance.autoRestart.countdown_other': 'Restarting in {count} Seconds',
  'instance.autoRestart.now': 'Restarting',
  'instance.autoRestart.cancelTitle': 'Cancel the automatic restart',
  'instance.autoRestart.cancelLabel_one': 'Cancel the automatic restart, due in {count} second',
  'instance.autoRestart.cancelLabel_other': 'Cancel the automatic restart, due in {count} seconds',
  'instance.autoRestart.gaveUp': 'Restarted {max} times in a row, and the server crashed again within {minutes} minutes each time. Automatic restart has stopped.',
  'instance.autoRestart.failed': 'Automatic restart failed: {reason}',

  // Start failure reason notice (above the console)
  'instance.detached.title': 'Previous server process is still running (PID {pid})',
  'instance.detached.bodyUnix': 'The panel lost console control after a previous exit, so this page cannot stream logs or send commands. Stop or force stop it before starting, backing up, or deleting this instance.',
  'instance.detached.bodyWindows': 'The panel lost console control after a previous exit, so it can no longer send the "stop" command. Force stop it before starting, backing up, or deleting this instance.',
  'instance.detached.refresh': 'Refresh Status',
  'instance.detached.unverifiedTitle': 'The panel cannot confirm whether PID {pid} is still this server',
  'instance.detached.bodyUnverified': 'The panel lost console control of this server after a previous exit, and the system will not say which program PID {pid} is now. Check it in Task Manager or with ps. If it is this server, end it there and select "Refresh Status". If it is another program, select "Not This Server".',
  'instance.detached.dismiss': 'Not This Server',
  'instance.detached.dismissConfirm.title': 'Clear the record of PID {pid}?',
  'instance.detached.dismissConfirm.body': 'The panel will no longer treat PID {pid} as this instance\'s server, and starting, backing up and deleting become available again. If that server is in fact still running, starting the instance would run two servers on the same world.',
  'instance.detached.dismissConfirm.confirm': 'Clear Record',
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

  // Whitelist on with no one on it (above the console and on Multiplayer)
  'instance.whitelist.title': 'The whitelist is on, and no players are on it yet.',
  'instance.whitelist.body': 'Players who are not on the whitelist are turned away when they join.',
  'instance.whitelist.add': 'To let a player in, run <cmd>whitelist add PlayerName</cmd> in the <console>Console</console> while the server is running.',
  'instance.whitelist.off': 'Not using a whitelist? Turn off "Enable Whitelist" in <config>Properties</config>, then restart the server.',

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
