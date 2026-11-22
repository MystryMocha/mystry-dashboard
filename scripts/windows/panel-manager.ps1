Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

# Windows source management entry: checks Node.js, installs dependencies and builds as needed, and hands the lifecycle to the controller (scripts/portable/mdash.mjs).
# Differences from mdash.sh: config defaults to the .env in the repo root, and the build result is cached by source fingerprint.
# mdash.cmd clears PSModulePath before calling this script: when run from pwsh 7 the 7.x module path is inherited,
# and after 5.1 loads incompatible modules Get-FileHash cannot be found. Only ASCII can be written in the .cmd, so the explanation lives here.

function Normalize-ProcessPath {
  # Some Windows environments have both Path and PATH, and a child process may get the incomplete one of the two; merge them into one.
  $variables = [Environment]::GetEnvironmentVariables('Process')
  $pathKeys = @($variables.Keys | Where-Object {
    ([string]$_).Equals('path', [StringComparison]::OrdinalIgnoreCase)
  })
  if ($pathKeys.Count -le 1) { return }

  $entries = New-Object Collections.Generic.List[string]
  foreach ($key in $pathKeys) {
    foreach ($entry in ([string]$variables[$key] -split ';')) {
      $trimmed = $entry.Trim()
      $alreadyExists = $entries | Where-Object {
        $_.Equals($trimmed, [StringComparison]::OrdinalIgnoreCase)
      }
      if ($trimmed -and -not $alreadyExists) {
        $entries.Add($trimmed)
      }
    }
    [Environment]::SetEnvironmentVariable([string]$key, $null, 'Process')
  }
  [Environment]::SetEnvironmentVariable('Path', ($entries -join ';'), 'Process')
}

Normalize-ProcessPath

# UI language: MYSTRY_LANG first, then the Windows display language; Chinese on a Chinese system, English for everything else.
# The result is written back to MYSTRY_LANG, so the controller and the live log window use the same language.
# CurrentUICulture alone is not the display language: when the console code page is UTF-8 (65001), which mdash.cmd switches to,
# Windows PowerShell reports en-US on a Chinese system. GetUserDefaultUILanguage does not depend on the console, so it is asked
# whenever CurrentUICulture is not Chinese; if that lookup fails (Add-Type can be blocked), the answer stays English as before.
function Test-ChineseDisplayLanguage {
  if ([Globalization.CultureInfo]::CurrentUICulture.Name -match '^zh') { return $true }
  try {
    # The type stays defined for the session, so a second dot-source of this script must not add it again.
    if (-not ('MystryDashboard.DisplayLanguage' -as [type])) {
      Add-Type -Namespace MystryDashboard -Name DisplayLanguage -MemberDefinition '[DllImport("kernel32.dll")] public static extern ushort GetUserDefaultUILanguage();'
    }
    $languageId = [int][MystryDashboard.DisplayLanguage]::GetUserDefaultUILanguage()
    return [Globalization.CultureInfo]::GetCultureInfo($languageId).Name -match '^zh'
  } catch {
    return $false
  }
}

$script:Chinese = if ($env:MYSTRY_LANG) {
  $env:MYSTRY_LANG -match '^zh'
} else {
  Test-ChineseDisplayLanguage
}
$env:MYSTRY_LANG = if ($script:Chinese) { 'zh-CN' } else { 'en-US' }

function T {
  param([string]$Zh, [string]$En)
  if ($script:Chinese) { return $Zh }
  return $En
}

$script:ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
# When MYSTRY_CONFIG_PATH is already set it is kept (a relative path is resolved against the repo root), same as the controller.
$script:EnvPath = if ([IO.Path]::IsPathRooted([string]$env:MYSTRY_CONFIG_PATH)) {
  [IO.Path]::GetFullPath($env:MYSTRY_CONFIG_PATH)
} elseif ($env:MYSTRY_CONFIG_PATH) {
  [IO.Path]::GetFullPath((Join-Path $script:ProjectRoot $env:MYSTRY_CONFIG_PATH))
} else {
  Join-Path $script:ProjectRoot '.env'
}
$script:EnvExamplePath = Join-Path $script:ProjectRoot '.env.example'
$script:Controller = Join-Path $script:ProjectRoot 'scripts\portable\mdash.mjs'
$script:NpmMirrorScript = Join-Path $script:ProjectRoot 'scripts\npm-mirror.mjs'
$script:ServerEntry = Join-Path $script:ProjectRoot 'apps\server\dist\index.js'
# Same as the controller's log directory.
$script:StdoutLog = Join-Path $script:ProjectRoot 'logs\panel.stdout.log'
$script:StderrLog = Join-Path $script:ProjectRoot 'logs\panel.stderr.log'
# Kept inside node_modules: when npm ci reinstalls dependencies it is wiped along with them, so the next run is certain to rebuild.
$script:BuildStatePath = Join-Path $script:ProjectRoot 'node_modules\.cache\mystry-panel-manager.json'
$script:ControllerExitCode = 0

