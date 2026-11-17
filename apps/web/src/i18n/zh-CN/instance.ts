import type en from '../en/instance';

/** 实例工作台外壳与实例设置文案（简体中文）。 */
export default {
  // 工作台头部与标签页
  'instance.header.backTitle': '返回总览',
  'instance.tabs.label': '实例功能',

  // 面板托管的实例目录（用于迁移提示与设置页的安装路径占位）
  'instance.path.managed': '面板数据目录/instances/{id}',

  // 迁移到托管目录
  'instance.migration.title': '接管托管目录',
  'instance.migration.instructions': '请使用系统文件管理器，将旧实例文件复制到面板数据目录下的实例文件夹：',
  'instance.migration.note': '面板不会读取或删除旧目录。复制完成后点击「接管托管目录」，成功后将恢复实例操作。',
  'instance.migration.checking': '检查中…',
  'instance.migration.adopt': '接管托管目录',

  // 重启 / 强制停止确认
  'instance.restart.title': '重启实例「{name}」？',
  'instance.restart.description': '重启会中断当前游戏进程并断开所有在线玩家，未保存的世界数据可能丢失。',
  'instance.restart.confirm': '确认重启',
  'instance.forceStop.title': '强制停止实例「{name}」？',
  'instance.forceStop.description': '强制停止会立即强制结束进程，可能导致世界损坏。建议先尝试普通「停止」。',
  'instance.forceStop.confirm': '确认强制停止',

  // 实例设置
  'instance.settings.section.basic': '基本信息',
  'instance.settings.section.runtime': '运行环境',
  'instance.settings.section.eula': '许可协议',
  'instance.settings.name.label': '名称',
  'instance.settings.jarFile.label': 'Jar 文件名',
  'instance.settings.installPath.label': '安装路径',
  'instance.settings.installPath.help': '实例目录由面板托管，创建后不可修改。',
  'instance.settings.status.dirty': '有未保存的设置。',
  'instance.settings.status.saved': '设置已保存。',
  'instance.settings.status.idle': '修改后点「保存设置」生效。',
  'instance.settings.save': '保存设置',
  'instance.settings.unsaved.title': '放弃未保存的设置修改？',
  'instance.settings.unsaved.savingTitle': '正在保存设置…',
  'instance.settings.unsaved.description': '离开设置页会丢失尚未保存的实例设置。',

  // 启动失败原因提示（控制台上方）
  'instance.startIssue.eula.title': '同意 Minecraft EULA 后才能启动这个服务器',
  'instance.startIssue.eula.body': 'Minecraft 服务器必须先同意 <link>Minecraft EULA</link> 才能运行。点「同意并启动」表示你已阅读并同意该协议，面板会写入 eula.txt 并启动服务器。',
  'instance.startIssue.eula.action': '同意并启动',
  'instance.startIssue.java.title': '这个服务器需要 Java {java}',
  'instance.startIssue.java.titleUnknown': '这个服务器需要换一个 Java 版本',
  'instance.startIssue.javaTooNew.body': '启动时用的 Java 版本太新，服务器刚启动就退出了。请安装 Java {java}，然后打开「实例设置」，点「重新探测」，选择 Java {java}，保存后再启动。',
  'instance.startIssue.javaTooOld.body': '启动时用的 Java 版本太旧，服务器刚启动就退出了。请安装 Java {java}，然后打开「实例设置」，点「重新探测」，选择 Java {java}，保存后再启动。',
  'instance.startIssue.java.bodyUnknown': '启动时用的 Java 版本和这个服务器不匹配，服务器刚启动就退出了。请查看服务端或整合包要求的 Java 版本并安装，然后打开「实例设置」，点「重新探测」，选择它，保存后再启动。',
  'instance.startIssue.java.openSettings': '打开实例设置',

  // 启动成功后的下一步提示（控制台上方）
  'instance.ready.title': '服务器已启动，现在可以进服了。',
  'instance.ready.body': '想让朋友加入？「联机」页会给出要发给他们的地址。',
  'instance.ready.action': '邀请朋友',
  'instance.ready.dismiss': '不再提示',

  // 未保存修改弹窗（设置与参数配置共用）
  'instance.unsaved.savingDescription': '保存完成后会自动继续离开；保存期间无法放弃或取消。',
  'instance.unsaved.confirm': '放弃修改并离开',
} satisfies Record<keyof typeof en, string>;
