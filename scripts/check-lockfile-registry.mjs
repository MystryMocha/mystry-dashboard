import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-main-module.mjs';
import { NPM_MIRRORS, OFFICIAL_REGISTRY } from './npm-mirror.mjs';

/**
 * The lockfile is public content and may record only official URLs. When npm installs a new dependency on a machine configured with a mirror,
 * it writes the mirror URL into resolved, pinning everyone else's installs to that mirror, so verify has to block it.
 * Handled as text, so a fix does not touch the rest of the lockfile.
 */
const RESOLVED_PATTERN = /"resolved": "(https?:\/\/[^"]+)"/g;

export function findForeignResolved(lockText) {
  return [...lockText.matchAll(RESOLVED_PATTERN)]
    .map((match) => match[1])
    .filter((url) => !url.startsWith(OFFICIAL_REGISTRY));
}

/** Only known mirrors are rewritten; an unknown URL may be a private registry and is left for the maintainer to judge. */
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
