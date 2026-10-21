Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

# Windows 源码管理入口：检查 Node.js、按需安装依赖并构建，生命周期交给 mystryctl。
# 与 PanelManager.sh 的区别：配置默认沿用仓库根目录的 .env，构建结果按源码指纹缓存。

function Normalize-ProcessPath {
  # 部分 Windows 环境同时存在 Path 和 PATH，子进程可能拿到其中不完整的一份；合并为一份。
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

$script:ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
# 已设置 MYSTRY_CONFIG_PATH 时沿用（相对路径按仓库根目录解析），与 mystryctl 一致。
$script:EnvPath = if ([IO.Path]::IsPathRooted([string]$env:MYSTRY_CONFIG_PATH)) {
  [IO.Path]::GetFullPath($env:MYSTRY_CONFIG_PATH)
} elseif ($env:MYSTRY_CONFIG_PATH) {
  [IO.Path]::GetFullPath((Join-Path $script:ProjectRoot $env:MYSTRY_CONFIG_PATH))
} else {
  Join-Path $script:ProjectRoot '.env'
}
$script:EnvExamplePath = Join-Path $script:ProjectRoot '.env.example'
$script:Controller = Join-Path $script:ProjectRoot 'scripts\portable\mystryctl.mjs'
$script:ServerEntry = Join-Path $script:ProjectRoot 'apps\server\dist\index.js'
# 与 mystryctl 的日志目录一致。
$script:StdoutLog = Join-Path $script:ProjectRoot 'logs\panel.stdout.log'
$script:StderrLog = Join-Path $script:ProjectRoot 'logs\panel.stderr.log'
# 放在 node_modules 里：npm ci 重装依赖时会一并清掉，下次必然重新构建。
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
    throw '未找到 Node.js。请先安装 Node.js 22 或更高版本：https://nodejs.org/'
  }
  $versionText = ([string](& node.exe --version)).Trim()
  if ($LASTEXITCODE -ne 0) { throw '无法读取 Node.js 版本。' }
  if (([version]$versionText.TrimStart('v')).Major -lt 22) {
    throw "Node.js 版本过低：$versionText。本项目要求 22 或更高版本。"
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

function Update-Project {
  param([switch]$Force)
  if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw '未找到 npm.cmd，请修复 Node.js 安装。'
  }
  $state = Read-JsonMap $script:BuildStatePath
  $lockPath = Join-Path $script:ProjectRoot 'package-lock.json'
  $dependencyHash = (Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $dependencyChanged = -not $state.ContainsKey('dependencyHash') -or [string]$state.dependencyHash -ne $dependencyHash
  if ($Force -or $dependencyChanged -or -not (Test-Path -LiteralPath (Join-Path $script:ProjectRoot 'node_modules'))) {
    Write-Host '正在根据 package-lock.json 安装依赖，可能需要几分钟…'
    Invoke-Npm -Arguments @('ci') -FailureMessage '依赖安装失败，请检查上方 npm 输出和网络连接。'
    $state = @{ dependencyHash = $dependencyHash }
  }

  $sourceHash = Get-SourceFingerprint
  $sourceChanged = -not $state.ContainsKey('sourceHash') -or [string]$state.sourceHash -ne $sourceHash
  if ($Force -or $sourceChanged -or -not (Test-BuildOutput)) {
    Write-Host '正在构建 shared、server 和 web…'
    Invoke-Npm -Arguments @('run', 'build') -FailureMessage '构建失败，不会启动旧的构建产物。'
    $state['sourceHash'] = $sourceHash
  } else {
    Write-Host '源码没有变化，跳过构建。'
  }
  Write-JsonMap -Path $script:BuildStatePath -Value $state
}

function Prepare-Project {
  param([switch]$Force)
  # 只在安装和构建期间互斥；生命周期由 mystryctl 自己的运行锁保护。
  $mutexName = 'Local\MystryPanelManager_' + (Get-StringHash $script:ProjectRoot).Substring(0, 16)
  $mutex = New-Object Threading.Mutex($false, $mutexName)
  $acquired = $false
  try {
    $acquired = $mutex.WaitOne(0)
    if (-not $acquired) { throw '另一个 PanelManager 正在安装或构建，请稍后再试。' }
    if (-not (Test-Path -LiteralPath $script:EnvPath)) {
      [IO.Directory]::CreateDirectory((Split-Path -Parent $script:EnvPath)) | Out-Null
      Copy-Item -LiteralPath $script:EnvExamplePath -Destination $script:EnvPath
      Write-Host "已从 .env.example 创建配置：$($script:EnvPath)"
    }
    Update-Project -Force:$Force
  } finally {
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}

function Invoke-Controller {
  param([Parameter(Mandatory = $true)][string]$Command)
  $env:MYSTRY_HOME = $script:ProjectRoot
  $env:MYSTRY_CONFIG_PATH = $script:EnvPath
  & node.exe --no-warnings --experimental-sqlite $script:Controller $Command
  $script:ControllerExitCode = $LASTEXITCODE
}

function Test-PanelRunning {
  # 只是探测，不覆盖上一条命令的退出码。
  $previous = $script:ControllerExitCode
  Invoke-Controller '__is-running'
  $running = $script:ControllerExitCode -eq 0
  $script:ControllerExitCode = $previous
  return $running
}

function Open-LiveLogs {
  if (-not (Test-Path -LiteralPath $script:StdoutLog) -and -not (Test-Path -LiteralPath $script:StderrLog)) {
    Write-Host '暂无日志。'
    return
  }
  Write-Host '已在新窗口打开实时日志。'
  $quotedScript = '"' + $PSCommandPath.Replace('"', '\"') + '"'
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $quotedScript, '__tail')
  Start-Process powershell.exe -ArgumentList $arguments | Out-Null
}

function Invoke-TailLogs {
  Write-Host '实时日志：按 Ctrl+C 或关闭窗口即可退出，不会停止面板。'
  if (Test-Path -LiteralPath $script:StderrLog) {
    Write-Host '--- 最近的错误输出 ---'
    Get-Content -LiteralPath $script:StderrLog -Tail 40
  }
  if (Test-Path -LiteralPath $script:StdoutLog) {
    Write-Host '--- 最近的标准输出 ---'
    Get-Content -LiteralPath $script:StdoutLog -Tail 100 -Wait
  } elseif (Test-Path -LiteralPath $script:StderrLog) {
    Get-Content -LiteralPath $script:StderrLog -Tail 0 -Wait
  }
}

function Invoke-Command {
  param([Parameter(Mandatory = $true)][string]$Command)
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
    { $_ -in @('stop', 'status', 'logs', 'open') } {
      Invoke-Controller $Command
    }
    { $_ -in @('help', '-h', '--help') } {
      Invoke-Controller 'help'
    }
    default {
      throw "未知命令：$Command。可用命令：start、foreground、stop、restart、rebuild、status、logs、open、help。"
    }
  }
}

