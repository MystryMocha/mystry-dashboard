import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolves symlinks and junctions in a path; when the path does not exist yet, resolves the nearest existing ancestor and appends the rest.
 * Uses the JS realpathSync rather than .native: a path without links is returned unchanged, without rewriting subst drive letters,
 * mapped network drives or 8.3 short names, so existing installs are unaffected; it is also the same implementation Node uses when resolving the entry module.
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
      // When it still cannot be resolved at the root (insufficient permissions, etc.), keep the original value and leave it to the normal error handling later.
      if (parent === probe) return resolved;
      missing.push(path.basename(probe));
      probe = parent;
    }
  }
}

/**
 * Tells whether a module is the entry run directly by node. Node resolves the entry to its real path before loading it,
 * while argv[1] keeps the path as invoked; they differ when the install path contains a symlink or junction,
 * and a direct comparison would wrongly conclude "imported", so the process would do nothing and exit with 0.
 */
export function isMainModule(moduleUrl: string, entry: string | undefined = process.argv[1]): boolean {
  if (!entry) return false;
  return resolveRealPath(entry) === resolveRealPath(fileURLToPath(moduleUrl));
}
