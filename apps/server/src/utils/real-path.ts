import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 解析路径中的符号链接和 junction；路径尚不存在时，解析最近的已存在上级再接上剩余部分。
 * 用 JS 版 realpathSync 而不是 .native：没有链接的路径原样返回，不会改写 subst 盘符、
 * 映射网络盘或 8.3 短文件名，所以不影响现有安装；它也和 Node 解析入口模块时用的是同一个实现。
 */
export function resolveRealPath(target: string): string {
  const resolved = path.resolve(target);
  const missing: string[] = [];
  let probe = resolved;
  while (true) {
    try {
      return path.join(fs.realpathSync(probe), ...missing.reverse());
    } catch {
      const parent = path.dirname(probe);
      // 到根目录仍无法解析（权限不足等）时保持原值，交给后续的正常错误处理。
      if (parent === probe) return resolved;
      missing.push(path.basename(probe));
      probe = parent;
    }
  }
}

/**
 * 判断模块是否为 node 直接运行的入口。Node 会把入口解析成真实路径再加载，
 * argv[1] 却保留调用时的写法；安装路径含符号链接或 junction 时两者不同，
 * 直接比较会误判为"被导入"，进程什么都不做就以 0 退出。
 */
export function isMainModule(moduleUrl: string, entry: string | undefined = process.argv[1]): boolean {
  if (!entry) return false;
  return resolveRealPath(entry) === resolveRealPath(fileURLToPath(moduleUrl));
}