# 菜单项：[按键, 命令, 说明]。直接回车等同于 1；live-logs 是菜单专用的「新窗口看实时日志」。
$script:RunningMenu = @(
  @('1', 'open', '打开管理页面（直接回车）'),
  @('2', 'live-logs', '查看实时日志'),
  @('3', 'restart', '重启面板'),
  @('4', 'stop', '安全停止面板'),
  @('5', 'rebuild', '重新安装依赖、构建并重启')
)
$script:StoppedMenu = @(
  @('1', 'start', '后台启动面板（直接回车）'),
  @('2', 'foreground', '前台启动并查看日志'),
  @('3', 'rebuild', '重新安装依赖、构建并启动'),
  @('4', 'logs', '查看最近日志')
)

# 只返回选中的命令，不在这里执行：函数返回值会吞掉其中 node 的输出。
function Read-MenuChoice {
  while ($true) {
    Clear-Host
    Write-Host 'Mystry Dashboard 源码版'
    $running = Test-PanelRunning
    Write-Host $(if ($running) { '状态：运行中' } else { '状态：未运行' })
    Write-Host ''
    $menu = if ($running) { $script:RunningMenu } else { $script:StoppedMenu }
    foreach ($item in $menu) { Write-Host "[$($item[0])] $($item[2])" }
    Write-Host '[0] 退出'
    Write-Host ''
    $selection = (Read-Host '请选择').Trim()
    if ($selection -eq '') { $selection = '1' }
    if ($selection -eq '0') { return '' }
    $item = $menu | Where-Object { $_[0] -eq $selection } | Select-Object -First 1
    if ($null -eq $item) {
      Write-Host '无法识别该选项。' -ForegroundColor Yellow
      Start-Sleep -Seconds 1
      continue
    }
    return $item[1]
  }
}

if ($env:MYSTRY_PANEL_MANAGER_LIBRARY_ONLY -eq '1') {
  return
}

if ($args.Count -gt 1) {
  Write-Host '每次只能指定一个命令；可用命令：start、foreground、stop、restart、rebuild、status、logs、open、help。' -ForegroundColor Red
  exit 2
}
$command = if ($args.Count -eq 1) { ([string]$args[0]).ToLowerInvariant() } else { '' }
if ($command -eq '__tail') {
  Invoke-TailLogs
  exit 0
}

try {
  Assert-Node
  if ($command) {
    Invoke-Command $command
    exit $script:ControllerExitCode
  }
  # 无参数通常是双击启动：执行完菜单命令（含出错）后先停住，让结果和令牌提示留在屏幕上。
  $choice = Read-MenuChoice
  if ($choice) {
    if ($choice -eq 'live-logs') { Open-LiveLogs } else { Invoke-Command $choice }
    Write-Host ''
    [void](Read-Host '按回车键关闭窗口')
  }
  exit $script:ControllerExitCode
} catch {
  if ($env:MYSTRY_PANEL_MANAGER_DEBUG -eq '1') { Write-Host $_.ScriptStackTrace }
  Write-Host ''
  Write-Host $_.Exception.Message -ForegroundColor Red
  if (-not $command) {
    Write-Host ''
    [void](Read-Host '按回车键关闭窗口')
  }
  exit 1
}
