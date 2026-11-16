import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { findForeignResolved, replaceKnownMirrors } from './check-lockfile-registry.mjs';
import { findMirror, NPM_MIRRORS, OFFICIAL_REGISTRY } from './npm-mirror.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

/** 脚本按自身位置找 config/，复制到临时目录后就不会碰到仓库里的选择。 */
function createSandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-npm-mirror-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const name of ['npm-mirror.mjs', 'is-main-module.mjs']) {
    fs.copyFileSync(path.join(scriptDirectory, name), path.join(root, 'scripts', name));
  }
  const run = (args, env = {}) => {
    const environment = { ...process.env, MYSTRY_LANG: 'zh-CN', ...env };
    if (!('MYSTRY_NPM_MIRROR' in env)) delete environment.MYSTRY_NPM_MIRROR;
    return spawnSync(process.execPath, [path.join(root, 'scripts', 'npm-mirror.mjs'), ...args], {
      encoding: 'utf8',
      env: environment,
    });
  };
  return { root, run };
}

test('默认跟随 npm 自身配置，不输出地址', (t) => {
  const { run } = createSandbox(t);
  const result = run(['registry']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '');
});

test('选择按名称或编号保存，下次读取生效', (t) => {
  const { root, run } = createSandbox(t);

  assert.equal(run(['set', 'npmmirror']).status, 0);
  assert.equal(fs.readFileSync(path.join(root, 'config', 'npm-mirror'), 'utf8'), 'npmmirror\n');
  assert.equal(run(['registry']).stdout.trim(), 'https://registry.npmmirror.com/');

  assert.equal(run(['set', '2']).status, 0);
  assert.equal(run(['registry']).stdout.trim(), OFFICIAL_REGISTRY);

  assert.equal(run(['set', 'TENCENT']).status, 0);
  assert.equal(run(['registry']).stdout.trim(), 'https://mirrors.cloud.tencent.com/npm/');

  assert.equal(run(['set', 'default']).status, 0);
  assert.equal(run(['registry']).stdout.trim(), '');
});

test('环境变量优先于保存的选择，设置时会提醒', (t) => {
  const { run } = createSandbox(t);
  run(['set', 'official']);

  const env = { MYSTRY_NPM_MIRROR: 'huawei' };
  assert.equal(run(['registry'], env).stdout.trim(), 'https://repo.huaweicloud.com/repository/npm/');
  assert.match(run(['set', 'official'], env).stderr, /优先级更高/);
});

test('无效的选择报错并列出可选项，不写入文件', (t) => {
  const { root, run } = createSandbox(t);

  for (const value of ['nope', '0', '99']) {
    const result = run(['set', value]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /未知的 npm 下载源/);
    assert.match(result.stderr, /npmmirror/);
  }
  assert.equal(fs.existsSync(path.join(root, 'config', 'npm-mirror')), false);

  const invalid = run(['registry'], { MYSTRY_NPM_MIRROR: 'nope' });
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, '');
});

test('列表标出当前选择，并跟随界面语言', (t) => {
  const { run } = createSandbox(t);
  run(['set', 'npmmirror']);

  const chinese = run(['show']);
  assert.equal(chinese.status, 0, chinese.stderr);
  assert.match(chinese.stdout, /\* \[3\] npmmirror\s+npmmirror（中国大陆）/);
  assert.match(chinese.stdout, /\[2\] official\s+npm 官方（国际）/);

  assert.match(run(['show'], { MYSTRY_LANG: 'en-US' }).stdout, /\[2\] official\s+npm official \(international\)/);
});

test('所有镜像地址都是 https 并以斜杠结尾', () => {
  assert.equal(findMirror('default').url, '');
  for (const mirror of NPM_MIRRORS.filter((candidate) => candidate.url)) {
    assert.match(mirror.url, /^https:\/\/.+\/$/);
  }
});

test('锁文件检查找出镜像地址，修复时只改 resolved', () => {
  const lock = [
    '"resolved": "https://registry.npmjs.org/a/-/a-1.0.0.tgz",',
    '"resolved": "https://registry.npmmirror.com/@scope/b/-/b-1.0.0.tgz",',
    '"resolved": "https://mirrors.cloud.tencent.com/npm/c/-/c-1.0.0.tgz",',
    '"resolved": "https://packages.example.com/d/-/d-1.0.0.tgz",',
    '"resolved": "apps/server",',
    '"note": "https://registry.npmmirror.com/untouched",',
  ].join('\n');

  assert.equal(findForeignResolved(lock).length, 3);

  const fixed = replaceKnownMirrors(lock);
  assert.match(fixed, /"resolved": "https:\/\/registry\.npmjs\.org\/@scope\/b\/-\/b-1\.0\.0\.tgz"/);
  assert.match(fixed, /"resolved": "https:\/\/registry\.npmjs\.org\/c\/-\/c-1\.0\.0\.tgz"/);
  assert.match(fixed, /"note": "https:\/\/registry\.npmmirror\.com\/untouched"/);
  assert.deepEqual(findForeignResolved(fixed), ['https://packages.example.com/d/-/d-1.0.0.tgz']);
});

test('仓库的 package-lock.json 只包含官方地址', () => {
  const lock = fs.readFileSync(path.join(scriptDirectory, '..', 'package-lock.json'), 'utf8');
  assert.deepEqual(findForeignResolved(lock), []);
});
