/**
 * 浏览器里选文件夹上传：浏览器读出用户选的服务端文件夹，分批把文件传给面板。
 *
 * 一次上传是一个会话：开始时声明文件数和总大小 → 分批接收文件 → 全部收到后预检 → 确认导入或取消。
 * 文件写在 uploads/ 下面板自己的临时目录里，服务端从不接触用户电脑上的路径；
 * 确认导入时整个临时目录改名搬进任务 staging，不再多复制一份。会话只在内存里，面板重启时清掉残留目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { nanoid } from 'nanoid';
import type {
  ConfirmZipImportInput,
  CreateFolderUploadInput,
  FolderUploadInfo,
  ServerMessageKey,
  TaskInfo,
} from '@mystry/shared';
import { config } from '../config.js';
import { createByteCounter } from '../utils/byte-counter.js';
import { hasErrorCode, PanelError } from '../utils/errors.js';
import { OWNERSHIP_MARKER_FILE, assertSafeInstanceRoot, resolveSafePath } from '../utils/path.js';
import {
  failedServerFolderCheck,
  precheckServerFolder,
  runServerFolderImport,
} from './existing-server-import-service.js';
import { normalizeAndAssertJvmArgs } from './jvm-validation-service.js';
import { runBackgroundTask } from './task-service.js';
import { STAGING_MARKER_FILE } from './task-staging-service.js';

/** 上传会话临时目录的前缀：和 ZIP 上传的 .tmp-import-* 文件分开，启动时按这个前缀清理残留。 */
export const FOLDER_UPLOAD_DIR_PREFIX = '.tmp-folder-upload-';
/** 一次请求最多带多少个文件；浏览器按这个数和大小分批发送。 */
export const FOLDER_UPLOAD_BATCH_MAX_FILES = 500;
const MAX_RELATIVE_PATH_LENGTH = 1024;
const MAX_PATH_DEPTH = 64;
const MAX_SEGMENT_LENGTH = 255;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
/** 面板自己会在实例根目录写的文件，上传的文件夹根目录里不能有同名文件。 */
const RESERVED_ROOT_FILES = [OWNERSHIP_MARKER_FILE, STAGING_MARKER_FILE].map((name) => name.toLowerCase());

/**
 * 会话状态：
 * - uploading：等下一批文件；ready：全部收到并预检过，等确认
 * - receiving：正在收一批文件或正在预检，不能同时做别的
 * - confirming：正在把导入任务排进队列
 * - cancelled：收文件途中被取消，收完这一批后删掉临时目录
 */
type SessionState = 'uploading' | 'receiving' | 'ready' | 'confirming' | 'cancelled';

type FolderUploadSession = {
  info: FolderUploadInfo;
  userId: string;
  dir: string;
  state: SessionState;
};

/** multipart 迭代器给出的一段：字段或文件。 */
export type FolderUploadPart =
  | { type: 'field'; fieldname: string; value: unknown }
  | { type: 'file'; fieldname: string; file: Readable & { truncated?: boolean } };

const sessions = new Map<string, FolderUploadSession>();
let cleanupTimer: NodeJS.Timeout | null = null;

function httpError(key: ServerMessageKey, statusCode: number, params?: Record<string, string | number>): PanelError {
  return new PanelError(key, params, { statusCode });
}

function expiresAt(now: number): string {
  return new Date(now + config.importPreviewTtlSeconds * 1000).toISOString();
}

function snapshot(session: FolderUploadSession): FolderUploadInfo {
  return { ...session.info };
}

