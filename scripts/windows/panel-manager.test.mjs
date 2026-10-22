import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const managerPath = path.join(scriptDirectory, 'panel-manager.ps1');

function quotePowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function cleanEnvironment() {
  const environment = { ...process.env };
  for (const name of ['JWT_SECRET', 'SETUP_TOKEN', 'LAUNCHER_TOKEN', 'DATA_DIR', 'MYSTRY_DATA_DIR', 'MYSTRY_CONFIG_PATH', 'PORT', 'HOST']) {
    delete environment[name];
  }
  // 下面按中文输出断言，不随系统语言变化。
  environment.MYSTRY_LANG = 'zh-CN';
  return environment;
}

function runPowerShell(command) {
  return spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { cwd: path.resolve(scriptDirectory, '../..'), env: cleanEnvironment(), encoding: 'utf8' },
  );
}

test('Invoke-Npm 不会把 npm 输出混入函数返回值', { skip: process.platform !== 'win32' }, () => {
  const result = runPowerShell(`
    $env:MYSTRY_PANEL_MANAGER_LIBRARY_ONLY = '1'
    . ${quotePowerShell(managerPath)}
    $captured = @(Invoke-Npm -Arguments @('--version') -FailureMessage 'npm 失败')
    if ($captured.Count -ne 0) { throw "Invoke-Npm 返回了 $($captured.Count) 个对象" }
  `);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('PanelManager 把 .env 交给 mystryctl，数据目录按其中的 DATA_DIR', { skip: process.platform !== 'win32' }, () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-panel-manager-test-'));
  try {
    const envPath = path.join(testRoot, '.env');
    const launcherDirectory = path.join(testRoot, 'data', 'launcher');
    fs.mkdirSync(launcherDirectory, { recursive: true });
    // 用一个必然不通的端口：状态里的 PID 仍存活但健康检查失败，mystryctl 会报出该 PID。
    fs.writeFileSync(envPath, `PORT=1\r\nDATA_DIR=${path.join(testRoot, 'data')}\r\n`, 'utf8');
    fs.writeFileSync(
      path.join(launcherDirectory, 'state.json'),
      JSON.stringify({ version: 1, pid: process.pid, fingerprint: 'test' }),
      'utf8',
    );

    const result = runPowerShell(`
      $env:MYSTRY_PANEL_MANAGER_LIBRARY_ONLY = '1'
      . ${quotePowerShell(managerPath)}
      $script:EnvPath = ${quotePowerShell(envPath)}
      Invoke-Controller 'status'
      if ($script:ControllerExitCode -ne 0) { throw "mystryctl 退出码 $script:ControllerExitCode" }
      if (Test-PanelRunning) { throw '不应判定为运行中' }
    `);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /状态：未运行/);
    assert.match(result.stdout + result.stderr, new RegExp(`PID ${process.pid} 仍存在`));
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

test('PanelManager 拒绝未知命令和多余参数', { skip: process.platform !== 'win32' }, () => {
  const unknown = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', managerPath, 'bogus'],
    { env: cleanEnvironment(), encoding: 'utf8' },
  );
  assert.equal(unknown.status, 1, `${unknown.stdout}\n${unknown.stderr}`);
  assert.match(unknown.stdout, /未知命令：bogus/);

  const extra = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', managerPath, 'status', 'extra'],
    { env: cleanEnvironment(), encoding: 'utf8' },
  );
  assert.equal(extra.status, 2, `${extra.stdout}\n${extra.stderr}`);
});

test('PanelManager.cmd 调用 Windows PowerShell 前清空 PSModulePath', () => {
  // 从 pwsh 7 里运行时会继承 7.x 的模块路径，5.1 加载到不兼容的模块后找不到 Get-FileHash。
  const launcher = fs.readFileSync(path.resolve(scriptDirectory, '../../PanelManager.cmd'), 'utf8');
  const clearIndex = launcher.indexOf('set "PSModulePath="');
  assert.ok(clearIndex >= 0, 'PanelManager.cmd 应清空 PSModulePath');
  assert.ok(clearIndex < launcher.indexOf('powershell.exe'), '应在调用 powershell.exe 之前清空');
  // chcp 65001 之后 cmd 按错位的字节继续读 LF 行尾的批处理，非 ASCII 字符会被当成命令执行。
  assert.match(launcher, /^[\x00-\x7f]*$/, 'PanelManager.cmd 只能包含 ASCII 字符');
});

test('PanelManager 按 MYSTRY_LANG 切换语言，并传给 mystryctl', { skip: process.platform !== 'win32' }, () => {
  const run = (language, ...args) => spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', managerPath, ...args],
    { env: { ...cleanEnvironment(), MYSTRY_LANG: language }, encoding: 'utf8' },
  );
  assert.match(run('en-US', 'bogus').stdout, /Unknown command: bogus/);
  assert.match(run('en-US', 'help').stdout, /Usage: PanelManager\.cmd/);
  assert.match(run('zh-CN', 'help').stdout, /用法：PanelManager\.cmd/);
});
