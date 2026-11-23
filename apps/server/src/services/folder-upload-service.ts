/**
 * Folder upload from the browser: the browser reads the server folder the user picked and sends the files to the panel in batches.
 *
 * One upload is one session: declare the file count and total size at the start → receive files in batches → precheck once everything is received → confirm the import or cancel.
 * Files are written into the panel's own temp directory under uploads/, and the server never touches paths on the user's computer;
 * on confirming the import the whole temp directory is renamed into the task staging, without making another copy. Sessions live only in memory, and leftover directories are cleaned up when the panel restarts.
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

/** Prefix of upload session temp directories: kept apart from the ZIP upload's .tmp-import-* files, and leftovers are cleaned up by this prefix at startup. */
export const FOLDER_UPLOAD_DIR_PREFIX = '.tmp-folder-upload-';
/** Maximum number of files per request; the browser sends in batches by this number and by size. */
export const FOLDER_UPLOAD_BATCH_MAX_FILES = 500;
const MAX_RELATIVE_PATH_LENGTH = 1024;
const MAX_PATH_DEPTH = 64;
const MAX_SEGMENT_LENGTH = 255;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
/** Files the panel itself writes into the instance root; the root of an uploaded folder must not contain files with the same names. */
const RESERVED_ROOT_FILES = [OWNERSHIP_MARKER_FILE, STAGING_MARKER_FILE].map((name) => name.toLowerCase());

/**
 * Session states:
 * - uploading: waiting for the next batch of files; ready: everything received and prechecked, waiting for confirmation
 * - receiving: receiving a batch of files or prechecking, and nothing else can be done at the same time
 * - confirming: queuing the import task
 * - cancelled: cancelled while receiving files; the temp directory is deleted after this batch is received
 */
type SessionState = 'uploading' | 'receiving' | 'ready' | 'confirming' | 'cancelled';

type FolderUploadSession = {
  info: FolderUploadInfo;
  userId: string;
  dir: string;
  state: SessionState;
};

/** One part yielded by the multipart iterator: a field or a file. */
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

/** Deletes only directories under uploads that carry this module's prefix, so nothing else is deleted by mistake. */
function assertSessionDir(dir: string): string {
  const uploadRoot = path.resolve(config.uploadDir);
  const resolved = path.resolve(dir);
  if (path.dirname(resolved) !== uploadRoot || !path.basename(resolved).startsWith(FOLDER_UPLOAD_DIR_PREFIX)) {
    throw new PanelError('server.files.upload.invalidTempPath');
  }
  return resolved;
}

/**
 * An uploaded folder can hold as many files as a whole server, so while the panel is serving requests the removal is awaited
 * rather than done with rmSync, which would hold every request and all console output until it finished.
 */
async function removeSessionDir(dir: string): Promise<void> {
  await fs.promises.rm(assertSessionDir(dir), { recursive: true, force: true });
}

/** Startup and shutdown only: the panel is not serving requests, and the caller needs the directory gone before it goes on. */
function removeSessionDirSync(dir: string): void {
  fs.rmSync(assertSessionDir(dir), { recursive: true, force: true });
}

/** The session leaves the map before the first await, so no other request can find it while its directory is being removed. */
async function dropSession(session: FolderUploadSession): Promise<void> {
  sessions.delete(session.info.id);
  try {
    await removeSessionDir(session.dir);
  } catch {
    /* Leftovers that cannot be deleted are cleaned up by prefix at the next start. */
  }
}

function dropSessionSync(session: FolderUploadSession): void {
  sessions.delete(session.info.id);
  try {
    removeSessionDirSync(session.dir);
  } catch {
    /* Leftovers that cannot be deleted are cleaned up by prefix at the next start. */
  }
}

/** cancelFolderUpload may change the state to cancelled while waiting; this is a separate function so type narrowing does not judge the check as always false. */
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
    // Not awaited: the session is already out of the map and nothing else uses its directory, so the 410 need not wait for the removal.
    void dropSession(session);
    throw httpError('server.imports.folder.expired', 410);
  }
  return session;
}

