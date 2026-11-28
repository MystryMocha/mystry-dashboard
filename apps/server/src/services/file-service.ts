import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { FileEntry, ServerMessageKey, TextFileSaveRequest } from '@mystry/shared';
import { config } from '../config.js';
import { writeFileAtomic } from '../utils/atomic-write.js';
import { checkEntryName, type EntryNameIssue } from '../utils/entry-name.js';
import { isFileOpenInProcess } from '../utils/open-files.js';
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

const ENTRY_NAME_MESSAGES: Record<Exclude<EntryNameIssue, 'empty' | 'tooLong'>, ServerMessageKey> = {
  invalidCharacter: 'server.files.name.invalidCharacter',
  trailingDotOrSpace: 'server.files.name.trailingDotOrSpace',
  reserved: 'server.files.name.reserved',
};

/**
 * Refuses to create an entry under a name the system cannot handle afterwards (see checkEntryName). Every entry point that
 * may create a file or directory calls this for its target. Only the segments that do not exist yet are checked: an entry
 * that is already there, whatever its name, can still be opened, saved, renamed and deleted.
 */
function assertCreatableNames(root: string, target: string): void {
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current)) continue;
    const issue = checkEntryName(segment);
    if (!issue) continue;
    // A resolved path has no empty, "." or ".." segment left, and the system itself usually refuses an overlong name while the path is resolved.
    if (issue === 'empty' || issue === 'tooLong') throw new PanelError('server.files.validation.path');
    throw new PanelError(ENTRY_NAME_MESSAGES[issue], { name: segment });
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
    // Left by a save that was cut short; the next save in this directory removes them.
    .filter((entry) => !(entry.isFile() && TEXT_SAVE_TEMP_NAME.test(entry.name)))
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

/** How much of the start of a file is searched for a NUL byte, much as Git tells binary files apart. */
const BINARY_SNIFF_BYTES = 8192;

export type TextFileRead = {
  content: string;
  /**
   * A NUL byte in the first 8 KiB: the file is binary. UTF-8 text never contains one, whatever its language, and a BOM does not
   * change that. Its bytes do not survive decoding as UTF-8 (invalid ones become U+FFFD), so writing `content` back would break it.
   */
  binary: boolean;
};

export function readTextFile(instanceId: string, relativePath: string): TextFileRead {
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
  const bytes = fs.readFileSync(target);
  return {
    content: bytes.toString('utf8'),
    binary: bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0),
  };
}

type TextWriteOptions = {
  onConflict?: TextFileSaveRequest['onConflict'];
  /** Process IDs of the instance's server: a file one of them has open is written in place, see writeTextFile. */
  serverPids?: number[];
  /** Tests only: stands in for the rename that puts the new content in place. */
  renameSync?: typeof fs.renameSync;
};

/** Marks the temp files of text saves: `.<name>.mystry-save.<16 hex digits>.tmp`, beside the file being saved. */
const TEXT_SAVE_TEMP_TAG = 'mystry-save';
const TEXT_SAVE_TEMP_NAME = /^\..+\.mystry-save\.[0-9a-f]{16}\.tmp$/;

/**
 * A save runs without yielding and only one panel process uses the data directory, so every temp file still in the
 * directory after a save is a leftover. The listing hides these files and the next save retries any failed cleanup.
 */
function removeLeftoverTextSaveTemps(dir: string): void {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && TEXT_SAVE_TEMP_NAME.test(entry.name)) fs.rmSync(path.join(dir, entry.name), { force: true });
    }
  } catch {
    /* See above. */
  }
}

/**
 * Failures that mean the file cannot be replaced by a rename here, while writing into it may still work: on Windows another
 * program holds it open (a running server and its latest.log), the directory itself is not writable, or the name leaves no
 * room for the temp file's suffix. A full disk is not one of them: writing in place would then cut the file short.
 */
const REPLACE_REFUSED_CODES = ['EPERM', 'EACCES', 'EBUSY', 'ENAMETOOLONG'];