function Read-JsonMap {
  param([Parameter(Mandatory = $true)][string]$Path)
  $map = @{}
  if (-not (Test-Path -LiteralPath $Path)) { return $map }
  try {
    $value = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($property in $value.PSObject.Properties) {
      $map[$property.Name] = $property.Value
    }
  } catch {
    return @{}
  }
  return $map
}

function Write-JsonMap {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][hashtable]$Value
  )
  [IO.Directory]::CreateDirectory((Split-Path -Parent $Path)) | Out-Null
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 5), $encoding)
}

function Get-StringHash {
  param([Parameter(Mandatory = $true)][string]$Value)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    return ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
  }
}

function Get-SourceFingerprint {
  $files = New-Object Collections.Generic.List[IO.FileInfo]
  foreach ($relative in @('package.json', 'package-lock.json')) {
    $path = Join-Path $script:ProjectRoot $relative
    if (Test-Path -LiteralPath $path) { $files.Add((Get-Item -LiteralPath $path)) }
  }
  foreach ($pattern in @('apps\*\package.json', 'apps\*\tsconfig*.json', 'packages\*\package.json', 'packages\*\tsconfig*.json')) {
    foreach ($file in Get-ChildItem -Path (Join-Path $script:ProjectRoot $pattern) -File -ErrorAction SilentlyContinue) {
      $files.Add($file)
    }
  }
  foreach ($relative in @('apps\server\src', 'apps\web\src', 'packages\shared\src')) {
    $path = Join-Path $script:ProjectRoot $relative
    if (Test-Path -LiteralPath $path) {
      foreach ($file in Get-ChildItem -LiteralPath $path -File -Recurse) { $files.Add($file) }
    }
  }
  foreach ($relative in @('apps\web\index.html', 'apps\web\vite.config.ts')) {
    $path = Join-Path $script:ProjectRoot $relative
    if (Test-Path -LiteralPath $path) { $files.Add((Get-Item -LiteralPath $path)) }
  }
  $parts = foreach ($file in $files | Sort-Object FullName -Unique) {
    $relativePath = $file.FullName.Substring($script:ProjectRoot.Length).TrimStart('\', '/')
    "$relativePath|$((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash)"
  }
  return Get-StringHash ($parts -join "`n")
}

function Assert-Node {
  if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    throw (T '未找到 Node.js。请先安装 Node.js 22 或更高版本：https://nodejs.org/' 'Node.js was not found. Install Node.js 22 or later: https://nodejs.org/')
  }
  $versionText = ([string](& node.exe --version)).Trim()
  if ($LASTEXITCODE -ne 0) { throw (T '无法读取 Node.js 版本。' 'Could not read the Node.js version.') }
  if (([version]$versionText.TrimStart('v')).Major -lt 22) {
    throw (T "Node.js 版本过低：$versionText。本项目要求 22 或更高版本。" "Node.js $versionText is too old. This project needs 22 or later.")
  }
}

function Test-BuildOutput {
  return (Test-Path -LiteralPath (Join-Path $script:ProjectRoot 'packages\shared\dist\index.js')) `
    -and (Test-Path -LiteralPath $script:ServerEntry) `
    -and (Test-Path -LiteralPath (Join-Path $script:ProjectRoot 'apps\web\dist\index.html'))
}

function Invoke-Npm {
  param(
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$FailureMessage
  )
  Push-Location $script:ProjectRoot
  try {
    & npm.cmd @Arguments | Out-Host
    if ($LASTEXITCODE -ne 0) { throw $FailureMessage }
  } finally {
    Pop-Location
  }
}

