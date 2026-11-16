import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-main-module.mjs';
import { NPM_MIRRORS, OFFICIAL_REGISTRY } from './npm-mirror.mjs';

/**
 * 锁文件是公开内容，只能记录官方地址。npm 在配置了镜像的机器上安装新依赖时，
 * 会把镜像地址写进 resolved，其他人安装时就会被固定到这个镜像，所以要在 verify 里拦住。
 * 按文本处理，修复时不改动锁文件的其他内容。
 */
const RESOLVED_PATTERN = /"resolved": "(https?:\/\/[^"]+)"/g;

export function findForeignResolved(lockText) {
  return [...lockText.matchAll(RESOLVED_PATTERN)]
    .map((match) => match[1])
    .filter((url) => !url.startsWith(OFFICIAL_REGISTRY));
}

/** 只改写已知镜像；未知地址可能是私有源，留给维护者判断。 */
export function replaceKnownMirrors(lockText) {
  return lockText.replace(RESOLVED_PATTERN, (entry, url) => {
    const mirror = NPM_MIRRORS.find((candidate) => candidate.url && url.startsWith(candidate.url));
    return mirror ? `"resolved": "${OFFICIAL_REGISTRY}${url.slice(mirror.url.length)}"` : entry;
  });
}

function main() {
  const lockPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package-lock.json');
  let lockText = fs.readFileSync(lockPath, 'utf8');

  if (process.argv.includes('--fix')) {
    const fixed = replaceKnownMirrors(lockText);
    if (fixed !== lockText) {
      fs.writeFileSync(lockPath, fixed, 'utf8');
      console.log(`已把 ${findForeignResolved(lockText).length - findForeignResolved(fixed).length} 条镜像地址改回官方地址。`);
      lockText = fixed;
    }
  }

  const foreign = findForeignResolved(lockText);
  if (foreign.length > 0) {
    console.error(`package-lock.json 有 ${foreign.length} 条 resolved 不是官方地址：`);
    for (const url of foreign.slice(0, 5)) console.error(`  ${url}`);
    console.error('运行 npm run lockfile:fix 改回官方地址。');
    process.exitCode = 1;
    return;
  }
  console.log('package-lock.json 只包含官方下载地址。');
}

if (isMainModule(import.meta.url)) {
  main();
}