/** 只删 uploads 下、带本模块前缀的目录，防止误删别的东西。 */
function removeSessionDir(dir: string): void {
  const uploadRoot = path.resolve(config.uploadDir);
  const resolved = path.resolve(dir);
  if (path.dirname(resolved) !== uploadRoot || !path.basename(resolved).startsWith(FOLDER_UPLOAD_DIR_PREFIX)) {
    throw new PanelError('server.files.upload.invalidTempPath');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function dropSession(session: FolderUploadSession): void {
  sessions.delete(session.info.id);
  try {
    removeSessionDir(session.dir);
  } catch {
    /* 删不掉的残留由下次启动按前缀清理。 */
  }
}

/** 等待期间 cancelFolderUpload 可能把状态改成 cancelled；单独成函数，免得类型收窄把这个检查判成恒假。 */
function wasCancelled(session: FolderUploadSession): boolean {
  return session.state === 'cancelled';
}

function findOwnedSession(id: string, userId: string, now = Date.now()): FolderUploadSession {
  const session = sessions.get(id);
  if (!session || session.userId !== userId) {
    throw httpError('server.imports.folder.notFound', 404);
  }
  const idle = session.state === 'uploading' || session.state === 'ready';
  if (idle && Date.parse(session.info.expiresAt) <= now) {
    dropSession(session);
    throw httpError('server.imports.folder.expired', 410);
  }
  return session;
}

/**
 * 浏览器给的相对路径只接受「a/b/c.txt」这种普通写法：拒绝空段、`.`、`..`、反斜杠和控制字符，
 * Windows 上再拒绝冒号等非法字符、结尾的点或空格和 CON、NUL 这类保留名，并拒绝根目录里面板保留的文件名。
 */
export function normalizeUploadRelativePath(raw: string): string {
  const invalid = () => httpError('server.imports.folder.invalidPath', 400, { path: raw.slice(0, MAX_RELATIVE_PATH_LENGTH) });
  if (raw.length === 0 || raw.length > MAX_RELATIVE_PATH_LENGTH) throw invalid();
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) throw invalid();
  const windows = process.platform === 'win32';
  if (windows && /[<>:"|?*]/.test(raw)) throw invalid();
  const segments = raw.split('/');
  if (segments.length > MAX_PATH_DEPTH) throw invalid();
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || segment.length > MAX_SEGMENT_LENGTH) throw invalid();
    if (windows && (/[. ]$/.test(segment) || WINDOWS_RESERVED_NAME.test(segment))) throw invalid();
  }
  if (segments.length === 1 && RESERVED_ROOT_FILES.includes(segments[0]!.toLowerCase())) {
    throw httpError('server.imports.folder.reservedName', 400, { path: raw });
  }
  return segments.join('/');
}

/** 把一个上传的文件流式写进会话目录；不覆盖已有文件，超过声明的总大小或空闲超时就中止。 */
async function writeUploadedFile(
  session: FolderUploadSession,
  relative: string,
  input: Readable & { truncated?: boolean },
): Promise<void> {
  const target = resolveSafePath(session.dir, relative);
  let fileBytes = 0;
  let idleTimer: NodeJS.Timeout | null = null;
  let timedOut = false;
  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      input.destroy(new PanelError('server.files.upload.idleTimeout'));
    }, config.uploadIdleTimeoutMs);
  };
  const counter = createByteCounter((chunkBytes) => {
    armIdleTimer();
    fileBytes += chunkBytes;
    return session.info.receivedBytes + fileBytes > session.info.totalBytes
      ? httpError('server.imports.folder.moreThanDeclared', 400)
      : undefined;
  });

  try {
    await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    armIdleTimer();
    await pipeline(input, counter, fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }));
  } catch (error) {
    if (timedOut) throw new PanelError('server.files.upload.idleTimeout');
    // 同一路径传了两次（Windows 上只差大小写也算），或某个文件和目录同名。
    if (hasErrorCode(error, 'EEXIST') || hasErrorCode(error, 'ENOTDIR')) {
      throw httpError('server.imports.folder.duplicatePath', 400, { path: relative });
    }
    throw error;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
  if (input.truncated) {
    throw httpError('server.imports.folder.tooLarge', 413, { limit: config.maxExistingImportBytes });
  }
  session.info.receivedBytes += fileBytes;
}

export function cleanupExpiredFolderUploads(now = Date.now()): number {
  let removed = 0;
  for (const session of [...sessions.values()]) {
    const idle = session.state === 'uploading' || session.state === 'ready';
    if (!idle || Date.parse(session.info.expiresAt) > now) continue;
    dropSession(session);
    removed += 1;
  }
  return removed;
}

function purgeOrphanFolderUploads(): number {
  fs.mkdirSync(config.uploadDir, { recursive: true, mode: 0o700 });
  const live = new Set([...sessions.values()].map((session) => path.basename(session.dir)));
  let removed = 0;
  for (const entry of fs.readdirSync(config.uploadDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(FOLDER_UPLOAD_DIR_PREFIX) || live.has(entry.name)) continue;
    removeSessionDir(path.join(config.uploadDir, entry.name));
    removed += 1;
  }
  return removed;
}

