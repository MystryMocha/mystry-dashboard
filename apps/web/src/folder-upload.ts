/**
 * 浏览器里选文件夹上传：把用户选的服务端文件夹分批传给面板。
 * 面板拿不到用户电脑上的路径，只收到浏览器读出来的文件和它们在文件夹里的相对路径。
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

/** 一批最多多少个文件、多大：文件数和服务端每次请求的上限对齐，大小控制在几十 MB，进度条走得比较匀。 */
export const FOLDER_BATCH_MAX_FILES = 500;
export const FOLDER_BATCH_MAX_BYTES = 64 * 1024 * 1024;
/**
 * 撞上面板的请求频率限制时等一会儿重发同一批：被限流的请求还没写任何文件，重发是安全的。
 * 12 次 × 5 秒正好盖住默认 60 秒的限流窗口。
 */
const RATE_LIMIT_RETRY_MS = 5_000;
const RATE_LIMIT_MAX_RETRIES = 12;

export type SelectedFolder = { name: string; files: FolderUploadFile[]; totalBytes: number };

/** waiting：这一批被面板暂时拒绝（如请求太频繁），正在等一会儿后重发。 */
export type FolderUploadProgress = { files: number; bytes: number; totalFiles: number; totalBytes: number; waiting: boolean };

/** 有文件读不出来：原服务器还在运行、把文件锁着，或者选完之后文件又被改了。 */
export class FolderFileUnreadableError extends Error {
  readonly relativePath: string;
  constructor(relativePath: string) {
    super(`Couldn't read ${relativePath}`);
    this.name = 'FolderFileUnreadableError';
    this.relativePath = relativePath;
  }
}

/** 上传中途和面板的连接断了（浏览器只报网络错误），这次上传已经作废。 */
export class FolderUploadInterruptedError extends Error {
  constructor(cause: unknown) {
    super('The folder upload was interrupted', { cause });
    this.name = 'FolderUploadInterruptedError';
  }
}

/**
 * 浏览器能不能选整个文件夹。桌面版 Chrome、Edge、Firefox、Safari 都可以；
 * 手机浏览器大多选不了文件夹，不显示这个入口，免得点了没反应。
 */
export function canPickFolder(): boolean {
  if (typeof document === 'undefined' || typeof navigator === 'undefined') return false;
  if (!('webkitdirectory' in document.createElement('input'))) return false;
  return !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

/** 把一组「相对路径 + 文件」整理成要上传的文件夹；路径的第一段是文件夹名，上传时去掉。 */
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

/** 文件选择框（webkitdirectory）选中的文件：webkitRelativePath 形如「文件夹名/world/level.dat」。 */
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
 * 拖进来的东西：只接受恰好一个文件夹，递归读出里面所有文件。
 * 拖进来的是文件或多个东西时返回 null，文件夹里没有文件时返回 'empty'。
 * 必须在 drop 事件里直接调用：事件结束后浏览器就不让再读拖进来的条目了（函数在第一个 await 前已把它们取出）。
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
    // readEntries 每次最多给一部分，要一直读到返回空数组。
    for (;;) {
      const batch = await new Promise<FsEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (batch.length === 0) break;
      for (const child of batch) await walk(child, `${path}/${child.name}`);
    }
  }
  await walk(roots[0], roots[0].name);
  return entries.length === 0 ? 'empty' : selectedFolderFromEntries(entries);
}

/** 按文件数和大小切成几批；比上限还大的单个文件自己一批。 */
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

/** 一批发送失败且不是面板返回的错误时，挨个读每个文件的第一个字节，找出读不出来的那个。 */
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
 * 这一批失败后能不能原样重发。面板因请求太频繁拒绝时还没写任何文件，可以重发；
 * 但请求体还没发完面板就回了 429 并断开连接，浏览器往往只报网络错误、拿不到 429。
 * 所以网络错误时先排除读不了的文件，再用查询接口（不和上传共用限流额度）问面板：
 * 这次上传还在、收到的文件数没变，说明这一批根本没被处理，可以重发。
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
 * 上传整个文件夹：开始会话 → 一批一批地发（同一时间只发一批）→ 全部发完后让面板预检。
 * 中途出错或被中止时删掉面板上这次的临时文件夹，不支持断点续传。
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
    // 剩下的是浏览器报的网络错误（如 Failed to fetch），换成能翻译的提示。
    throw new FolderUploadInterruptedError(error);
  }
}
