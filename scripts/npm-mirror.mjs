#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-main-module.mjs';

/**
 * 源码启动器安装依赖时使用的 npm 下载源。
 * package-lock.json 只记录官方地址，npm 安装时把官方地址换成所选的源；
 * 内容仍由锁文件里的 integrity 校验，所以换源不会改变安装结果。
 * 便携版自带依赖，不用这个开关。
 */
export const OFFICIAL_REGISTRY = 'https://registry.npmjs.org/';

export const NPM_MIRRORS = [
  { id: 'default', url: '', zh: '跟随 npm 自身配置', en: "Follow npm's own configuration" },
  { id: 'official', url: OFFICIAL_REGISTRY, zh: 'npm 官方（国际）', en: 'npm official (international)' },
  { id: 'npmmirror', url: 'https://registry.npmmirror.com/', zh: 'npmmirror（中国大陆）', en: 'npmmirror (mainland China)' },
  { id: 'tencent', url: 'https://mirrors.cloud.tencent.com/npm/', zh: '腾讯云（中国大陆）', en: 'Tencent Cloud (mainland China)' },
  { id: 'huawei', url: 'https://repo.huaweicloud.com/repository/npm/', zh: '华为云（中国大陆）', en: 'Huawei Cloud (mainland China)' },
];

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// config/ 已被 .gitignore 忽略，单独放一个文件，不碰保存密钥的配置文件。
const selectionPath = path.join(projectRoot, 'config', 'npm-mirror');
const managerCommand = process.platform === 'win32' ? '.\\PanelManager.cmd' : './PanelManager.sh';

// 启动器已把界面语言规范化后写入 MYSTRY_LANG。
const chinese = /^zh/i.test(process.env.MYSTRY_LANG ?? '');
const text = (zh, en) => (chinese ? zh : en);
const label = (mirror) => text(mirror.zh, mirror.en);

/** 名称不区分大小写，也接受菜单里的编号。 */
export function findMirror(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return undefined;
  if (/^\d+$/.test(normalized)) return NPM_MIRRORS[Number(normalized) - 1];
  return NPM_MIRRORS.find((mirror) => mirror.id === normalized);
}

function unknownMirrorMessage(value) {
  const names = NPM_MIRRORS.map((mirror) => mirror.id).join(', ');
  return text(`未知的 npm 下载源：${value}。可选：${names}。`, `Unknown npm download source: ${value}. Choose one of: ${names}.`);
}

/** 环境变量优先于保存的选择，方便在 CI 或单次命令里临时指定。 */
function currentSelection() {
  const fromEnvironment = process.env.MYSTRY_NPM_MIRROR?.trim();
  const saved = fs.existsSync(selectionPath) ? fs.readFileSync(selectionPath, 'utf8').trim() : '';
  const value = fromEnvironment || saved || 'default';
  const mirror = findMirror(value);
  if (!mirror) throw new Error(unknownMirrorMessage(value));
  return mirror;
}

function showMirrors() {
  const current = currentSelection();
  console.log(text('npm 下载源（安装依赖时使用）：', 'npm download source (used when installing dependencies):'));
  NPM_MIRRORS.forEach((mirror, index) => {
    const marker = mirror === current ? '*' : ' ';
    console.log(`${marker} [${index + 1}] ${mirror.id.padEnd(10)} ${label(mirror)}`);
  });
  console.log(text(
    `\n切换：${managerCommand} mirror <名称或编号>`,
    `\nTo change it: ${managerCommand} mirror <name or number>`,
  ));
}

function setMirror(value) {
  const mirror = findMirror(value);
  if (!mirror) throw new Error(unknownMirrorMessage(value));
  fs.mkdirSync(path.dirname(selectionPath), { recursive: true });
  fs.writeFileSync(selectionPath, `${mirror.id}\n`, 'utf8');
  console.log(text(
    `npm 下载源已设为：${label(mirror)}。下次安装依赖时生效；要马上重装，运行 ${managerCommand} rebuild。`,
    `npm download source set to: ${label(mirror)}. It applies the next time dependencies are installed. To reinstall now, run ${managerCommand} rebuild.`,
  ));
  if (process.env.MYSTRY_NPM_MIRROR?.trim()) {
    console.warn(text(
      '注意：环境变量 MYSTRY_NPM_MIRROR 已设置，它的优先级更高。',
      'Note: the MYSTRY_NPM_MIRROR environment variable is set and takes priority.',
    ));
  }
}

function main() {
  const [command, value] = process.argv.slice(2);
  if (command === 'registry') {
    // 跟随 npm 自身配置时输出空内容，启动器据此不加 --registry。
    console.log(currentSelection().url);
    return;
  }
  if (command === 'show') {
    showMirrors();
    return;
  }
  if (command === 'set' && value) {
    setMirror(value);
    return;
  }
  throw new Error(text('用法：npm-mirror.mjs registry | show | set <名称或编号>', 'Usage: npm-mirror.mjs registry | show | set <name or number>'));
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
