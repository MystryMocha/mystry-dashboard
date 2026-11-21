import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { FileEntry } from '@mystry/shared';
import { config } from '../config.js';
import { getInstanceDir, OWNERSHIP_MARKER_FILE, resolveSafePath } from '../utils/path.js';
import { streamToUploadTemp, removeUploadTemp } from './upload-service.js';
import { hasErrorCode, PanelError } from '../utils/errors.js';

const { maxTextFileBytes } = config;

export class FileDownloadCapacityError extends PanelError {
  readonly code = 'FILE_DOWNLOAD_CAPACITY';

  constructor() {
    super('server.files.download.capacity', undefined, { statusCode: 429 });
    this.name = 'FileDownloadCapacityError';
  }
}

export function isFileDownloadCapacityError(error: unknown): error is FileDownloadCapacityError {
  return error instanceof FileDownloadCapacityError
    || hasErrorCode(error, 'FILE_DOWNLOAD_CAPACITY');
}

export class FileRenameConflictError extends PanelError {
  readonly code = 'FILE_RENAME_CONFLICT' as const;
  readonly httpStatus = 409 as const;

  constructor() {
    super('server.files.rename.conflict', undefined, { statusCode: 409 });
    this.name = 'FileRenameConflictError';
  }
}

export function isFileRenameConflictError(error: unknown): error is FileRenameConflictError {
  return error instanceof FileRenameConflictError;
}

let activeFileDownloads = 0;

export function acquireFileDownloadSlot(): () => void {
  if (activeFileDownloads >= config.maxConcurrentFileDownloads) {
    throw new FileDownloadCapacityError();
  }
  activeFileDownloads += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeFileDownloads -= 1;
  };
}

function samePath(left: string, right: string): boolean {
  const leftResolved = path.resolve(left);
  const rightResolved = path.resolve(right);
  return process.platform === 'win32'
    ? leftResolved.toLowerCase() === rightResolved.toLowerCase()
    : leftResolved === rightResolved;
}

/** No entry point that changes the instance directory may touch the root directory or the ownership marker. */
function assertMutableTarget(root: string, target: string): void {
  if (samePath(root, target)) {
    throw new PanelError('server.files.rootImmutable');
  }
  const marker = resolveSafePath(root, OWNERSHIP_MARKER_FILE);
  if (samePath(marker, target)) {
    throw new PanelError('server.files.markerImmutable');
  }
}

export function listFiles(instanceId: string, relativePath = ''): FileEntry[] {
  const root = getInstanceDir(instanceId);
  const target = resolveSafePath(root, relativePath);
  if (!fs.existsSync(target)) {
    throw new PanelError('server.files.dirNotFound');
  }
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) {
    throw new PanelError('server.files.notDirectory');
  }

  // Sorted by the runtime locale (Windows Explorer style: directories first + natural order)
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const markerPath = path.join(root, OWNERSHIP_MARKER_FILE);
  // target has been validated segment by segment by resolveSafePath; entry names returned by readdir contain no path separators,
  // so each entry needs only one lstat to reject a symlink/junction, avoiding a per-item realpath of the whole path that would block the event loop.
  return fs
    .readdirSync(target, { withFileTypes: true })
    // The ownership marker in the instance root is maintained by the panel and not shown to users; the modifying endpoints already refuse to operate on it.
    .filter((entry) => !samePath(path.join(target, entry.name), markerPath))
    .map((entry) => {
      const full = path.join(target, entry.name);
      const s = fs.lstatSync(full);
      if (s.isSymbolicLink()) throw new PanelError('server.files.dirContainsLink');
      const rel = path.relative(root, full).replace(/\\/g, '/');
      return {
        name: entry.name,
        path: rel,
        isDirectory: entry.isDirectory(),
        size: entry.isDirectory() ? 0 : s.size,
        modifiedAt: s.mtime.toISOString(),
      };
    })
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return collator.compare(a.name, b.name);
    });
}

export function readTextFile(instanceId: string, relativePath: string): string {
  const root = getInstanceDir(instanceId);
  const target = resolveSafePath(root, relativePath);
  if (!fs.existsSync(target)) {
    throw new PanelError('server.files.fileNotFound');
  }

  const linkStat = fs.lstatSync(target);
  if (linkStat.isSymbolicLink() || !linkStat.isFile()) {
    throw new PanelError('server.files.notRegularFile');
  }
  const stat = fs.statSync(target);
  if (!stat.isFile()) {
    throw new PanelError('server.files.notRegularFile');
  }
  if (stat.size > maxTextFileBytes) {
    throw new PanelError('server.files.text.tooLarge', { limit: maxTextFileBytes });
  }
  return fs.readFileSync(target, 'utf8');
}

export function writeTextFile(instanceId: string, relativePath: string, content: string): void {
  if (typeof content !== 'string') {
    throw new PanelError('server.files.text.invalidContent');
  }
  const contentBytes = Buffer.byteLength(content, 'utf8');
  if (contentBytes > maxTextFileBytes) {
    throw new PanelError('server.files.text.tooLarge', { limit: maxTextFileBytes });
  }

  const root = getInstanceDir(instanceId);
  const target = resolveSafePath(root, relativePath);
  assertMutableTarget(root, target);
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new PanelError('server.files.notRegularFile');
    }
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, Buffer.from(content, 'utf8'));
}

