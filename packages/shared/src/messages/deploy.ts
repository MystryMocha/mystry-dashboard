/** User-facing server messages: core metadata, download and install. Values are English templates with `{name}` placeholders; the Web string tables translate other languages by key. */
export const DEPLOY_MESSAGES = {
  'server.deploy.unsupportedCore': "This core type isn't supported.",
  'server.deploy.invalidParams': 'The deploy request has unsupported fields or an invalid format.',
  'server.deploy.missingParams': 'Required parameters are missing.',
  'server.deploy.downloadTimeout': 'The core download timed out.',
  'server.deploy.metadataTimeout': 'The core metadata request timed out.',

  // Core download
  'server.deploy.downloadHttpFailed': 'The download failed (HTTP {status}): {url}',
  'server.deploy.downloadTooLarge': 'The core download exceeds the size limit.',

  // Core metadata
  'server.deploy.metadataTooLarge': 'The core metadata exceeds the size limit.',
  'server.deploy.metadataNoBody': 'The core metadata response has no body.',
  'server.deploy.metadataHttpFailed': 'The request failed (HTTP {status}): {url}',
  'server.deploy.neoforgeVersionInvalid': "Can't parse the NeoForge version: {version}",
  'server.deploy.vanillaVersionNotFound': "Vanilla version {version} wasn't found.",
  'server.deploy.vanillaNoServerJar': 'This version has no official server jar: {version}',
  'server.deploy.vanillaManifestNeedsMojang': "Deploying Vanilla reads the version manifest from Mojang even with the Mainland China mirror, because it supplies the checksums for mirrored files, and it couldn't be loaded. {attempts}Check that launchermeta.mojang.com can be reached, and then try again.",
  'server.deploy.vanillaMetadataUntrusted': "The version information for Vanilla {version} can't be verified: it points outside Mojang's servers or has no checksum.",
  'server.deploy.paperNoBuilds': 'Paper {version} has no available builds.',
  'server.deploy.paperBuildNotFound': 'Paper {version} has no build #{build}.',
  'server.deploy.paperNoDownloadUrl': 'Paper {version}#{build} has no download URL.',
  'server.deploy.fabricNoVersions': 'Fabric {version} has no available Loader or Installer version.',

  // Deploy flow
  'server.deploy.loaderNoVersions': '{coreType} {mcVersion} has no available versions.',
  'server.deploy.launchTargetNotFound': 'The installation finished, but no launchable server jar or launch arguments file was found.',

  // Installers (Forge / NeoForge)
  'server.deploy.installerExitCode': 'The installer exited with code {exitCode}.\n{output}',
  'server.deploy.installerExitUnknown': 'The installer exited with an unknown code.\n{output}',
  'server.deploy.installerDownloadFailed': "The installer couldn't download its dependencies ({detail}). {libraries}Check your network, proxy, or firewall, and then deploy again.",
  'server.deploy.installerFailedLibraries': 'Failed dependencies: {libraries}. ',
  'server.deploy.installerRetried': 'automatic retries: {count}, {detail}',
  'server.deploy.installerHostReason': '{reason} for {host}',
  'server.deploy.installerReason.connectFailed': 'connection failed',
  'server.deploy.installerReason.readTimeout': 'read timed out',
  'server.deploy.installerReason.dnsFailed': 'DNS lookup failed',
  'server.deploy.installerReason.tlsFailed': 'TLS connection failed',

  // Deploy task progress
  'server.deploy.progress.deploying': 'Deploying {coreType} {mcVersion}',
  'server.deploy.progress.resolvingLoader': 'Resolving the Forge/NeoForge version…',
  'server.deploy.progress.usingCachedInstaller': 'Using the cached installer…',
  'server.deploy.progress.downloadingInstaller': 'Downloading the installer…',
  'server.deploy.progress.downloadingInstallerPercent': 'Downloading the installer {percent}%',
  'server.deploy.progress.downloadingInstallerFrom': 'Downloading the installer from {source} {percent}%',
  'server.deploy.progress.prefetchingLibraries': 'Downloading installer dependencies through the mirror ({done}/{total})…',
  'server.deploy.progress.runningInstaller': 'Running --installServer…',
  'server.deploy.progress.detectingLaunch': 'Detecting the launch files…',
  'server.deploy.progress.writingInstance': 'Writing the instance folder…',
  'server.deploy.progress.resolvingUrl': 'Resolving the download URL…',
  'server.deploy.progress.usingCache': 'Using the local cache…',
  'server.deploy.progress.startingDownload': 'Starting the core download…',
  'server.deploy.progress.downloading': 'Downloading {percent}%',
  'server.deploy.progress.downloadingFrom': 'Downloading from {source} {percent}%',
  'server.deploy.progress.writingConfig': 'Writing the launch configuration…',
  'server.deploy.progress.completed': 'Deployment complete',
  'server.deploy.progress.installerDownloading': 'The installer is downloading {name}…',
  'server.deploy.progress.installerDownloadingUnknown': 'The installer is downloading a dependency…',
  'server.deploy.progress.installerDownloadsDone': 'Installer downloads finished: {count}…',
  'server.deploy.progress.installerNetworkIssue': 'The installer hit a network problem and is still working…',
  'server.deploy.progress.installerRetrying': 'The installer download was incomplete. Retrying automatically ({attempt}/{max})…',
} as const satisfies Record<string, string>;
