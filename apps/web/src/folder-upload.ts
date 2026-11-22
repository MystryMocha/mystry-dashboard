/**
 * Folder upload from the browser: sends the server folder the user picked to the panel in batches.
 * The panel cannot get paths on the user's computer; it only receives the files the browser read and their relative paths within the folder.
 */
import type { FolderUploadInfo } from '@mystry/shared';
import {
  ApiError,
  cancelFolderUpload,
  completeFolderUpload,
  createFolderUpload,
  getFolderUpload,
  uploadFolderBatch,
  type FolderUploadFile,
} from './api';
import { isAbortError } from './errors';

/** Maximum files and size per batch: the file count matches the server's per-request limit, and the size is kept to tens of MB so the progress bar moves fairly evenly. */
export const FOLDER_BATCH_MAX_FILES = 500;
export const FOLDER_BATCH_MAX_BYTES = 64 * 1024 * 1024;
/**
 * When the panel's request rate limit is hit, wait a while and resend the same batch: a rate-limited request has not written any file yet, so resending is safe.
 * 12 attempts × 5 seconds exactly covers the default 60-second rate limit window.
 */
const RATE_LIMIT_RETRY_MS = 5_000;
const RATE_LIMIT_MAX_RETRIES = 12;

export type SelectedFolder = { name: string; files: FolderUploadFile[]; totalBytes: number };

/** waiting: this batch was temporarily refused by the panel (such as too many requests) and will be resent after a short wait. */
export type FolderUploadProgress = { files: number; bytes: number; totalFiles: number; totalBytes: number; waiting: boolean };

/** A file cannot be read: the original server is still running and holds it locked, or the file was changed after being picked. */
export class FolderFileUnreadableError extends Error {
  readonly relativePath: string;
  constructor(relativePath: string) {
    super(`Couldn't read ${relativePath}`);
    this.name = 'FolderFileUnreadableError';
    this.relativePath = relativePath;
  }
}

/** The connection to the panel dropped mid-upload (the browser only reports a network error), and this upload is void. */
export class FolderUploadInterruptedError extends Error {
  constructor(cause: unknown) {
    super('The folder upload was interrupted', { cause });
    this.name = 'FolderUploadInterruptedError';
  }
}

/**
 * Whether the browser can pick a whole folder. Desktop Chrome, Edge, Firefox and Safari all can;
 * most mobile browsers cannot pick folders, so the entry is not shown there, rather than doing nothing when tapped.
 */
export function canPickFolder(): boolean {
  if (typeof document === 'undefined' || typeof navigator === 'undefined') return false;
  if (!('webkitdirectory' in document.createElement('input'))) return false;
  return !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

/** Arranges a set of "relative path + file" into the folder to upload; the first path segment is the folder name and is removed on upload. */
export function selectedFolderFromEntries(entries: Array<{ file: File; path: string }>): SelectedFolder | null {
  if (entries.length === 0) return null;
  const [folderName] = entries[0]!.path.split('/');
  const files: FolderUploadFile[] = [];
  let totalBytes = 0;
  for (const { file, path } of entries) {
    const segments = path.split('/');
    if (segments.length < 2 || segments[0] !== folderName) return null;
    files.push({ file, relativePath: segments.slice(1).join('/') });
    totalBytes += file.size;
  }
  return { name: folderName!, files, totalBytes };
}

/** Files chosen in the file picker (webkitdirectory): webkitRelativePath looks like "folder name/world/level.dat". */
export function selectedFolderFromFileList(list: FileList | File[]): SelectedFolder | null {
  return selectedFolderFromEntries([...list].map((file) => ({ file, path: file.webkitRelativePath || file.name })));
}

type FsEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (success: (file: File) => void, failure: (error: unknown) => void) => void;
  createReader?: () => { readEntries: (success: (entries: FsEntry[]) => void, failure: (error: unknown) => void) => void };
};

/**
 * Things dragged in: only exactly one folder is accepted, and all files inside are read recursively.
 * Returns null when a file or several things were dragged in, and 'empty' when the folder contains no files.
 * Must be called directly in the drop event: once the event ends the browser no longer allows reading the dragged entries (the function takes them out before its first await).
 */
export async function selectedFolderFromDrop(items: DataTransferItemList): Promise<SelectedFolder | 'empty' | null> {
  const roots = [...items]
    .filter((item) => item.kind === 'file')
    .map((item) => (item as DataTransferItem & { webkitGetAsEntry?: () => FsEntry | null }).webkitGetAsEntry?.() ?? null);
  if (roots.length !== 1 || !roots[0]?.isDirectory) return null;

  const entries: Array<{ file: File; path: string }> = [];
  async function walk(entry: FsEntry, path: string): Promise<void> {
    if (entry.isFile && entry.file) {
      const file = await new Promise<File>((resolve, reject) => entry.file!(resolve, reject));
      entries.push({ file, path });
      return;
    }
    if (!entry.isDirectory || !entry.createReader) return;
    const reader = entry.createReader();
    // readEntries returns only part each time, so keep reading until it returns an empty array.
    for (;;) {
      const batch = await new Promise<FsEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (batch.length === 0) break;
      for (const child of batch) await walk(child, `${path}/${child.name}`);
    }
  }
  await walk(roots[0], roots[0].name);
  return entries.length === 0 ? 'empty' : selectedFolderFromEntries(entries);
}