/**
 * Relative paths given by the browser are accepted only in the ordinary "a/b/c.txt" form: empty segments, `.`, `..`, backslashes and control characters are rejected,
 * on Windows also illegal characters such as colons, trailing dots or spaces and reserved names like CON and NUL, plus file names the panel reserves in the root.
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

/** Streams one uploaded file into the session directory; existing files are not overwritten, and it aborts when the declared total size is exceeded or on idle timeout. */
async function writeUploadedFile(
  session: FolderUploadSession,
  relative: string,
  input: Readable & { truncated?: boolean },
): Promise<void> {
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
    // The path check goes in here too: when the parent is already a file, the check itself fails with ENOTDIR on Linux (Windows reports ENOENT and fails only when creating the directory).
    const target = resolveSafePath(session.dir, relative);
    await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    armIdleTimer();
    await pipeline(input, counter, fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }));
  } catch (error) {
    if (timedOut) throw new PanelError('server.files.upload.idleTimeout');
    // The same path was sent twice (differing only in case also counts on Windows), or a file and a directory share a name.
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

/** Every expired session leaves the map before the first await; the promise settles once their directories are gone. */
export async function cleanupExpiredFolderUploads(now = Date.now()): Promise<number> {
  const removals: Promise<void>[] = [];
  for (const session of [...sessions.values()]) {
    const idle = session.state === 'uploading' || session.state === 'ready';
    if (!idle || Date.parse(session.info.expiresAt) > now) continue;
    removals.push(dropSession(session));
  }
  await Promise.all(removals);
  return removals.length;
}

function purgeOrphanFolderUploads(): number {
  fs.mkdirSync(config.uploadDir, { recursive: true, mode: 0o700 });
  const live = new Set([...sessions.values()].map((session) => path.basename(session.dir)));
  let removed = 0;
  for (const entry of fs.readdirSync(config.uploadDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(FOLDER_UPLOAD_DIR_PREFIX) || live.has(entry.name)) continue;
    removeSessionDirSync(path.join(config.uploadDir, entry.name));
    removed += 1;
  }
  return removed;
}

/** Called at panel startup: cleans up upload temp directories left by the previous process, and periodically cleans up expired sessions. */
export function initializeFolderUploads(): { purged: number } {
  if (cleanupTimer) clearInterval(cleanupTimer);
  for (const session of [...sessions.values()]) dropSessionSync(session);
  const purged = purgeOrphanFolderUploads();
  cleanupTimer = setInterval(() => void cleanupExpiredFolderUploads(), 60_000);
  cleanupTimer.unref();
  return { purged };
}

export function shutdownFolderUploads(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  for (const session of [...sessions.values()]) dropSessionSync(session);
}

/** Starts a folder upload. Only one session is kept per user: a newly started one replaces an old session that has not been confirmed. */
export async function createFolderUpload(
  userId: string,
  input: CreateFolderUploadInput,
  now = Date.now(),
): Promise<FolderUploadInfo> {
  // Waited for so the space of expired uploads is free again before the disk space check below. Nothing may be awaited
  // between here and the registration of the new session, see the comment further down.
  await cleanupExpiredFolderUploads(now);
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
  // The replaced old session frees space too, but it may not have uploaded much yet, so the newly declared total size is compared directly here.
  const stat = fs.statfsSync(config.uploadDir);
  if (BigInt(input.totalBytes) > BigInt(stat.bavail) * BigInt(stat.bsize)) {
    throw httpError('server.imports.folder.diskSpace', 507);
  }

  // The old session leaves the map here and the new one is registered below before anything is awaited, so two requests from
  // the same user cannot both end up holding a session. Only the removal of the old directory is waited for, at the end.
  const previousRemoved = previous ? dropSession(previous) : undefined;
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
  const created = snapshot(session);
  await previousRemoved;
  return created;
}

/**
 * Receives a batch of files: before each file comes a `path` field giving its relative path in the folder.
 * If any file in a batch fails, the whole session is voided and the temp directory deleted, and the browser has to upload again from the start.
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
      await dropSession(session);
    } else {
      session.state = 'uploading';
      session.info.expiresAt = expiresAt(Date.now());
    }
  }
  if (session.state !== 'uploading') throw httpError('server.imports.folder.notFound', 404);
  return snapshot(session);
}

/** Prechecks once all files are received: finds the launch file, recognizes the core and version, and reads user_jvm_args.txt. Repeated calls return the previous result directly. */
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
    await dropSession(session);
    throw httpError('server.imports.folder.notFound', 404);
  }
  session.state = 'ready';
  session.info = { ...session.info, state: 'ready', check, expiresAt: expiresAt(Date.now()) };
  return snapshot(session);
}

export function getFolderUpload(id: string, userId: string, now = Date.now()): FolderUploadInfo {
  return snapshot(findOwnedSession(id, userId, now));
}

export async function cancelFolderUpload(id: string, userId: string, now = Date.now()): Promise<void> {
  const session = findOwnedSession(id, userId, now);
  if (session.state === 'confirming') throw httpError('server.imports.folder.cancelWhileConfirming', 409);
  if (session.state === 'receiving') {
    // The batch being received sees this state when it ends and deletes the temp directory.
    session.state = 'cancelled';
    sessions.delete(id);
    return;
  }
  await dropSession(session);
}

/** Confirms the import: queues a background task that moves the whole temp directory into staging. When the task queue is full the session is kept and can be confirmed again later. */
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
        // After being moved into staging it no longer exists here; delete the uploaded temp directory when the check fails, or the task is aborted and the move did not happen.
        try {
          await removeSessionDir(dir);
        } catch {
          /* Leftovers are cleaned up by prefix at the next start. */
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

/** For tests: clears the in-memory sessions without touching the disk. */
export function resetFolderUploadsForTests(): void {
  sessions.clear();
}