function Get-NpmInstallArguments {
  # When following npm's own config the script outputs no URL, so no --registry is added here either.
  $registry = ([string](& node.exe $script:NpmMirrorScript 'registry')).Trim()
  if ($LASTEXITCODE -ne 0) { throw (T 'npm 下载源设置无效，请查看上方提示。' 'The npm download source setting is not valid. See the message above.') }
  if (-not $registry) { return @('ci') }
  Write-Host (T "npm 下载源：$registry" "npm download source: $registry")
  return @('ci', "--registry=$registry")
}

function Update-Project {
  param([switch]$Force)
  if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw (T '未找到 npm.cmd，请修复 Node.js 安装。' 'npm.cmd was not found. Repair your Node.js installation.')
  }
  $state = Read-JsonMap $script:BuildStatePath
  $lockPath = Join-Path $script:ProjectRoot 'package-lock.json'
  $dependencyHash = (Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $dependencyChanged = -not $state.ContainsKey('dependencyHash') -or [string]$state.dependencyHash -ne $dependencyHash
  if ($Force -or $dependencyChanged -or -not (Test-Path -LiteralPath (Join-Path $script:ProjectRoot 'node_modules'))) {
    Write-Host (T '正在根据 package-lock.json 安装依赖，可能需要几分钟…' 'Installing dependencies from package-lock.json. This may take a few minutes…')
    Invoke-Npm -Arguments (Get-NpmInstallArguments) -FailureMessage (T '依赖安装失败，请检查上方 npm 输出和网络连接。下载慢或失败时，可以运行 .\mdash.cmd mirror 换一个 npm 下载源。' 'Installing dependencies failed. Check the npm output above and your network connection. If downloads are slow or failing, run .\mdash.cmd mirror to choose another npm download source.')
    $state = @{ dependencyHash = $dependencyHash }
  }

  $sourceHash = Get-SourceFingerprint
  $sourceChanged = -not $state.ContainsKey('sourceHash') -or [string]$state.sourceHash -ne $sourceHash
  if ($Force -or $sourceChanged -or -not (Test-BuildOutput)) {
    Write-Host (T '正在构建 shared、server 和 web…' 'Building shared, server and web…')
    Invoke-Npm -Arguments @('run', 'build') -FailureMessage (T '构建失败，不会启动旧的构建产物。' 'The build failed. The old build will not be started.')
    $state['sourceHash'] = $sourceHash
  } else {
    Write-Host (T '源码没有变化，跳过构建。' 'Sources have not changed; skipping the build.')
  }
  Write-JsonMap -Path $script:BuildStatePath -Value $state
}

function Prepare-Project {
  param([switch]$Force)
  # Mutual exclusion only during install and build; the lifecycle is protected by the controller's own run lock.
  # The mutex keeps its name from before the launcher became mdash.cmd, so an older checkout's launcher still excludes this one.
  $mutexName = 'Local\MystryPanelManager_' + (Get-StringHash $script:ProjectRoot).Substring(0, 16)
  $mutex = New-Object Threading.Mutex($false, $mutexName)
  $acquired = $false
  try {
    $acquired = $mutex.WaitOne(0)
    if (-not $acquired) { throw (T '另一个 mdash.cmd 正在安装或构建，请稍后再试。' 'Another mdash.cmd is installing or building. Try again later.') }
    if (-not (Test-Path -LiteralPath $script:EnvPath)) {
      [IO.Directory]::CreateDirectory((Split-Path -Parent $script:EnvPath)) | Out-Null
      Copy-Item -LiteralPath $script:EnvExamplePath -Destination $script:EnvPath
      Write-Host (T "已从 .env.example 创建配置：$($script:EnvPath)" "Created configuration from .env.example: $($script:EnvPath)")
    }
    Update-Project -Force:$Force
  } finally {
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}

function Invoke-Controller {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    # Only remote takes a subcommand and arguments, which are passed to the controller as is.
    [string[]]$Extra = @()
  )
  $env:MYSTRY_HOME = $script:ProjectRoot
  $env:MYSTRY_CONFIG_PATH = $script:EnvPath
  & node.exe --no-warnings --experimental-sqlite $script:Controller $Command @Extra
  $script:ControllerExitCode = $LASTEXITCODE
}