const CREATE_FALLBACK_CODES = [
  ...REPLACE_REFUSED_CODES,
  'ENOTSUP',
  'ENOSYS',
  // libuv maps ERROR_INVALID_FUNCTION to EISDIR when a Windows volume cannot create a hard link.
  ...(process.platform === 'win32' ? ['EISDIR'] : []),
];

function fileAlreadyExists(): PanelError {
  return new PanelError('server.files.alreadyExists', undefined, { statusCode: 409 });
}

function createTextFile(target: string, bytes: Buffer): void {
  try {
    if (bytes.length > 0) {
      try {
        writeFileAtomic(target, bytes, { createMode: 0o666, tempTag: TEXT_SAVE_TEMP_TAG, replaceExisting: false });
        return;
      } catch (error) {
        if (!CREATE_FALLBACK_CODES.some((code) => hasErrorCode(error, code))) throw error;
      }
    }
    // An empty file can be published immediately. On the fallback, the new file is visible during the write.
    fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o666, flush: true });
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) throw fileAlreadyExists();
    throw error;
  }
}

export function writeTextFile(
  instanceId: string,
  relativePath: string,
  content: string,
  options: TextWriteOptions = {},
): void {
  if (typeof content !== 'string') {
    throw new PanelError('server.files.text.invalidContent');
  }
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length > maxTextFileBytes) {
    throw new PanelError('server.files.text.tooLarge', { limit: maxTextFileBytes });
  }

  const root = getInstanceDir(instanceId);
  const target = resolveSafePath(root, relativePath);
  assertMutableTarget(root, target);
  let existingMode: number | undefined;
  if (fs.existsSync(target)) {
    // The create-only policy reports a folder on this path as a name conflict too.
    if (options.onConflict === 'fail') throw fileAlreadyExists();
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new PanelError('server.files.notRegularFile');
    }
    // A rename replaces a file whatever its own permissions say, so a file marked read-only is refused here, as it was when it was written in place.
    fs.accessSync(target, fs.constants.W_OK);
    existingMode = stat.mode & 0o7777;
  }
  assertCreatableNames(root, target);
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (options.onConflict === 'fail') {
    createTextFile(target, bytes);
    removeLeftoverTextSaveTemps(directory);
    return;
  }

  // Where a rename over an open file succeeds (Linux), the server would go on writing to the old file, which no longer has a
  // name: its latest.log would stop growing where anyone can read it. Such a file is written in place, which is also where
  // Windows ends up below, because it refuses the rename.
  const heldOpenByServer = existingMode !== undefined
    && (options.serverPids ?? []).some((pid) => isFileOpenInProcess(pid, target));
  try {
    if (heldOpenByServer) {
      fs.writeFileSync(target, bytes);
    } else {
      // Written beside the target and renamed over it: a panel that stops midway leaves the old file whole, not half a config file.
      // An existing file keeps its permission bits (a start script stays executable); a new one gets the usual ones.
      writeFileAtomic(target, bytes, {
        ...(existingMode === undefined ? { createMode: 0o666 } : { exactMode: existingMode }),
        tempTag: TEXT_SAVE_TEMP_TAG,
        renameSync: options.renameSync,
      });
    }
  } catch (error) {
    if (heldOpenByServer || !REPLACE_REFUSED_CODES.some((code) => hasErrorCode(error, code))) throw error;
    fs.writeFileSync(target, bytes);
  }
  removeLeftoverTextSaveTemps(directory);
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
  assertCreatableNames(root, dest);
  fs.renameSync(src, dest);
}

export function mkdirPath(instanceId: string, relativePath: string): void {
  const root = getInstanceDir(instanceId);
  const target = resolveSafePath(root, relativePath);
  assertMutableTarget(root, target);
  assertCreatableNames(root, target);
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
  // Before the upload is received, so a name that would be refused does not cost the whole transfer first.
  assertCreatableNames(root, target);
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
