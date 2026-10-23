/** 服务端返回给用户的消息：ZIP 导入、导入预检与本机文件夹导入。值为英文模板，`{name}` 为参数占位；其他语言由 Web 文案表按键翻译。 */
export const IMPORTS_MESSAGES = {
  'server.imports.existing.invalidParams': 'The existing server import request has unsupported fields or an invalid format.',
  'server.imports.nameRequired': "Instance name can't be empty.",
  'server.imports.zip.singleFileOnly': 'ZIP preview accepts only one archive file.',
  'server.imports.zip.oneArchiveOnly': 'You can upload only one ZIP archive.',
  'server.imports.zip.tooLarge': 'The uploaded file exceeds the size limit.',
  'server.imports.zip.missing': 'Upload a ZIP archive.',
  'server.imports.zip.invalidConfirmParams': 'The ZIP import confirmation has unsupported fields or an invalid format.',

  // 导入任务共用的进度
  'server.imports.progress.writingInstance': 'Writing the instance folder…',
  'server.imports.progress.registering': 'Registering the instance…',

  // ZIP 导入任务
  'server.imports.zip.task.queued': 'Importing the archive…',
  'server.imports.zip.progress.extracting': 'Extracting the archive…',
  'server.imports.zip.progress.validating': 'Checking instance files…',
  'server.imports.zip.progress.done': 'Import completed',
  'server.imports.zip.duplicateRootPath': 'The ZIP root has a duplicate path: {name}',
  'server.imports.zip.noLaunchTarget': "The archive doesn't contain a usable server jar or Forge/NeoForge launch arguments file.",

  // ZIP 导入预览
  'server.imports.preview.notFound': 'ZIP import preview not found.',
  'server.imports.preview.expired': 'The ZIP import preview has expired. Upload it again.',
  'server.imports.preview.replaceWhileConfirming': 'The current ZIP import preview is being confirmed. Try replacing it later.',
  'server.imports.preview.capacity': 'Too many ZIP import previews are open. Try again later.',
  'server.imports.preview.cancelWhileConfirming': "The ZIP import preview is being confirmed and can't be cancelled.",
  'server.imports.preview.alreadyConfirmed': "The ZIP import preview has already been confirmed. Don't submit it again.",
  'server.imports.preview.confirming': "The ZIP import preview is being confirmed. Don't submit it again.",

  // 已有服务端导入：来源校验与预检
  'server.imports.existing.invalidSourceId': 'The import folder name is invalid.',
  'server.imports.existing.outsideImportDir': 'The import folder must be inside the imports folder of the panel data directory.',
  'server.imports.existing.managedMarker': "This folder contains a panel instance marker and can't be used as an import source.",
  'server.imports.existing.precheckIncomplete': "The quick check didn't find a launch file. A full check runs in the import task after you submit.",
  'server.imports.existing.noLaunchTarget': 'No server jar or Forge/NeoForge launch arguments file was found.',

  // 已有服务端导入：复制任务
  'server.imports.existing.task.queued': 'Waiting to copy the existing server…',
  'server.imports.existing.progress.validating': 'Checking the existing server folder…',
  'server.imports.existing.progress.copyStart': 'Starting to copy the existing server…',
  'server.imports.existing.progress.copying': 'Copying the existing server… {copied}/{total} items',
  'server.imports.existing.progress.confirmingLaunch': 'Confirming the launch file…',
  'server.imports.existing.progress.done': 'The existing server was copied to the panel-managed folder.',
  'server.imports.existing.tooManyEntries': 'The existing server exceeds the limit of {limit} file entries.',
  'server.imports.existing.tooLarge': 'The existing server exceeds the total size limit of {limit} bytes.',
  'server.imports.existing.markerRefused': 'The import folder contains a panel instance marker, so copying was refused.',
  'server.imports.existing.symlink': "The import folder can't contain symbolic links or directory junctions: {path}",
  'server.imports.existing.specialFile': 'The import folder contains an unsupported special file: {path}',
  'server.imports.existing.diskSpace': "There isn't enough free space in the panel data directory to copy the existing server.",
  'server.imports.existing.missingLaunchTarget': "The import folder doesn't contain a usable server jar or Forge/NeoForge launch arguments file.",
  'server.imports.existing.copiedNoLaunchTarget': 'No usable server launch file was found after copying.',

  // Forge/NeoForge 启动文件扫描
  'server.imports.launchScan.timeout': 'Scanning for the Forge/NeoForge launch file timed out.',
  'server.imports.launchScan.tooManyEntries': 'Scanning for the Forge/NeoForge launch file found too many entries.',
  'server.imports.launchScan.tooDeep': 'Scanning for the Forge/NeoForge launch file went too many folders deep.',
  'server.imports.launchScan.symlink': "The launch file folder can't contain symbolic links or directory junctions.",

  // 部署/导入共用的 staging 目录
  'server.imports.staging.lost': "The temporary deployment files are missing, so the instance can't be created. Deploy it again.",
  'server.imports.staging.instanceDirExists': 'The instance folder already exists. Existing data was not overwritten.',

  // 实例根目录 user_jvm_args.txt 检测
  'server.imports.jvmFile.readFailed': "Couldn't read user_jvm_args.txt: {reason}",
  'server.imports.jvmFile.notRegular': 'user_jvm_args.txt must be a regular file, not a link or special file.',
  'server.imports.jvmFile.tooLarge': "user_jvm_args.txt is larger than 64 KiB and can't be reused automatically.",
} as const satisfies Record<string, string>;