function Test-PanelRunning {
  # Only a probe, so it does not overwrite the previous command's exit code.
  $previous = $script:ControllerExitCode
  Invoke-Controller '__is-running'
  $running = $script:ControllerExitCode -eq 0
  $script:ControllerExitCode = $previous
  return $running
}

function Open-LiveLogs {
  if (-not (Test-Path -LiteralPath $script:StdoutLog) -and -not (Test-Path -LiteralPath $script:StderrLog)) {
    Write-Host (T '暂无日志。' 'No logs yet.')
    return
  }
  Write-Host (T '已在新窗口打开实时日志。' 'Opened live logs in a new window.')
  $quotedScript = '"' + $PSCommandPath.Replace('"', '\"') + '"'
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $quotedScript, '__tail')
  Start-Process powershell.exe -ArgumentList $arguments | Out-Null
}

function Invoke-TailLogs {
  Write-Host (T '实时日志：按 Ctrl+C 或关闭窗口即可退出，不会停止面板。' 'Live logs: press Ctrl+C or close this window to exit. The panel keeps running.')
  if (Test-Path -LiteralPath $script:StderrLog) {
    Write-Host (T '--- 最近的错误输出 ---' '--- Recent stderr ---')
    Get-Content -LiteralPath $script:StderrLog -Tail 40
  }
  if (Test-Path -LiteralPath $script:StdoutLog) {
    Write-Host (T '--- 最近的标准输出 ---' '--- Recent stdout ---')
    Get-Content -LiteralPath $script:StdoutLog -Tail 100 -Wait
  } elseif (Test-Path -LiteralPath $script:StderrLog) {
    Get-Content -LiteralPath $script:StderrLog -Tail 0 -Wait
  }
}

function Invoke-NpmMirror {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  & node.exe $script:NpmMirrorScript @Arguments
  $script:ControllerExitCode = $LASTEXITCODE
}

function Select-NpmMirror {
  Invoke-NpmMirror -Arguments @('show')
  if ($script:ControllerExitCode -ne 0) { return }
  Write-Host ''
  $selection = (Read-Host (T '输入编号或名称（直接回车不修改）' 'Enter a number or name (press Enter to keep the current one)')).Trim()
  if ($selection) { Invoke-NpmMirror -Arguments @('set', $selection) }
}

function Invoke-Command {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [string]$Argument,
    [string[]]$Extra = @()
  )
  switch ($Command) {
    { $_ -in @('start', 'foreground', 'restart') } {
      Prepare-Project
      Invoke-Controller $Command
    }
    'rebuild' {
      Invoke-Controller 'stop'
      if ($script:ControllerExitCode -ne 0) { return }
      Prepare-Project -Force
      Invoke-Controller 'start'
    }
    { $_ -in @('stop', 'status', 'logs', 'open', 'reset-password') } {
      Invoke-Controller $Command
    }
    'remote' {
      # Toggle "access from other devices": the subcommand and arguments are passed to the controller as is.
      Invoke-Controller 'remote' $Extra
    }
    'mirror' {
      if ($Argument) {
        Invoke-NpmMirror -Arguments @('set', $Argument)
      } else {
        Invoke-NpmMirror -Arguments @('show')
      }
    }
    { $_ -in @('help', '-h', '--help') } {
      Invoke-Controller 'help'
    }
    default {
      throw (T "未知命令：$Command。可用命令：start、foreground、stop、restart、rebuild、status、logs、open、reset-password、remote、mirror、help。" "Unknown command: $Command. Available commands: start, foreground, stop, restart, rebuild, status, logs, open, reset-password, remote, mirror, help.")
    }
  }
}

