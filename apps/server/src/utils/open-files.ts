import fs from 'node:fs';

/**
 * Whether the process has the file open, told by comparing the file with what each of its descriptors points at.
 * Linux only, where /proc lists them; on other systems, and whenever the answer cannot be had (the process is gone or
 * belongs to another user), the answer is false.
 */
export function isFileOpenInProcess(pid: number, file: string): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const target = fs.statSync(file);
    const descriptors = `/proc/${pid}/fd`;
    for (const descriptor of fs.readdirSync(descriptors)) {
      try {
        const open = fs.statSync(`${descriptors}/${descriptor}`);
        if (open.ino === target.ino && open.dev === target.dev) return true;
      } catch {
        /* Closed in the meantime. */
      }
    }
  } catch {
    /* No such process or file, or no permission to look. */
  }
  return false;
}
