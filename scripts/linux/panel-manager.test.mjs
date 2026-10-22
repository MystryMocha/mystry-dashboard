import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..', '..');
const launcherPath = path.join(projectRoot, 'PanelManager.sh');
const controllerPath = path.join(projectRoot, 'scripts', 'portable', 'mystryctl.mjs');

test('Linux 源码启动器复用带指纹的跨平台控制器', async () => {
  const source = await fs.readFile(launcherPath, 'utf8');
  const controller = await fs.readFile(controllerPath, 'utf8');

  assert.match(source, /^#!\/usr\/bin\/env bash/m);
  assert.match(source, /node --experimental-sqlite "\$CONTROLLER"/);
  assert.match(source, /npm ci/);
  assert.match(source, /npm run build/);
  assert.match(source, /rebuild\)\s+call_controller stop\s+ensure_dependencies force\s+build_sources\s+run_controller start/);
  assert.match(controller, /const sourceManagerCommand = process\.platform === 'win32' \? 'PanelManager\.cmd' : 'PanelManager\.sh';/);
  assert.match(controller, /const managerCommand = portableMode \? 'mystryctl' : sourceManagerCommand;/);
  assert.match(controller, /const repositoryServerEntry = path\.join\(homeDir, 'apps', 'server', 'dist', 'index\.js'\);/);
});

test('Linux 上的启动器可直接转发帮助命令', { skip: process.platform !== 'linux' }, () => {
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