/** Before reading server.properties directly, checks that it is still a restricted regular text file. */
export function assertTextFileWithinLimit(instanceId: string, relativePath: string): void {
  const root = getInstanceDir(instanceId);
  const target = resolveSafePath(root, relativePath);
  if (!fs.existsSync(target)) return;

  const linkStat = fs.lstatSync(target);
  if (linkStat.isSymbolicLink() || !linkStat.isFile()) {
    throw new PanelError('server.files.notRegularFile');
  }
  const stat = fs.statSync(target);
  if (!stat.isFile()) {
    throw new PanelError('server.files.notRegularFile');
  }
  if (stat.size > maxTextFileBytes) {
    throw new PanelError('server.files.text.tooLarge', { limit: maxTextFileBytes });
  }
}

export function deletePath(instanceId: string, relativePath: string): void {
  const root = getInstanceDir(instanceId);
  const target = resolveSafePath(root, relativePath);
  assertMutableTarget(root, target);
  if (!fs.existsSync(target)) {
    throw new PanelError('server.files.pathNotFound');
  }
  fs.rmSync(target, { recursive: true, force: true });
}

export function renamePath(instanceId: string, from: string, to: string): void {
  const fromNorm = from.replace(/\\/g, '/');
  const toNorm = to.replace(/\\/g, '/');
  const fromDir = path.posix.dirname(fromNorm);
  const toDir = path.posix.dirname(toNorm);
  if (fromDir !== toDir) {
    throw new PanelError('server.files.rename.sameDirOnly');
  }

  const root = getInstanceDir(instanceId);
  const src = resolveSafePath(root, from);
  const dest = resolveSafePath(root, to);
  assertMutableTarget(root, src);
  assertMutableTarget(root, dest);
  if (!fs.existsSync(src)) throw new PanelError('server.files.rename.sourceNotFound');
  if (fs.existsSync(dest)) {
    throw new FileRenameConflictError();
  }
  fs.renameSync(src, dest);
}

export function mkdirPath(instanceId: string, relativePath: string): void {
  const root = getInstanceDir(instanceId);
  const target = resolveSafePath(root, relativePath);
  assertMutableTarget(root, target);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
}

export function getAbsoluteFilePath(instanceId: string, relativePath: string): string {
  const root = getInstanceDir(instanceId);
  const target = resolveSafePath(root, relativePath);
  if (!fs.existsSync(target)) {
    throw new PanelError('server.files.fileNotFound');
  }
  const linkStat = fs.lstatSync(target);
  if (linkStat.isSymbolicLink()) {
    throw new PanelError('server.files.fileNotFound');
  }
  const stat = fs.statSync(target);
  if (!stat.isFile()) {
    throw new PanelError('server.files.fileNotFound');
  }
  return target;
}

type UploadReplaceOperations = {
  renameSync?: typeof fs.renameSync;
  unlinkSync?: typeof fs.unlinkSync;
  /**
   * Called synchronously after the upload is received and before it is moved into the instance directory; throwing abandons this upload.
   * Receiving a large file may take minutes, and the caller uses this to re-check whether a mutually exclusive operation such as a restore started in the meantime.
   */
  beforeCommit?: () => void;
};

function createUploadBackupPath(target: string): string {
  const directory = path.dirname(target);
  const name = path.basename(target);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const backup = path.join(directory, `.${name}.mystry-upload-backup-${randomBytes(12).toString('hex')}`);
    if (!fs.existsSync(backup)) return backup;
  }
  throw new PanelError('server.files.upload.backupFailed');
}

export async function saveUploadedFile(
  instanceId: string,
  relativeDir: string,
  filename: string,
  input: Readable,
  replaceOperations: UploadReplaceOperations = { renameSync: fs.renameSync },
): Promise<string> {
  const root = getInstanceDir(instanceId);
  const safeName = path.posix.basename(filename.replace(/\\/g, '/'));
  const target = resolveSafePath(root, path.posix.join(relativeDir || '', safeName));
  assertMutableTarget(root, target);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = await streamToUploadTemp(input, 'file');
  const renameSync = replaceOperations.renameSync ?? fs.renameSync;
  const unlinkSync = replaceOperations.unlinkSync ?? fs.unlinkSync;
  let backup: string | null = null;
  try {
    replaceOperations.beforeCommit?.();
    if (fs.existsSync(target)) {
      const existing = fs.lstatSync(target);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new PanelError('server.files.notRegularFile');
      }
      backup = createUploadBackupPath(target);
      renameSync(target, backup);
    }
    try {
      renameSync(temp, target);
    } catch (error) {
      if (backup) {
        try {
          renameSync(backup, target);
          backup = null;
        } catch {
          throw new PanelError('server.files.upload.restoreFailed');
        }
      }
      throw error;
    }
    if (backup) {
      try {
        unlinkSync(backup);
        backup = null;
      } catch (error) {
        console.warn(`上传已完成，但无法删除旧文件备份，需手动清理：${backup}`, error);
      }
    }
    return path.relative(root, target).replace(/\\/g, '/');
  } finally {
    if (fs.existsSync(temp)) removeUploadTemp(temp);
  }
}
