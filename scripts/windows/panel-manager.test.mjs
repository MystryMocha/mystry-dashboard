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
  // The assertions below are on the Chinese output, regardless of the system language.
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

test('Invoke-Npm does not mix npm output into the function return value', { skip: process.platform !== 'win32' }, () => {
  const result = runPowerShell(`
    $env:MYSTRY_PANEL_MANAGER_LIBRARY_ONLY = '1'
    . ${quotePowerShell(managerPath)}
    $captured = @(Invoke-Npm -Arguments @('--version') -FailureMessage 'npm 失败')
    if ($captured.Count -ne 0) { throw "Invoke-Npm 返回了 $($captured.Count) 个对象" }
  `);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('mdash.cmd hands .env to the controller, and the data directory follows DATA_DIR in it', { skip: process.platform !== 'win32' }, () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-panel-manager-test-'));
  try {
    const envPath = path.join(testRoot, '.env');
    const launcherDirectory = path.join(testRoot, 'data', 'launcher');
    fs.mkdirSync(launcherDirectory, { recursive: true });
    // A port that is certain to be unreachable is used: the PID in the state is still alive but the health check fails, and the controller reports that PID.
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
      if ($script:ControllerExitCode -ne 0) { throw "mdash 退出码 $script:ControllerExitCode" }
      if (Test-PanelRunning) { throw '不应判定为运行中' }
    `);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /状态：未运行/);
    assert.match(result.stdout + result.stderr, new RegExp(`PID ${process.pid} 仍存在`));
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

test('mdash.cmd rejects unknown commands and extra arguments', { skip: process.platform !== 'win32' }, () => {
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

test('mdash.cmd reset-password refuses and returns non-zero when output is not a terminal', { skip: process.platform !== 'win32' }, () => {
  // Output goes through a pipe: the controller must refuse before contacting the server, and the exit code is returned as is through PowerShell.
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-panel-manager-reset-'));
  try {
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', managerPath, 'reset-password'],
      {
        env: {
          ...cleanEnvironment(),
          MYSTRY_CONFIG_PATH: path.join(testRoot, '.env'),
          MYSTRY_DATA_DIR: path.join(testRoot, 'data'),
        },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout + result.stderr, /当前输出不是终端[\s\S]*没有重置密码/);
    assert.doesNotMatch(result.stdout + result.stderr, /^[ \t]*密码：/m);
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

test('mdash.cmd clears PSModulePath before calling Windows PowerShell', () => {
  // When run from pwsh 7 the 7.x module path is inherited, and after 5.1 loads incompatible modules Get-FileHash cannot be found.
  const launcher = fs.readFileSync(path.resolve(scriptDirectory, '../../mdash.cmd'), 'utf8');
  const clearIndex = launcher.indexOf('set "PSModulePath="');
  assert.ok(clearIndex >= 0, 'mdash.cmd 应清空 PSModulePath');
  assert.ok(clearIndex < launcher.indexOf('powershell.exe'), '应在调用 powershell.exe 之前清空');
  // After chcp 65001, cmd keeps reading an LF-ending batch file at misaligned bytes, and non-ASCII characters get executed as commands.
  assert.match(launcher, /^[\x00-\x7f]*$/, 'mdash.cmd 只能包含 ASCII 字符');
});

test('mdash.cmd switches language by MYSTRY_LANG and passes it to the controller', { skip: process.platform !== 'win32' }, () => {
  const run = (language, ...args) => spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', managerPath, ...args],
    { env: { ...cleanEnvironment(), MYSTRY_LANG: language }, encoding: 'utf8' },
  );
  assert.match(run('en-US', 'bogus').stdout, /Unknown command: bogus/);
  assert.match(run('en-US', 'help').stdout, /Usage: mdash\.cmd/);
  assert.match(run('zh-CN', 'help').stdout, /用法：mdash\.cmd/);
});

test('mdash.cmd installs dependencies from the chosen download source and specifies no registry by default', { skip: process.platform !== 'win32' }, () => {
  const installArguments = (mirror) => runPowerShell(`
    $env:MYSTRY_PANEL_MANAGER_LIBRARY_ONLY = '1'
    $env:MYSTRY_NPM_MIRROR = ${quotePowerShell(mirror)}
    . ${quotePowerShell(managerPath)}
    Write-Output ('args=' + ((Get-NpmInstallArguments) -join ' '))
  `);

  assert.match(installArguments('default').stdout, /^args=ci$/m);
  assert.match(installArguments('npmmirror').stdout, /^args=ci --registry=https:\/\/registry\.npmmirror\.com\/$/m);
  assert.match(installArguments('official').stdout, /^args=ci --registry=https:\/\/registry\.npmjs\.org\/$/m);

  const invalid = installArguments('nope');
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /未知的 npm 下载源/);
});

test('only mirror and remote can take arguments, and an invalid download source name is not written to the choice', { skip: process.platform !== 'win32' }, () => {
  const run = (...args) => spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', managerPath, ...args],
    { env: cleanEnvironment(), encoding: 'utf8' },
  );

  const list = run('mirror');
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /npmmirror/);

  const invalid = run('mirror', 'nope');
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /未知的 npm 下载源/);

  assert.equal(run('mirror', 'npmmirror', 'extra').status, 2);
  assert.equal(run('status', 'extra').status, 2);
  assert.equal(run('remote', 'https', 'off', 'extra').status, 2);
});

test('mdash.cmd passes the remote subcommand and arguments to the controller', { skip: process.platform !== 'win32' }, () => {
  // Uses isolated config and data directories: the panel is not running, so the controller requests no endpoint.
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-panel-manager-remote-'));
  try {
    const run = (...args) => spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', managerPath, ...args],
      {
        env: {
          ...cleanEnvironment(),
          MYSTRY_CONFIG_PATH: path.join(testRoot, '.env'),
          MYSTRY_DATA_DIR: path.join(testRoot, 'data'),
        },
        encoding: 'utf8',
      },
    );
    const status = run('remote', 'status');
    assert.equal(status.status, 0, `${status.stdout}\n${status.stderr}`);
    assert.match(status.stdout, /状态：未运行/);
    for (const args of [['remote', 'on'], ['remote', 'https', 'off'], ['remote', 'renew-cert']]) {
      const result = run(...args);
      assert.equal(result.status, 1, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout + result.stderr, /面板未运行。请先启动面板。/);
    }
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});
