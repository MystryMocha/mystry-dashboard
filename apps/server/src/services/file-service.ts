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

const pathSeparator = Buffer.from(path.sep);

/**
 * Removes a file or a directory tree one entry at a time, with the choices Node's own recursive removal makes: a link is removed,
 * never followed, and a directory is entered only after removing it as it stands has failed because it is not empty.
 * fs.promises.rm is not used because it removes all entries of a directory at once. When one of them cannot be removed it rejects
 * while the others are still being removed, so the caller would release the instance lock before the tree is quiet; it also keeps
 * the thread pool busy enough to hold up every other file read and write. One at a time, nothing is still running once this has
 * thrown, and other file work carries on, at the cost of a removal that takes about two and a half times as long.
 */
async function removeEntry(target: string | Buffer, listed?: fs.Dirent<Buffer>): Promise<void> {
  try {
    // A directory listing on Windows reports every reparse point as a link, including directories that are not links (cloud
    // placeholders, mounted volumes), so only a plain file or a plain directory is taken at its word.
    const isDirectory = listed?.isDirectory()
      || (!listed?.isFile() && (await fs.promises.lstat(target)).isDirectory());
    if (!isDirectory) {
      await fs.promises.unlink(target);
      return;
    }
    try {
      await fs.promises.rmdir(target);
      return;
    } catch (error) {
      if (!hasErrorCode(error, 'ENOTEMPTY') && !hasErrorCode(error, 'EEXIST')) throw error;
    }
    // Names are handled as raw bytes: on Linux a name need not be valid UTF-8 (files unpacked from an archive made elsewhere),
    // and one that has been read as a string no longer matches the entry it came from.
    const prefix = Buffer.concat([typeof target === 'string' ? Buffer.from(target) : target, pathSeparator]);
    for (const child of await fs.promises.readdir(target, { withFileTypes: true, encoding: 'buffer' })) {
      await removeEntry(Buffer.concat([prefix, child.name]), child);
    }
    await fs.promises.rmdir(target);
  } catch (error) {
    // Already gone, for example removed by the running server in the meantime.
    if (!hasErrorCode(error, 'ENOENT')) throw error;
  }
}

/**
 * A directory here may hold tens of thousands of files, so the removal is awaited rather than done with rmSync, which would hold
 * every request and all console output until it finished. Other requests therefore run while entries are still being removed:
 * the caller must hold the instance lock (processManager.runExclusive), otherwise a restore could swap the instance directory
 * midway and the remaining removals would land in the restored one.
 */
export async function deletePath(instanceId: string, relativePath: string): Promise<void> {
  const root = getInstanceDir(instanceId);
  const target = resolveSafePath(root, relativePath);
  assertMutableTarget(root, target);
  if (!fs.existsSync(target)) {
    throw new PanelError('server.files.pathNotFound');
  }
  await removeEntry(target);
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
