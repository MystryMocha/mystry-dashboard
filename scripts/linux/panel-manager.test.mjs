import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..', '..');
const launcherPath = path.join(projectRoot, 'PanelManager.sh');
const controllerPath = path.join(projectRoot, 'scripts', 'portable', 'mystryctl.mjs');

test('the Linux source launcher reuses the cross-platform controller with a fingerprint', async () => {
  const source = await fs.readFile(launcherPath, 'utf8');
  const controller = await fs.readFile(controllerPath, 'utf8');

  assert.match(source, /^#!\/usr\/bin\/env bash/m);
  assert.match(source, /node --no-warnings --experimental-sqlite "\$CONTROLLER"/);
  assert.match(source, /npm ci/);
  assert.match(source, /npm run build/);
  assert.match(source, /rebuild\)\s+call_controller stop\s+ensure_dependencies force\s+build_sources\s+run_controller start/);
  assert.match(controller, /const sourceManagerCommand = process\.platform === 'win32' \? 'PanelManager\.cmd' : 'PanelManager\.sh';/);
  assert.match(controller, /const managerCommand = portableMode \? 'mystryctl' : sourceManagerCommand;/);
  assert.match(controller, /const repositoryServerEntry = path\.join\(homeDir, 'apps', 'server', 'dist', 'index\.js'\);/);
});

test('the launcher on Linux can forward the help command directly', { skip: process.platform !== 'linux' }, () => {
  const result = spawnSync('bash', [launcherPath, 'help'], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, MYSTRY_NO_BROWSER: '1', MYSTRY_LANG: 'zh-CN' },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Mystry Dashboard 源码版管理器/);
  assert.match(result.stdout, /用法：PanelManager\.sh <command>/);
  assert.match(result.stdout, /start\s+后台启动面板/);
});

test('reset-password in the Linux launcher refuses and returns non-zero when output is not a terminal', { skip: process.platform !== 'linux' }, async (t) => {
  // Output goes through a pipe: mystryctl must refuse before contacting the server, and after exec the exit code is returned as is.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mystry-linux-reset-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = spawnSync('bash', [launcherPath, 'reset-password'], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      MYSTRY_LANG: 'zh-CN',
      MYSTRY_CONFIG_PATH: path.join(root, 'panel.env'),
      MYSTRY_DATA_DIR: path.join(root, 'data'),
    },
  });

  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /当前输出不是终端[\s\S]*没有重置密码/);
  assert.doesNotMatch(result.stdout + result.stderr, /^[ \t]*密码：/m);
});

test('the Linux launcher passes the remote subcommand and arguments to the controller', { skip: process.platform !== 'linux' }, async (t) => {
  // Uses isolated config and data directories: the panel is not running, so the controller requests no endpoint.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mystry-linux-remote-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = (...args) => spawnSync('bash', [launcherPath, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      MYSTRY_LANG: 'zh-CN',
      MYSTRY_CONFIG_PATH: path.join(root, 'panel.env'),
      MYSTRY_DATA_DIR: path.join(root, 'data'),
    },
  });
  const status = run('remote', 'status');
  assert.equal(status.status, 0, `${status.stdout}\n${status.stderr}`);
  assert.match(status.stdout, /状态：未运行/);
  for (const args of [['remote', 'on'], ['remote', 'https', 'off'], ['remote', 'renew-cert']]) {
    const result = run(...args);
    assert.equal(result.status, 1, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /面板未运行。请先启动面板。/);
  }
  // Too many arguments are rejected by the launcher itself; other commands still cannot take arguments.
  assert.equal(run('remote', 'https', 'off', 'extra').status, 1);
  assert.equal(run('status', 'extra').status, 1);
});

test('the Linux launcher installs dependencies from the chosen download source', { skip: process.platform !== 'linux' }, async (t) => {
  // Puts a copy of the launcher in a temp directory, with npm and the controller both stubbed, and looks only at the arguments actually passed to npm.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mystry-linux-mirror-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'scripts', 'portable'), { recursive: true });
  await fs.mkdir(path.join(root, 'bin'));
  await fs.copyFile(launcherPath, path.join(root, 'PanelManager.sh'));
  for (const name of ['npm-mirror.mjs', 'is-main-module.mjs']) {
    await fs.copyFile(path.join(projectRoot, 'scripts', name), path.join(root, 'scripts', name));
  }
  await fs.writeFile(path.join(root, 'scripts', 'portable', 'mystryctl.mjs'), '', 'utf8');
  await fs.writeFile(path.join(root, 'package-lock.json'), '{}', 'utf8');
  const npmLog = path.join(root, 'npm.log');
  await fs.writeFile(path.join(root, 'bin', 'npm'), `#!/bin/sh\necho "$*" >> "${npmLog}"\n`, { mode: 0o755 });

  const run = (args, env = {}) => spawnSync('bash', [path.join(root, 'PanelManager.sh'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}`, MYSTRY_LANG: 'zh-CN', ...env },
  });
  const installs = async () => (await fs.readFile(npmLog, 'utf8')).split('\n').filter((line) => line.startsWith('ci'));

  assert.equal(run(['rebuild'], { MYSTRY_NPM_MIRROR: 'default' }).status, 0);
  assert.deepEqual(await installs(), ['ci']);

  assert.equal(run(['rebuild'], { MYSTRY_NPM_MIRROR: 'npmmirror' }).status, 0);
  assert.equal((await installs()).at(-1), 'ci --registry=https://registry.npmmirror.com/');

  assert.equal(run(['mirror', 'official']).status, 0);
  assert.match(run(['mirror']).stdout, /\* \[2\] official/);
  assert.equal(run(['rebuild']).status, 0);
  assert.equal((await installs()).at(-1), 'ci --registry=https://registry.npmjs.org/');

  assert.notEqual(run(['rebuild'], { MYSTRY_NPM_MIRROR: 'nope' }).status, 0);
  assert.equal(run(['mirror', 'nope']).status, 2);
  assert.notEqual(run(['status', 'extra']).status, 0);
});
