import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export type AtomicWriteOptions = {
  /** Permission bits the file is created with; the umask applies, as to any new file. Defaults to owner-only, for the panel's own files. */
  createMode?: number;
  /** Permission bits set on the file whatever the umask is, to keep those of the file being replaced. */
  exactMode?: number;
  /** Tests only: stands in for the rename over the target. */
  renameSync?: typeof fs.renameSync;
};

/** Writes a temp file in the same directory and fsyncs it, then renames it over the target; a failure at any step never leaves a half-written target file. */
export function writeFileAtomic(target: string, content: string | Buffer, options: AtomicWriteOptions = {}): void {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(
    dir,
    `.${path.basename(target)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const fd = fs.openSync(temp, 'wx', options.createMode ?? 0o600);
  try {
    try {
      if (options.exactMode !== undefined) fs.fchmodSync(fd, options.exactMode);
      // One call may write less than it was given.
      for (let written = 0; written < bytes.length;) {
        written += fs.writeSync(fd, bytes, written);
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // Rename directly over the target: an atomic replace on POSIX, and on Windows libuv uses
    // MOVEFILE_REPLACE_EXISTING. The original file is not deleted first, so it is still there if rename fails.
    (options.renameSync ?? fs.renameSync)(temp, target);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* Ignore cleanup failures */
    }
    throw error;
  }
}