/** 面板启动时调用：清掉上次进程留下的上传临时目录，并定时清理过期会话。 */
export function initializeFolderUploads(): { purged: number } {
  if (cleanupTimer) clearInterval(cleanupTimer);
  for (const session of [...sessions.values()]) dropSession(session);
  const purged = purgeOrphanFolderUploads();
  cleanupTimer = setInterval(() => cleanupExpiredFolderUploads(), 60_000);
  cleanupTimer.unref();
  return { purged };
}

export function shutdownFolderUploads(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  for (const session of [...sessions.values()]) dropSession(session);
}

/** 开始一次文件夹上传。每个用户只保留一个会话：新开始的会替换还没确认的旧会话。 */
export function createFolderUpload(userId: string, input: CreateFolderUploadInput, now = Date.now()): FolderUploadInfo {
  cleanupExpiredFolderUploads(now);
  const folderName = input.folderName.trim();
  if (!folderName || /[\u0000-\u001f\u007f/\\]/.test(folderName)) {
    throw httpError('server.imports.folder.invalidParams', 400);
  }
  if (input.fileCount > config.maxExistingImportEntries) {
    throw httpError('server.imports.folder.tooManyFiles', 413, { limit: config.maxExistingImportEntries });
  }
  if (input.totalBytes > config.maxExistingImportBytes) {
    throw httpError('server.imports.folder.tooLarge', 413, { limit: config.maxExistingImportBytes });
  }

  const previous = [...sessions.values()].find((session) => session.userId === userId);
  if (previous && previous.state !== 'uploading' && previous.state !== 'ready') {
    throw httpError('server.imports.folder.busy', 409);
  }
  if (sessions.size - (previous ? 1 : 0) >= config.maxImportPreviews) {
    throw httpError('server.imports.folder.capacity', 429);
  }

  fs.mkdirSync(config.uploadDir, { recursive: true, mode: 0o700 });
  // 被替换的旧会话也会腾出空间，但旧会话可能还没传多少，这里按新声明的总大小直接比较。
  const stat = fs.statfsSync(config.uploadDir);
  if (BigInt(input.totalBytes) > BigInt(stat.bavail) * BigInt(stat.bsize)) {
    throw httpError('server.imports.folder.diskSpace', 507);
  }

  if (previous) dropSession(previous);
  const id = nanoid(32);
  const dir = path.join(config.uploadDir, `${FOLDER_UPLOAD_DIR_PREFIX}${id}`);
  fs.mkdirSync(dir, { mode: 0o700 });
  const session: FolderUploadSession = {
    info: {
      id,
      folderName: folderName.slice(0, 255),
      fileCount: input.fileCount,
      totalBytes: input.totalBytes,
      receivedFiles: 0,
      receivedBytes: 0,
      state: 'uploading',
      expiresAt: expiresAt(now),
    },
    userId,
    dir,
    state: 'uploading',
  };
  sessions.set(id, session);
  return snapshot(session);
}

/**
 * 接收一批文件：每个文件前面先有一个 `path` 字段给出它在文件夹里的相对路径。
 * 一批里任何一个文件出错，整个会话作废并删掉临时目录，浏览器需要从头再传。
 */
export async function receiveFolderUploadBatch(
  id: string,
  userId: string,
  parts: AsyncIterable<FolderUploadPart>,
  now = Date.now(),
): Promise<FolderUploadInfo> {
  const session = findOwnedSession(id, userId, now);
  if (session.state !== 'uploading') throw httpError('server.imports.folder.busy', 409);
  session.state = 'receiving';
  let received = false;
  try {
    let pendingPath: string | null = null;
    for await (const part of parts) {
      if (part.type === 'field') {
        if (part.fieldname !== 'path' || typeof part.value !== 'string' || pendingPath !== null) {
          throw httpError('server.imports.folder.missingPath', 400);
        }
        pendingPath = normalizeUploadRelativePath(part.value);
        continue;
      }
      if (pendingPath === null) {
        part.file.resume();
        throw httpError('server.imports.folder.missingPath', 400);
      }
      if (session.info.receivedFiles >= session.info.fileCount) {
        part.file.resume();
        throw httpError('server.imports.folder.moreThanDeclared', 400);
      }
      await writeUploadedFile(session, pendingPath, part.file);
      session.info.receivedFiles += 1;
      pendingPath = null;
    }
    if (pendingPath !== null) throw httpError('server.imports.folder.missingPath', 400);
    received = true;
  } finally {
    if (!received || wasCancelled(session)) {
      dropSession(session);
    } else {
      session.state = 'uploading';
      session.info.expiresAt = expiresAt(Date.now());
    }
  }
  if (session.state !== 'uploading') throw httpError('server.imports.folder.notFound', 404);
  return snapshot(session);
}

