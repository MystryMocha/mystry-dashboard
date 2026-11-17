import type { IMPORTS_MESSAGES } from '@mystry/shared';

/** 服务端消息（imports）的简体中文翻译；英文模板在 packages/shared/src/messages/imports.ts。 */
export default {
  'server.imports.existing.invalidParams': '已有服务端导入参数包含不支持的字段或格式不正确',
  'server.imports.nameRequired': '实例名称不能为空',
  'server.imports.zip.singleFileOnly': 'ZIP 预览只接受一个安装包文件',
  'server.imports.zip.oneArchiveOnly': '只能上传一个 ZIP 安装包',
  'server.imports.zip.tooLarge': '上传文件超过大小限制',
  'server.imports.zip.missing': '请上传 ZIP 安装包',
  'server.imports.zip.invalidConfirmParams': 'ZIP 导入确认参数包含不支持的字段或格式不正确',

  'server.imports.progress.writingInstance': '写入实例目录…',
  'server.imports.progress.registering': '注册实例…',

  'server.imports.zip.task.queued': '正在导入安装包…',
  'server.imports.zip.progress.extracting': '正在解压安装包…',
  'server.imports.zip.progress.validating': '校验实例文件…',
  'server.imports.zip.progress.done': '导入完成',
  'server.imports.zip.duplicateRootPath': 'ZIP 根目录存在重复路径：{name}',
  'server.imports.zip.noLaunchTarget': '安装包中未找到可用的服务端 jar 或 Forge/NeoForge 启动参数文件',

  'server.imports.preview.notFound': 'ZIP 导入预览不存在',
  'server.imports.preview.expired': 'ZIP 导入预览已过期，请重新上传',
  'server.imports.preview.replaceWhileConfirming': '当前 ZIP 导入预览正在确认，请稍后再替换',
  'server.imports.preview.capacity': 'ZIP 导入预览容量已满，请稍后重试',
  'server.imports.preview.cancelWhileConfirming': 'ZIP 导入预览正在确认，不能重复取消',
  'server.imports.preview.alreadyConfirmed': 'ZIP 导入预览已经确认，请勿重复提交',
  'server.imports.preview.confirming': 'ZIP 导入预览正在确认，请勿重复提交',

  'server.imports.existing.invalidSourceId': '导入文件夹名称无效',
  'server.imports.existing.outsideImportDir': '导入文件夹必须位于面板数据目录的 imports 文件夹下',
  'server.imports.existing.managedMarker': '该文件夹包含面板实例标记，不能作为导入来源',
  'server.imports.existing.precheckIncomplete': '快速预检未找到启动文件；提交后将在导入任务中做完整校验',
  'server.imports.existing.noLaunchTarget': '未找到服务端 jar 或 Forge/NeoForge 启动参数文件',

  'server.imports.existing.task.queued': '等待复制已有服务端…',
  'server.imports.existing.progress.validating': '正在校验已有服务端目录…',
  'server.imports.existing.progress.copyStart': '开始复制已有服务端…',
  'server.imports.existing.progress.copying': '正在复制已有服务端… {copied}/{total} 项',
  'server.imports.existing.progress.confirmingLaunch': '正在确认启动文件…',
  'server.imports.existing.progress.done': '已有服务端已复制到面板托管目录',
  'server.imports.existing.tooManyEntries': '已有服务端文件条目超过上限 {limit}',
  'server.imports.existing.tooLarge': '已有服务端总大小超过上限 {limit} 字节',
  'server.imports.existing.markerRefused': '导入文件夹包含面板实例标记，拒绝复制',
  'server.imports.existing.symlink': '导入文件夹不能包含符号链接或目录联接：{path}',
  'server.imports.existing.specialFile': '导入文件夹包含不支持的特殊文件：{path}',
  'server.imports.existing.diskSpace': '面板数据目录剩余空间不足，无法复制已有服务端',
  'server.imports.existing.missingLaunchTarget': '导入文件夹中未找到可用的服务端 jar 或 Forge/NeoForge 启动参数文件',
  'server.imports.existing.copiedNoLaunchTarget': '复制完成后未找到可用的服务端启动文件',

  'server.imports.launchScan.timeout': 'Forge/NeoForge 启动文件扫描超时',
  'server.imports.launchScan.tooManyEntries': 'Forge/NeoForge 启动文件扫描条目过多',
  'server.imports.launchScan.tooDeep': 'Forge/NeoForge 启动文件扫描层级过深',
  'server.imports.launchScan.symlink': '启动文件目录不能包含符号链接或目录联接',

  'server.imports.staging.lost': '部署临时文件已丢失，无法完成实例创建，请重新部署',
  'server.imports.staging.instanceDirExists': '实例目录已存在，拒绝覆盖已有数据',

  'server.imports.jvmFile.readFailed': '无法读取 user_jvm_args.txt：{reason}',
  'server.imports.jvmFile.notRegular': 'user_jvm_args.txt 必须是普通文件，不能是链接或特殊文件',
  'server.imports.jvmFile.tooLarge': 'user_jvm_args.txt 超过 64 KiB，不能自动沿用',
} satisfies Record<keyof typeof IMPORTS_MESSAGES, string>;