/** Splits into batches by file count and size; a single file larger than the limit gets a batch of its own. */
export function batchFolderFiles(
  files: FolderUploadFile[],
  maxFiles = FOLDER_BATCH_MAX_FILES,
  maxBytes = FOLDER_BATCH_MAX_BYTES,
): FolderUploadFile[][] {
  const batches: FolderUploadFile[][] = [];
  let current: FolderUploadFile[] = [];
  let currentBytes = 0;
  for (const item of files) {
    if (current.length > 0 && (current.length >= maxFiles || currentBytes + item.file.size > maxBytes)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += item.file.size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

function isRateLimited(error: unknown): boolean {
  return error instanceof ApiError && error.status === 429 && error.messageI18n?.key === 'server.common.tooManyRequests';
}

/** When a batch fails to send and it is not an error returned by the panel, reads the first byte of each file in turn to find the one that cannot be read. */
async function findUnreadableFile(batch: FolderUploadFile[]): Promise<string | null> {
  for (const { file, relativePath } of batch) {
    try {
      await file.slice(0, 1).arrayBuffer();
    } catch {
      return relativePath;
    }
  }
  return null;
}

/**
 * Whether this batch can be resent as is after failing. When the panel refuses for too many requests it has not written any file yet, so resending is fine;
 * but when the panel answers 429 and disconnects before the request body is fully sent, the browser often reports only a network error and never sees the 429.
 * So on a network error, unreadable files are ruled out first, then the query endpoint (which does not share the rate limit quota with uploads) is asked:
 * if this upload still exists and the received file count is unchanged, this batch was never processed and can be resent.
 */
async function canResendBatch(
  error: unknown,
  uploadId: string,
  batch: FolderUploadFile[],
  receivedBefore: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (isRateLimited(error)) return true;
  if (isAbortError(error) || error instanceof ApiError) return false;
  const unreadable = await findUnreadableFile(batch);
  if (unreadable) throw new FolderFileUnreadableError(unreadable);
  const info = await getFolderUpload(uploadId, signal).catch(() => null);
  return info?.state === 'uploading' && info.receivedFiles === receivedBefore;
}

/**
 * Uploads a whole folder: start a session → send batch by batch (only one batch at a time) → have the panel precheck once everything is sent.
 * On an error or abort midway, this upload's temp folder on the panel is deleted; resuming is not supported.
 */
export async function uploadFolder(
  folder: SelectedFolder,
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: FolderUploadProgress) => void;
  } = {},
): Promise<FolderUploadInfo> {
  const { signal, onProgress } = options;
  const created = await createFolderUpload({
    folderName: folder.name,
    fileCount: folder.files.length,
    totalBytes: folder.totalBytes,
  }, signal);
  const progress: FolderUploadProgress = {
    files: 0,
    bytes: 0,
    totalFiles: folder.files.length,
    totalBytes: folder.totalBytes,
    waiting: false,
  };
  onProgress?.({ ...progress });
  let currentBatch: FolderUploadFile[] = [];
  try {
    for (const batch of batchFolderFiles(folder.files)) {
      currentBatch = batch;
      for (let attempt = 0; ; attempt += 1) {
        try {
          await uploadFolderBatch(created.id, batch, signal);
          break;
        } catch (error) {
          if (attempt >= RATE_LIMIT_MAX_RETRIES || !(await canResendBatch(error, created.id, batch, progress.files, signal))) {
            throw error;
          }
          onProgress?.({ ...progress, waiting: true });
          await wait(RATE_LIMIT_RETRY_MS, signal);
        }
      }
      progress.files += batch.length;
      progress.bytes += batch.reduce((sum, item) => sum + item.file.size, 0);
      onProgress?.({ ...progress });
    }
    currentBatch = [];
    return await completeFolderUpload(created.id, signal);
  } catch (error) {
    void cancelFolderUpload(created.id).catch(() => undefined);
    if (isAbortError(error) || error instanceof ApiError || error instanceof FolderFileUnreadableError) throw error;
    if (currentBatch.length > 0) {
      const unreadable = await findUnreadableFile(currentBatch);
      if (unreadable) throw new FolderFileUnreadableError(unreadable);
    }
    // What remains is a network error reported by the browser (such as Failed to fetch), replaced with a translatable message.
    throw new FolderUploadInterruptedError(error);
  }
}
