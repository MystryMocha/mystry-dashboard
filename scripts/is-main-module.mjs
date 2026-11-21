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
 * Tells whether the script is run directly by node (rather than imported by a test).
 * Node resolves the entry to its real path before loading it, while argv[1] keeps the path as invoked; when the repo path contains a symlink or
 * junction a direct comparison gives the wrong answer, the script does nothing and exits with 0, and check scripts would "pass silently" because of it.
 * Kept in sync with isMainModule in apps/server/src/utils/real-path.ts.
 */
export function isMainModule(moduleUrl, entry = process.argv[1]) {
  if (!entry) return false;
  return realPathOrResolved(entry) === realPathOrResolved(fileURLToPath(moduleUrl));
}
