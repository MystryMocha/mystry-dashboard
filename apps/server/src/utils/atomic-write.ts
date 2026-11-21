import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** Writes a temp file in the same directory and fsyncs it, then renames it over the target; a failure at any step never leaves a half-written target file. */
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
    // Rename directly over the target: an atomic replace on POSIX, and on Windows libuv uses
    // MOVEFILE_REPLACE_EXISTING. The original file is not deleted first, so it is still there if rename fails.
    fs.renameSync(temp, target);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* Ignore cleanup failures */
    }
    throw error;
  }
}
