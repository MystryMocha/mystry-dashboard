import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { hasErrorCode, PanelError } from './errors.js';

export const OWNERSHIP_MARKER_FILE = '.mystry-instance.json';

function comparable(value: string): string {
  let normalized = path.resolve(value);
  if (process.platform === 'win32') {
    normalized = normalized.replace(/^\\\\\?\\/, '');
    return normalized.toLowerCase();
  }
  return normalized;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(comparable(root), comparable(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Verifies that neither the instance root itself nor its parent path contains a symlink/junction. realpath detects Windows junctions better than lstat alone.
 */
export function assertSafeInstanceRoot(instanceRoot: string): string {
  const root = path.resolve(instanceRoot);
  if (!fs.existsSync(root)) throw new PanelError('server.files.instanceDirNotFound');
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new PanelError('server.files.instanceDirIsLink');
  }
  const realRoot = fs.realpathSync(root);
  if (!isWithin(root, realRoot)) {
    throw new PanelError('server.files.instanceDirEscapes');
  }
  return root;
}

/** Checks the nearest existing parent directory before creating a directory, so mkdir cannot escape through a dangling symlink/junction. */
export function assertSafeDirectoryPath(targetPath: string): void {
  let probe = path.resolve(targetPath);
  while (true) {
    try {
      fs.lstatSync(probe);
      assertSafeInstanceRoot(probe);
      return;
    } catch (err) {
      if (!hasErrorCode(err, 'ENOENT')) throw err;
      const parent = path.dirname(probe);
      if (parent === probe) throw new PanelError('server.files.noSafeParent');
      probe = parent;
    }
  }
}

function assertNoSymlinkTraversal(root: string, target: string): void {
  const safeRoot = assertSafeInstanceRoot(root);
  const relative = path.relative(safeRoot, target);
  if (!relative) return;

  let current = safeRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (err) {
      if (hasErrorCode(err, 'ENOENT')) break;
      throw err;
    }
    if (stat.isSymbolicLink()) {
      throw new PanelError('server.files.path.linkTraversal');
    }
    const realCurrent = fs.realpathSync(current);
    if (!isWithin(current, realCurrent)) {
      throw new PanelError('server.files.path.linkEscapes');
    }
  }
}

/**
 * Safely resolves a relative path inside the instance root, preventing path escape.
 */
export function resolveSafePath(instanceRoot: string, relativePath = ''): string {
  const root = path.resolve(instanceRoot);
  const cleaned = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const target = path.resolve(root, cleaned);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new PanelError('server.files.path.outside');
  }
  assertNoSymlinkTraversal(root, target);
  return target;
}

const INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

export function isValidInstanceId(instanceId: string): boolean {
  return INSTANCE_ID_PATTERN.test(instanceId);
}

/** Default install directory: data/instances/<id> */
export function defaultInstanceDir(instanceId: string): string {
  if (!isValidInstanceId(instanceId)) {
    throw new PanelError('server.files.instanceIdInvalid');
  }
  return path.join(config.instancesDir, instanceId);
}

export function getInstanceDir(instanceId: string): string {
  const row = getDb()
    .prepare('SELECT install_path FROM instances WHERE id = ?')
    .get(instanceId) as { install_path: string | null } | undefined;
  if (!row) {
    throw new PanelError('server.files.instanceNotFound');
  }
  if (row.install_path !== null) {
    throw new PanelError('server.files.legacyInstallPath');
  }
  return assertSafeInstanceRoot(defaultInstanceDir(instanceId));
}

/** Resolves the directory when the row is already known, avoiding another database query */
export function resolveDirFromRow(row: {
  id: string;
  install_path: string | null;
}): string {
  if (row.install_path !== null) {
    throw new PanelError('server.files.legacyInstallPath');
  }
  return defaultInstanceDir(row.id);
}

export function writeOwnershipMarker(
  instanceId: string,
  instanceRoot: string,
  marker: string,
): void {
  const root = assertSafeInstanceRoot(instanceRoot);
  const markerPath = resolveSafePath(root, OWNERSHIP_MARKER_FILE);
  fs.writeFileSync(
    markerPath,
    `${JSON.stringify({ version: 1, instanceId, marker })}\n`,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
}

export type OwnershipMarkerInspection = {
  exists: boolean;
  marker: string | null;
};

/** Checks the marker in the fixed managed directory, telling a missing one from invalid content. */
export function inspectOwnershipMarker(
  instanceId: string,
  instanceRoot: string,
): OwnershipMarkerInspection {
  const root = assertSafeInstanceRoot(instanceRoot);
  const markerPath = resolveSafePath(root, OWNERSHIP_MARKER_FILE);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(markerPath);
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) {
      return { exists: false, marker: null };
    }
    throw err;
  }

  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { exists: true, marker: null };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as {
      version?: number;
      instanceId?: string;
      marker?: unknown;
    };
    if (
      parsed.version !== 1 ||
      parsed.instanceId !== instanceId ||
      typeof parsed.marker !== 'string' ||
      parsed.marker.length === 0
    ) {
      return { exists: true, marker: null };
    }
    return { exists: true, marker: parsed.marker };
  } catch {
    return { exists: true, marker: null };
  }
}

/** Reads and validates the ownership marker in the fixed managed directory. */
export function readOwnershipMarker(instanceId: string, instanceRoot: string): string | null {
  try {
    return inspectOwnershipMarker(instanceId, instanceRoot).marker;
  } catch {
    return null;
  }
}

export function hasValidOwnershipMarker(
  row: { id: string; install_path: string | null; ownership_marker: string | null },
): boolean {
  if (row.install_path !== null || !row.ownership_marker) return false;
  const root = defaultInstanceDir(row.id);
  return readOwnershipMarker(row.id, root) === row.ownership_marker;
}

/** Deletes the marker only if it still exactly matches the value written this time, so other markers are not removed by mistake. */
export function removeOwnershipMarker(
  instanceId: string,
  instanceRoot: string,
  marker: string,
): boolean {
  try {
    const root = assertSafeInstanceRoot(instanceRoot);
    const markerPath = resolveSafePath(root, OWNERSHIP_MARKER_FILE);
    const stat = fs.lstatSync(markerPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const expected = `${JSON.stringify({ version: 1, instanceId, marker })}\n`;
    if (fs.readFileSync(markerPath, 'utf8') !== expected) return false;
    fs.unlinkSync(markerPath);
    return true;
  } catch {
    return false;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
