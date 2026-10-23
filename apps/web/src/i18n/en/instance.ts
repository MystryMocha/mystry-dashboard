/** 实例工作台外壳与实例设置文案（英文主表）。 */
export default {
  // 工作台头部与标签页
  'instance.header.backTitle': 'Back to Instances',
  'instance.header.version': 'Version {version}',
  'instance.tabs.label': 'Instance Sections',

  // 面板托管的实例目录（用于迁移提示与设置页的安装路径占位）
  'instance.path.managed': '<panel data directory>/instances/{id}',

  // 迁移到托管目录
  'instance.migration.title': 'Adopt Managed Directory',
  'instance.migration.instructions': 'Use your system file manager to copy the old instance files into the instance folder under the panel data directory:',
  'instance.migration.note': 'The panel doesn\'t read or delete the old directory. After copying, click "Adopt Managed Directory". Instance actions resume once it succeeds.',
  'instance.migration.checking': 'Checking…',
  'instance.migration.adopt': 'Adopt Managed Directory',

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
  'instance.settings.installPath.label': 'Install Path',
  'instance.settings.installPath.help': 'The panel manages the instance directory. It can\'t be changed after creation.',
  'instance.settings.status.dirty': 'You have unsaved settings.',
  'instance.settings.status.saved': 'Settings saved.',
  'instance.settings.status.idle': 'Changes take effect after you click "Save Settings".',
  'instance.settings.save': 'Save Settings',
  'instance.settings.unsaved.title': 'Discard unsaved changes to settings?',
  'instance.settings.unsaved.savingTitle': 'Saving settings…',
  'instance.settings.unsaved.description': 'If you leave Settings, your unsaved instance settings will be lost.',

  // 未保存修改弹窗（设置与参数配置共用）
  'instance.unsaved.savingDescription': 'You\'ll leave automatically once saving finishes. You can\'t discard or cancel while saving.',
  'instance.unsaved.confirm': 'Discard and Leave',
} satisfies Record<string, string>;
