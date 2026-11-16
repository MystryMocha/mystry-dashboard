import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function realPathOrResolved(target) {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * 判断脚本是否被 node 直接运行（而不是被测试导入）。
 * Node 会把入口解析成真实路径再加载，argv[1] 却保留调用时的写法；仓库路径含符号链接或
 * junction 时直接比较会误判，脚本什么都不做就以 0 退出，检查类脚本会因此"静默通过"。
 * 与 apps/server/src/utils/real-path.ts 的 isMainModule 保持一致。
 */
export function isMainModule(moduleUrl, entry = process.argv[1]) {
  if (!entry) return false;
  return realPathOrResolved(entry) === realPathOrResolved(fileURLToPath(moduleUrl));
}