# Menu items: [key, command, description]. A bare Enter equals 1; live-logs and npm-mirror are interactive operations only for the menu.
# reset-password carries the portable launcher's label word for word: the sign-in page sends people to it once the window with the first password is closed.
$script:RunningMenu = @(
  @('1', 'open', (T '打开管理页面（直接回车）' 'Open the dashboard (Enter)')),
  @('2', 'live-logs', (T '查看实时日志' 'View live logs')),
  @('3', 'restart', (T '重启面板' 'Restart the panel')),
  @('4', 'stop', (T '安全停止面板' 'Stop the panel safely')),
  @('5', 'rebuild', (T '重新安装依赖、构建并重启' 'Reinstall dependencies, build and restart')),
  @('6', 'npm-mirror', (T '选择 npm 下载源' 'Choose the npm download source')),
  @('7', 'reset-password', (T '重置管理员密码' 'Reset the administrator password'))
)
$script:StoppedMenu = @(
  @('1', 'start', (T '后台启动面板（直接回车）' 'Start the panel in the background (Enter)')),
  @('2', 'foreground', (T '前台启动并查看日志' 'Start in the foreground and view logs')),
  @('3', 'rebuild', (T '重新安装依赖、构建并启动' 'Reinstall dependencies, build and start')),
  @('4', 'logs', (T '查看最近日志' 'View recent logs')),
  @('5', 'npm-mirror', (T '选择 npm 下载源' 'Choose the npm download source'))
)

# Only the selected command is returned and it is not run here: a function's return value would swallow the output of node inside it.
function Read-MenuChoice {
  while ($true) {
    Clear-Host
    Write-Host (T 'Mystry Dashboard 源码版' 'Mystry Dashboard (Source)')
    $running = Test-PanelRunning
    Write-Host $(if ($running) { T '状态：运行中' 'Status: running' } else { T '状态：未运行' 'Status: stopped' })
    Write-Host ''
    $menu = if ($running) { $script:RunningMenu } else { $script:StoppedMenu }
    foreach ($item in $menu) { Write-Host "[$($item[0])] $($item[2])" }
    Write-Host (T '[0] 退出' '[0] Exit')
    Write-Host ''
    $selection = (Read-Host (T '请选择' 'Choose')).Trim()
    if ($selection -eq '') { $selection = '1' }
    if ($selection -eq '0') { return '' }
    $item = $menu | Where-Object { $_[0] -eq $selection } | Select-Object -First 1
    if ($null -eq $item) {
      Write-Host (T '无法识别该选项。' 'That option is not recognized.') -ForegroundColor Yellow
      Start-Sleep -Seconds 1
      continue
    }
    return $item[1]
  }
}

if ($env:MYSTRY_PANEL_MANAGER_LIBRARY_ONLY -eq '1') {
  return
}

$command = if ($args.Count -ge 1) { ([string]$args[0]).ToLowerInvariant() } else { '' }
# Only two commands take arguments: mirror <name or number>, remote <subcommand> [arguments] (such as remote on, remote https off).
$commandArgument = if ($args.Count -eq 2 -and $command -eq 'mirror') { [string]$args[1] } else { '' }
$commandExtra = @()
if ($command -eq 'remote' -and $args.Count -ge 2 -and $args.Count -le 3) {
  $commandExtra = @($args[1..($args.Count - 1)] | ForEach-Object { [string]$_ })
}
if ($args.Count -gt 1 -and -not $commandArgument -and $commandExtra.Count -eq 0) {
  Write-Host (T '每次只能指定一个命令；可用命令：start、foreground、stop、restart、rebuild、status、logs、open、reset-password、remote、mirror、help。' 'Specify one command at a time. Available commands: start, foreground, stop, restart, rebuild, status, logs, open, reset-password, remote, mirror, help.') -ForegroundColor Red
  exit 2
}
if ($command -eq '__tail') {
  Invoke-TailLogs
  exit 0
}

try {
  Assert-Node
  if ($command) {
    Invoke-Command $command $commandArgument $commandExtra
    exit $script:ControllerExitCode
  }
  # No arguments usually means started by double-click: after running the menu command (including on error) pause first, keeping the result and token hint on screen.
  $choice = Read-MenuChoice
  if ($choice) {
    switch ($choice) {
      'live-logs' { Open-LiveLogs }
      'npm-mirror' { Select-NpmMirror }
      default { Invoke-Command $choice }
    }
    Write-Host ''
    [void](Read-Host (T '按回车键关闭窗口' 'Press Enter to close this window'))
  }
  exit $script:ControllerExitCode
} catch {
  if ($env:MYSTRY_PANEL_MANAGER_DEBUG -eq '1') { Write-Host $_.ScriptStackTrace }
  Write-Host ''
  Write-Host $_.Exception.Message -ForegroundColor Red
  if (-not $command) {
    Write-Host ''
    [void](Read-Host (T '按回车键关闭窗口' 'Press Enter to close this window'))
  }
  exit 1
}
