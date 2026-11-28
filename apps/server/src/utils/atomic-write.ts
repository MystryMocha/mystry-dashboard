import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export type AtomicWriteOptions = {
  /** Permission bits the file is created with; the umask applies, as to any new file. Defaults to owner-only, for the panel's own files. */
  createMode?: number;
  /** Permission bits set on the file whatever the umask is, to keep those of the file being replaced. */
  exactMode?: number;
  /** Takes the place of the process ID in the temp file's name, so that the caller can recognize its own leftovers. */
  tempTag?: string;
  /** With false, publish through a hard link so an existing target cannot be replaced. */
  replaceExisting?: boolean;
  /** Tests only: stands in for the rename over the target. */
  renameSync?: typeof fs.renameSync;
};

/** Writes and fsyncs a temp file in the same directory so the target is only published once the content is complete. */
export function writeFileAtomic(target: string, content: string | Buffer, options: AtomicWriteOptions = {}): void {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(
    dir,
    `.${path.basename(target)}.${options.tempTag ?? process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const fd = fs.openSync(temp, 'wx', options.createMode ?? 0o600);
  let renamed = false;
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
    if (options.replaceExisting === false) {
      fs.linkSync(temp, target);
    } else {
      // libuv uses MOVEFILE_REPLACE_EXISTING on Windows. If the rename fails, the old file is still there.
      (options.renameSync ?? fs.renameSync)(temp, target);
      renamed = true;
    }
  } finally {
    if (!renamed) {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        /* Ignore cleanup failures */
      }
    }
  }
}