/** 文件全部收到后预检：找启动文件、认核心和版本、读 user_jvm_args.txt。重复调用直接返回上次的结果。 */
export async function completeFolderUpload(id: string, userId: string, now = Date.now()): Promise<FolderUploadInfo> {
  const session = findOwnedSession(id, userId, now);
  if (session.state === 'ready') return snapshot(session);
  if (session.state !== 'uploading') throw httpError('server.imports.folder.busy', 409);
  const { receivedFiles, fileCount, receivedBytes, totalBytes } = session.info;
  if (receivedFiles !== fileCount || receivedBytes !== totalBytes) {
    throw httpError('server.imports.folder.incomplete', 409, { received: receivedFiles, total: fileCount });
  }

  session.state = 'receiving';
  let check: FolderUploadInfo['check'];
  try {
    check = await precheckServerFolder(assertSafeInstanceRoot(session.dir));
  } catch (error) {
    check = failedServerFolderCheck(error);
  }
  if (wasCancelled(session)) {
    dropSession(session);
    throw httpError('server.imports.folder.notFound', 404);
  }
  session.state = 'ready';
  session.info = { ...session.info, state: 'ready', check, expiresAt: expiresAt(Date.now()) };
  return snapshot(session);
}

export function getFolderUpload(id: string, userId: string, now = Date.now()): FolderUploadInfo {
  return snapshot(findOwnedSession(id, userId, now));
}

export function cancelFolderUpload(id: string, userId: string, now = Date.now()): void {
  const session = findOwnedSession(id, userId, now);
  if (session.state === 'confirming') throw httpError('server.imports.folder.cancelWhileConfirming', 409);
  if (session.state === 'receiving') {
    // 正在收的那一批结束时会看到这个状态并删掉临时目录。
    session.state = 'cancelled';
    sessions.delete(id);
    return;
  }
  dropSession(session);
}

/** 确认导入：排进后台任务，任务把临时目录整个搬进 staging。任务队列满时保留会话，可以稍后再确认。 */
export async function confirmFolderUpload(
  id: string,
  userId: string,
  input: ConfirmZipImportInput,
  now = Date.now(),
): Promise<TaskInfo> {
  const session = findOwnedSession(id, userId, now);
  if (session.state !== 'ready') throw httpError('server.imports.folder.busy', 409);
  if (!session.info.check?.ready) throw httpError('server.imports.folder.notReady', 409);
  const jvmArgs = normalizeAndAssertJvmArgs(input.jvmArgs ?? '-Xms1G -Xmx2G', {
    coreType: input.coreType,
    javaRuntimeId: input.javaRuntimeId,
  });

  session.state = 'confirming';
  const dir = session.dir;
  try {
    const task = await runBackgroundTask('import', { key: 'server.imports.folder.task.queued' }, async (taskId, signal, report) => {
      try {
        return await runServerFolderImport(taskId, signal, report, { ...input, jvmArgs }, {
          transfer: 'move',
          resolveRoot: () => dir,
        });
      } finally {
        // 搬进 staging 后这里已经不存在；检查失败或任务被中止、没搬成时删掉上传的临时目录。
        try {
          removeSessionDir(dir);
        } catch {
          /* 残留由下次启动按前缀清理。 */
        }
      }
    });
    sessions.delete(id);
    return task;
  } catch (error) {
    session.state = 'ready';
    throw error;
  }
}

/** 测试用：清空内存里的会话，不动磁盘。 */
export function resetFolderUploadsForTests(): void {
  sessions.clear();
}
