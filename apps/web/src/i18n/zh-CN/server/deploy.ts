import type { DEPLOY_MESSAGES } from '@mystry/shared';

/** 服务端消息（deploy）的简体中文翻译；英文模板在 packages/shared/src/messages/deploy.ts。 */
export default {
  'server.deploy.unsupportedCore': '不支持的核心类型',
  'server.deploy.invalidParams': '部署参数包含不支持的字段或格式不正确',
  'server.deploy.missingParams': '缺少必要参数',
  'server.deploy.downloadTimeout': '核心下载超时',
  'server.deploy.metadataTimeout': '核心元数据请求超时',

  // 核心下载
  'server.deploy.downloadHttpFailed': '下载失败（HTTP {status}）：{url}',
  'server.deploy.downloadTooLarge': '核心下载文件超过大小限制',

  // 核心元数据
  'server.deploy.metadataTooLarge': '核心元数据超过大小限制',
  'server.deploy.metadataNoBody': '核心元数据响应没有正文',
  'server.deploy.metadataHttpFailed': '请求失败（HTTP {status}）：{url}',
  'server.deploy.neoforgeVersionInvalid': '无法解析 NeoForge 版本：{version}',
  'server.deploy.vanillaVersionNotFound': '找不到 Vanilla 版本：{version}',
  'server.deploy.vanillaNoServerJar': '该版本没有官方服务端 jar：{version}',
  'server.deploy.paperNoBuilds': 'Paper {version} 没有可用构建',
  'server.deploy.paperBuildNotFound': 'Paper {version} 没有构建 #{build}',
  'server.deploy.paperNoDownloadUrl': 'Paper {version}#{build} 缺少下载地址',
  'server.deploy.fabricNoVersions': 'Fabric {version} 没有可用的 Loader 或 Installer 版本',

  // 部署流程
  'server.deploy.loaderNoVersions': '{coreType} {mcVersion} 没有可用版本',
  'server.deploy.launchTargetNotFound': '安装已完成，但未找到可启动的服务端 jar 或启动参数文件',

  // 安装器（Forge / NeoForge）
  'server.deploy.installerExitCode': '安装器退出码 {exitCode}\n{output}',
  'server.deploy.installerExitUnknown': '安装器退出码 未知\n{output}',
  'server.deploy.installerDownloadFailed': '安装器下载依赖失败（{detail}）。{libraries}请检查网络、代理或防火墙后重新部署。',
  'server.deploy.installerFailedLibraries': '失败依赖：{libraries}；',
  'server.deploy.installerRetried': '已自动重试 {count} 次，{detail}',
  'server.deploy.installerHostReason': '{host} {reason}',
  'server.deploy.installerReason.connectFailed': '连接失败',
  'server.deploy.installerReason.readTimeout': '读取超时',
  'server.deploy.installerReason.dnsFailed': '域名解析失败',
  'server.deploy.installerReason.tlsFailed': 'TLS 连接失败',

  // 部署任务进度
  'server.deploy.progress.deploying': '正在部署 {coreType} {mcVersion}',
  'server.deploy.progress.resolvingLoader': '解析 Forge/NeoForge 版本…',
  'server.deploy.progress.usingCachedInstaller': '使用本地缓存的安装器…',
  'server.deploy.progress.downloadingInstaller': '下载安装器…',
  'server.deploy.progress.downloadingInstallerPercent': '下载安装器 {percent}%',
  'server.deploy.progress.runningInstaller': '运行 --installServer…',
  'server.deploy.progress.detectingLaunch': '探测启动文件…',
  'server.deploy.progress.writingInstance': '写入实例目录…',
  'server.deploy.progress.resolvingUrl': '解析下载地址…',
  'server.deploy.progress.usingCache': '使用本地缓存…',
  'server.deploy.progress.startingDownload': '开始下载核心…',
  'server.deploy.progress.downloading': '下载中 {percent}%',
  'server.deploy.progress.writingConfig': '写入启动配置…',
  'server.deploy.progress.completed': '部署完成',
  'server.deploy.progress.installerDownloading': '安装器正在下载 {name}…',
  'server.deploy.progress.installerDownloadingUnknown': '安装器正在下载依赖文件…',
  'server.deploy.progress.installerDownloadsDone': '安装器已完成 {count} 个下载…',
  'server.deploy.progress.installerNetworkIssue': '安装器下载遇到网络问题，正在继续处理…',
  'server.deploy.progress.installerRetrying': '安装器下载不完整，正在自动重试（{attempt}/{max}）…',
} satisfies Record<keyof typeof DEPLOY_MESSAGES, string>;
