import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** 先写同目录临时文件并 fsync，再 rename 覆盖目标；任何一步失败都不会留下写了一半的目标文件。 */
export function writeFileAtomic(target: string, content: string): void {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(
    dir,
    `.${path.basename(target)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeSync(fd, Buffer.from(content, 'utf8'));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    // 直接 rename 覆盖：POSIX 原子替换，Windows 上 libuv 使用
    // MOVEFILE_REPLACE_EXISTING。不先删除原文件，rename 失败时原文件仍保留。
    fs.renameSync(temp, target);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* 忽略清理失败 */
    }
    throw error;
  }
}
