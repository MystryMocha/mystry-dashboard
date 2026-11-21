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

/** The script finds config/ relative to its own location, so once copied to a temp directory it does not touch the choice in the repo. */
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

test('follows the npm config by default and outputs no URL', (t) => {
  const { run } = createSandbox(t);
  const result = run(['registry']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '');
});

test('a choice is saved by name or number and takes effect on the next read', (t) => {
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

test('the environment variable takes precedence over the saved choice, with a reminder when setting', (t) => {
  const { run } = createSandbox(t);
  run(['set', 'official']);

  const env = { MYSTRY_NPM_MIRROR: 'huawei' };
  assert.equal(run(['registry'], env).stdout.trim(), 'https://repo.huaweicloud.com/repository/npm/');
  assert.match(run(['set', 'official'], env).stderr, /优先级更高/);
});

test('an invalid choice errors and lists the options, without writing the file', (t) => {
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

test('the list marks the current choice and follows the UI language', (t) => {
  const { run } = createSandbox(t);
  run(['set', 'npmmirror']);

  const chinese = run(['show']);
  assert.equal(chinese.status, 0, chinese.stderr);
  assert.match(chinese.stdout, /\* \[3\] npmmirror\s+npmmirror（中国大陆）/);
  assert.match(chinese.stdout, /\[2\] official\s+npm 官方（国际）/);

  assert.match(run(['show'], { MYSTRY_LANG: 'en-US' }).stdout, /\[2\] official\s+npm official \(international\)/);
});

test('all mirror URLs are https and end with a slash', () => {
  assert.equal(findMirror('default').url, '');
  for (const mirror of NPM_MIRRORS.filter((candidate) => candidate.url)) {
    assert.match(mirror.url, /^https:\/\/.+\/$/);
  }
});

test('the lockfile check finds mirror URLs, and the fix changes only resolved', () => {
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

test('the repo package-lock.json contains only official URLs', () => {
  const lock = fs.readFileSync(path.join(scriptDirectory, '..', 'package-lock.json'), 'utf8');
  assert.deepEqual(findForeignResolved(lock), []);
});
