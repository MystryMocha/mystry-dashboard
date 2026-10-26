import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { constants as zlibConstants, createGunzip, createGzip } from 'node:zlib';
import type { CoreType } from '@mystry/shared';
import { OWNERSHIP_MARKER_FILE, resolveSafePath } from '../utils/path.js';
import { STAGING_MARKER_FILE } from './task-staging-service.js';
import { abortError, isPanelError, PanelError, throwIfAborted } from '../utils/errors.js';

/**
 * 实例备份归档：gzip 压缩的 POSIX tar（ustar + pax 扩展头），最后一个条目是清单
 * `.mystry-backup/manifest.json`，记录每个文件的大小与 SHA-256。
 * 不用 ZIP：现有 ZIP 读取器不支持 ZIP64，世界存档很容易超过 4 GiB 或 65535 个条目。
 * 读写都是流式的，只在内存里保留清单。
 */

export const BACKUP_FORMAT = 'mystry-backup';
export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_MANIFEST_DIR = '.mystry-backup';
export const BACKUP_MANIFEST_PATH = `${BACKUP_MANIFEST_DIR}/manifest.json`;

const BLOCK = 512;
/** ustar 头部 size 字段（11 位八进制）能表示的最大值，超过时改用 pax size 记录。 */
const MAX_USTAR_SIZE = 0o77777777777;
const MAX_PAX_HEADER_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

export type BackupManifestFile = { path: string; size: number; sha256: string };

export type BackupManifest = {
  format: typeof BACKUP_FORMAT;
  version: number;
  createdAt: string;
  instance: {
    id: string;
    name: string;
    coreType: CoreType | null;
    mcVersion: string | null;
    jarFile: string | null;
  };
  wasRunning: boolean;
  directories: string[];
  files: BackupManifestFile[];
};

export type BackupManifestHeader = Omit<BackupManifest, 'format' | 'version' | 'directories' | 'files'>;

/** 待归档条目：相对实例根目录的 POSIX 路径；文件带上扫描时的大小与绝对路径。 */
export type BackupSourceEntry =
  | { kind: 'dir'; path: string; mtimeMs: number }
  | { kind: 'file'; path: string; absolute: string; size: number; mtimeMs: number };

export type BackupArchiveLimits = { maxEntries: number; maxBytes: number };

function comparableKey(relativePath: string): string {
  return process.platform === 'win32' ? relativePath.toLowerCase() : relativePath;
}

/** 归档内路径规范化：拒绝绝对路径、盘符、`..`、NUL 和空路径，统一为不带首尾斜杠的 POSIX 路径。 */
export function normalizeArchivePath(name: string): string {
  if (!name || name.includes('\0')) throw new PanelError('server.backups.archive.unsafePath', { name: name.replace(/\0/g, '') });
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new PanelError('server.backups.archive.unsafePath', { name });
  }
  const parts = normalized.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..')) throw new PanelError('server.backups.archive.unsafePath', { name });
  if (parts.length === 0) throw new PanelError('server.backups.archive.unsafePath', { name });
  return parts.join('/');
}

/** 面板自己维护的文件不进入备份，也不允许从备份写回。 */
export function isReservedArchivePath(relativePath: string): boolean {
  const key = comparableKey(relativePath);
  const reserved = [OWNERSHIP_MARKER_FILE, STAGING_MARKER_FILE].map(comparableKey);
  if (reserved.includes(key)) return true;
  const manifestDir = comparableKey(BACKUP_MANIFEST_DIR);
  return key === manifestDir || key.startsWith(`${manifestDir}/`);
}

// ---------------------------------------------------------------------------
// 写入

function writeString(block: Buffer, offset: number, length: number, value: string | Buffer): void {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  bytes.copy(block, offset, 0, Math.min(bytes.length, length));
}

function writeOctal(block: Buffer, offset: number, length: number, value: number): void {
  // 末尾保留一个 NUL；值已由调用方保证不超过字段宽度。
  const digits = Math.floor(value).toString(8).padStart(length - 1, '0');
  writeString(block, offset, length, `${digits}\0`);
}

function tarHeader(name: Buffer, size: number, type: '0' | '5' | 'x', mtimeMs: number): Buffer {
  const block = Buffer.alloc(BLOCK);
  writeString(block, 0, 100, name);
  writeOctal(block, 100, 8, type === '5' ? 0o755 : 0o644);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, Math.min(size, MAX_USTAR_SIZE));
  writeOctal(block, 136, 12, Math.max(0, Math.floor(mtimeMs / 1000)));
  block.fill(0x20, 148, 156);
  writeString(block, 156, 1, type);
  writeString(block, 257, 6, 'ustar\0');
  writeString(block, 263, 2, '00');
  let checksum = 0;
  for (const byte of block) checksum += byte;
  writeString(block, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return block;
}

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  let length = bodyBytes + 1;
  while (String(length).length + bodyBytes !== length) length += 1;
  return Buffer.from(`${length}${body}`, 'utf8');
}

function paddingFor(size: number): Buffer {
  const remainder = size % BLOCK;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - remainder);
}

/** 条目头：路径超过 100 字节或文件超过 8 GiB 时先写 pax 扩展头。 */
function entryHeaders(relativePath: string, size: number, type: '0' | '5', mtimeMs: number): Buffer[] {
  const name = type === '5' ? `${relativePath}/` : relativePath;
  const nameBytes = Buffer.from(name, 'utf8');
  const records: Buffer[] = [];
  if (nameBytes.length > 100) records.push(paxRecord('path', name));
  if (size > MAX_USTAR_SIZE) records.push(paxRecord('size', String(size)));
  const headers: Buffer[] = [];
  if (records.length > 0) {
    const pax = Buffer.concat(records);
    headers.push(tarHeader(Buffer.from('PaxHeader', 'utf8'), pax.length, 'x', mtimeMs), pax, paddingFor(pax.length));
  }
  // pax 记录优先；ustar name 字段只放前 100 字节作为兼容提示。
  headers.push(tarHeader(nameBytes.subarray(0, 100), size, type, mtimeMs));
  return headers;
}

async function openRegularFile(absolute: string): Promise<FileHandle> {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const handle = await fsp.open(absolute, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new PanelError('server.backups.fileChanged', { name: path.basename(absolute) });
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function* archiveChunks(
  entries: readonly BackupSourceEntry[],
  header: BackupManifestHeader,
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void,
  manifestOut: { value: BackupManifest | null },
): AsyncGenerator<Buffer> {
  const files: BackupManifestFile[] = [];
  const directories: string[] = [];
  const totalFiles = entries.filter((entry) => entry.kind === 'file').length;
  for (const entry of entries) {
    throwIfAborted(signal);
    if (entry.kind === 'dir') {
      directories.push(entry.path);
      yield* entryHeaders(entry.path, 0, '5', entry.mtimeMs);
      continue;
    }
    yield* entryHeaders(entry.path, entry.size, '0', entry.mtimeMs);
    const hash = createHash('sha256');
    let read = 0;
    if (entry.size > 0) {
      const handle = await openRegularFile(entry.absolute);
      const stream = handle.createReadStream({ start: 0, end: entry.size - 1, autoClose: true });
      try {
        for await (const chunk of stream as AsyncIterable<Buffer>) {
          throwIfAborted(signal);
          hash.update(chunk);
          read += chunk.length;
          yield chunk;
        }
      } finally {
        stream.destroy();
      }
    }
    if (read !== entry.size) {
      // 文件在扫描后被截短：头部大小已写出，只能放弃这次备份。
      throw new PanelError('server.backups.fileChanged', { name: entry.path });
    }
    yield paddingFor(entry.size);
    files.push({ path: entry.path, size: entry.size, sha256: hash.digest('hex') });
    onProgress(files.length, totalFiles);
  }

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_FORMAT_VERSION,
    ...header,
    directories,
    files,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8');
  yield* entryHeaders(BACKUP_MANIFEST_PATH, manifestBytes.length, '0', Date.parse(header.createdAt) || Date.now());
  yield manifestBytes;
  yield paddingFor(manifestBytes.length);
  // 归档结束标记：两个全零块。
  yield Buffer.alloc(BLOCK * 2);
  manifestOut.value = manifest;
}

export type WrittenBackupArchive = { sizeBytes: number; sha256: string; manifest: BackupManifest };

/** 把条目写成 .tar.gz；output 必须是尚不存在的临时文件，失败时由调用方删除。 */
export async function writeBackupArchive(options: {
  output: string;
  entries: readonly BackupSourceEntry[];
  header: BackupManifestHeader;
  signal: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}): Promise<WrittenBackupArchive> {
  const archiveHash = createHash('sha256');
  let sizeBytes = 0;
  const hashCounter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      archiveHash.update(chunk);
      sizeBytes += chunk.length;
      callback(null, chunk);
    },
  });
  const manifestOut: { value: BackupManifest | null } = { value: null };
  await pipeline(
    Readable.from(archiveChunks(options.entries, options.header, options.signal, options.onProgress ?? (() => {}), manifestOut)),
    // 世界区块文件本身已压缩，用最快级别换取速度；配置和日志等文本仍能明显变小。
    createGzip({ level: zlibConstants.Z_BEST_SPEED }),
    hashCounter,
    fs.createWriteStream(options.output, { flags: 'wx', mode: 0o600 }),
    { signal: options.signal },
  );
  if (!manifestOut.value) throw new PanelError('server.backups.archive.manifestMissing');
  return { sizeBytes, sha256: archiveHash.digest('hex'), manifest: manifestOut.value };
}

// ---------------------------------------------------------------------------
// 读取与校验

/** 顺序字节队列：tar 头部按块取，文件数据按可用量流式取出。 */
class ByteQueue {
  private chunks: Buffer[] = [];
  length = 0;

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  take(size: number): Buffer {
    const parts: Buffer[] = [];
    let needed = size;
    while (needed > 0) {
      const head = this.chunks[0]!;
      if (head.length <= needed) {
        parts.push(head);
        this.chunks.shift();
        needed -= head.length;
      } else {
        parts.push(head.subarray(0, needed));
        this.chunks[0] = head.subarray(needed);
        needed = 0;
      }
    }
    this.length -= size;
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts, size);
  }

  takeUpTo(size: number): Buffer {
    return this.take(Math.min(size, this.chunks[0]?.length ?? 0, this.length));
  }
}

function readString(block: Buffer, offset: number, length: number): string {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8');
}

function readNumeric(block: Buffer, offset: number, length: number): number {
  const field = block.subarray(offset, offset + length);
  if ((field[0]! & 0x80) !== 0) {
    // GNU base-256：首字节最高位为 1，其余为大端整数。
    let value = field[0]! & 0x7f;
    for (let index = 1; index < field.length; index += 1) value = value * 256 + field[index]!;
    if (!Number.isSafeInteger(value)) throw new PanelError('server.backups.archive.corrupted');
    return value;
  }
  const text = readString(block, offset, length).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new PanelError('server.backups.archive.corrupted');
  return parseInt(text, 8);
}

function verifyHeaderChecksum(block: Buffer): void {
  const expected = readNumeric(block, 148, 8);
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : block[index]!;
  }
  if (sum !== expected) throw new PanelError('server.backups.archive.corrupted');
}

function parsePaxRecords(data: Buffer): { path?: string; size?: number } {
  const result: { path?: string; size?: number } = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) throw new PanelError('server.backups.archive.corrupted');
    const length = Number(data.subarray(offset, space).toString('ascii'));
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > data.length) {
      throw new PanelError('server.backups.archive.corrupted');
    }
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals === -1) throw new PanelError('server.backups.archive.corrupted');
    const key = record.slice(0, equals);
    const value = record.slice(equals + 1);
    if (key === 'path') result.path = value;
    if (key === 'size') {
      const size = Number(value);
      if (!Number.isSafeInteger(size) || size < 0) throw new PanelError('server.backups.archive.corrupted');
      result.size = size;
    }
    offset += length;
  }
  return result;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function parseManifest(raw: Buffer): BackupManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new PanelError('server.backups.archive.manifestInvalid');
  }
  const value = parsed as Partial<BackupManifest> | null;
  if (!value || typeof value !== 'object' || value.format !== BACKUP_FORMAT || typeof value.version !== 'number') {
    throw new PanelError('server.backups.archive.manifestInvalid');
  }
  if (value.version !== BACKUP_FORMAT_VERSION) {
    throw new PanelError('server.backups.archive.versionUnsupported', { version: value.version });
  }
  const instance = value.instance;
  if (
    !instance || typeof instance !== 'object'
    || typeof instance.id !== 'string' || typeof instance.name !== 'string'
    || !Array.isArray(value.files) || !Array.isArray(value.directories)
    || typeof value.createdAt !== 'string' || typeof value.wasRunning !== 'boolean'
  ) {
    throw new PanelError('server.backups.archive.manifestInvalid');
  }
  for (const file of value.files) {
    if (
      !file || typeof file.path !== 'string' || !Number.isSafeInteger(file.size) || file.size < 0
      || typeof file.sha256 !== 'string' || !SHA256_PATTERN.test(file.sha256)
      || normalizeArchivePath(file.path) !== file.path
    ) {
      throw new PanelError('server.backups.archive.manifestInvalid');
    }
  }
  for (const directory of value.directories) {
    if (typeof directory !== 'string' || normalizeArchivePath(directory) !== directory) {
      throw new PanelError('server.backups.archive.manifestInvalid');
    }
  }
  return value as BackupManifest;
}

function waitForDrain(stream: Writable, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off('drain', onDrain);
      stream.off('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    stream.once('drain', onDrain);
    stream.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function closeWriteStream(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once('error', reject);
    stream.end(() => resolve());
  });
}

type PendingFile = {
  path: string;
  remaining: number;
  size: number;
  mtimeMs: number;
  hash: ReturnType<typeof createHash> | null;
  manifestChunks: Buffer[] | null;
  output: fs.WriteStream | null;
  target: string | null;
};

export type ReadBackupArchiveResult = {
  manifest: BackupManifest;
  fileCount: number;
  contentBytes: number;
  /** 备份文件本身（压缩后）的字节数与 SHA-256。 */
  archiveBytes: number;
  archiveSha256: string;
};

/**
 * 流式读取并校验备份：路径安全、条目类型、数量与大小配额、逐文件 SHA-256 与清单一致。
 * 传入 destination 时同时把文件解压到该目录（必须是新建的空 staging 目录）；不传只校验。
 */
export async function readBackupArchive(options: {
  archive: string;
  limits: BackupArchiveLimits;
  signal: AbortSignal;
  destination?: string;
  onProgress?: (filesDone: number) => void;
}): Promise<ReadBackupArchiveResult> {
  const { signal, limits, destination } = options;
  throwIfAborted(signal);
  const source = fs.createReadStream(options.archive);
  const gunzip = createGunzip();
  const archiveHash = createHash('sha256');
  let archiveBytes = 0;
  const archiveCounter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      archiveHash.update(chunk);
      archiveBytes += chunk.length;
      callback(null, chunk);
    },
  });
  source.on('error', (error) => gunzip.destroy(error));
  archiveCounter.on('error', (error) => gunzip.destroy(error));
  source.pipe(archiveCounter).pipe(gunzip);

  const queue = new ByteQueue();
  const seen = new Map<string, { path: string; size: number; sha256: string | null; directory: boolean }>();
  type ReaderState = 'header' | 'data' | 'pax' | 'padding' | 'end';
  let state: ReaderState = 'header';
  // 状态在回调里被修改，TypeScript 无法跟踪，读取时统一经过这个函数。
  const currentState = (): ReaderState => state;
  let pendingPax: { path?: string; size?: number } | null = null;
  let paxRemaining = 0;
  let paxChunks: Buffer[] = [];
  let paddingRemaining = 0;
  let current: PendingFile | null = null;
  let manifestRaw: Buffer | null = null;
  let entries = 0;
  let contentBytes = 0;
  let filesDone = 0;

  const startPadding = (size: number) => {
    paddingRemaining = size % BLOCK === 0 ? 0 : BLOCK - (size % BLOCK);
    state = paddingRemaining > 0 ? 'padding' : 'header';
  };

  const finishFile = async (file: PendingFile) => {
    if (file.manifestChunks) {
      manifestRaw = Buffer.concat(file.manifestChunks);
    } else {
      const record = seen.get(comparableKey(file.path))!;
      record.sha256 = file.hash!.digest('hex');
      if (file.output) {
        await closeWriteStream(file.output);
        file.output = null;
        const mtime = new Date(file.mtimeMs);
        await fsp.utimes(file.target!, mtime, mtime).catch(() => undefined);
      }
      filesDone += 1;
      options.onProgress?.(filesDone);
    }
    current = null;
    startPadding(file.size);
  };

  const handleHeader = async (block: Buffer) => {
    if (block.every((byte) => byte === 0)) {
      state = 'end';
      return;
    }
    if (manifestRaw) {
      // 清单必须是最后一个条目，之后出现的内容无法被清单覆盖。
      throw new PanelError('server.backups.archive.corrupted');
    }
    verifyHeaderChecksum(block);
    if (readString(block, 257, 5) !== 'ustar') throw new PanelError('server.backups.archive.corrupted');
    const type = String.fromCharCode(block[156]!);
    const headerSize = readNumeric(block, 124, 12);
    if (type === 'x') {
      if (pendingPax || headerSize > MAX_PAX_HEADER_BYTES) throw new PanelError('server.backups.archive.corrupted');
      paxRemaining = headerSize;
      paxChunks = [];
      state = paxRemaining > 0 ? 'pax' : 'header';
      if (paxRemaining === 0) pendingPax = {};
      return;
    }
    const pax = pendingPax ?? {};
    pendingPax = null;
    const prefix = readString(block, 345, 155);
    const rawName = pax.path ?? (prefix ? `${prefix}/${readString(block, 0, 100)}` : readString(block, 0, 100));
    const size = pax.size ?? headerSize;
    const isFile = type === '0' || type === '\0';
    const isDirectory = type === '5';
    if (!isFile && !isDirectory) {
      throw new PanelError('server.backups.archive.unsupportedEntry', { name: rawName });
    }
    const relativePath = normalizeArchivePath(rawName);
    const mtimeMs = readNumeric(block, 136, 12) * 1000;

    if (isFile && relativePath === BACKUP_MANIFEST_PATH) {
      if (size > MAX_MANIFEST_BYTES) throw new PanelError('server.backups.archive.manifestInvalid');
      current = { path: relativePath, remaining: size, size, mtimeMs, hash: null, manifestChunks: [], output: null, target: null };
      if (size === 0) await finishFile(current);
      else state = 'data';
      return;
    }
    if (isReservedArchivePath(relativePath)) {
      throw new PanelError('server.backups.archive.reservedPath', { name: relativePath });
    }
    const key = comparableKey(relativePath);
    if (seen.has(key)) throw new PanelError('server.backups.archive.duplicateEntry', { name: relativePath });
    entries += 1;
    if (entries > limits.maxEntries) {
      throw new PanelError('server.backups.archive.tooManyEntries', { limit: limits.maxEntries });
    }

    if (isDirectory) {
      if (size !== 0) throw new PanelError('server.backups.archive.corrupted');
      seen.set(key, { path: relativePath, size: 0, sha256: null, directory: true });
      if (destination) {
        await fsp.mkdir(resolveSafePath(destination, relativePath), { recursive: true, mode: 0o700 });
      }
      return;
    }

    contentBytes += size;
    if (contentBytes > limits.maxBytes) {
      throw new PanelError('server.backups.archive.tooLarge', { limit: limits.maxBytes });
    }
    seen.set(key, { path: relativePath, size, sha256: null, directory: false });
    let output: fs.WriteStream | null = null;
    let target: string | null = null;
    if (destination) {
      target = resolveSafePath(destination, relativePath);
      await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      // 只解压到全新的 staging 目录，重名在上面已拒绝，这里用 wx 防止意外覆盖。
      output = fs.createWriteStream(target, { flags: 'wx', mode: 0o600 });
      output.on('error', () => {});
    }
    current = { path: relativePath, remaining: size, size, mtimeMs, hash: createHash('sha256'), manifestChunks: null, output, target };
    if (size === 0) await finishFile(current);
    else state = 'data';
  };

  try {
    for await (const chunk of gunzip as AsyncIterable<Buffer>) {
      throwIfAborted(signal);
      queue.push(chunk);
      while (queue.length > 0) {
        if (currentState() === 'end') {
          // 结束块之后的填充（通常为零）不再解析。
          queue.take(queue.length);
          break;
        }
        if (state === 'header') {
          if (queue.length < BLOCK) break;
          await handleHeader(queue.take(BLOCK));
          continue;
        }
        if (state === 'pax') {
          const part = queue.takeUpTo(paxRemaining);
          paxChunks.push(part);
          paxRemaining -= part.length;
          if (paxRemaining === 0) {
            const data = Buffer.concat(paxChunks);
            pendingPax = parsePaxRecords(data);
            startPadding(data.length);
          }
          continue;
        }
        if (state === 'padding') {
          const part = queue.takeUpTo(paddingRemaining);
          paddingRemaining -= part.length;
          if (paddingRemaining === 0) state = 'header';
          continue;
        }
        const file = current!;
        const part = queue.takeUpTo(file.remaining);
        file.remaining -= part.length;
        if (file.manifestChunks) {
          file.manifestChunks.push(Buffer.from(part));
        } else {
          file.hash!.update(part);
          if (file.output && !file.output.write(part)) {
            await waitForDrain(file.output, signal);
          }
        }
        if (file.remaining === 0) await finishFile(file);
      }
    }
    if (currentState() !== 'end') throw new PanelError('server.backups.archive.corrupted');
  } catch (error) {
    const pending = current as PendingFile | null;
    if (pending?.output) pending.output.destroy();
    source.destroy();
    archiveCounter.destroy();
    gunzip.destroy();
    if (signal.aborted) throw abortError(signal);
    if (isPanelError(error)) throw error;
    // zlib 的数据错误、截断等底层异常统一视为文件损坏。
    throw new PanelError('server.backups.archive.corrupted', undefined, { cause: error });
  }

  if (!manifestRaw) throw new PanelError('server.backups.archive.manifestMissing');
  const manifest = parseManifest(manifestRaw);
  const listed = new Set<string>();
  for (const file of manifest.files) {
    const key = comparableKey(file.path);
    listed.add(key);
    const record = seen.get(key);
    if (!record || record.directory) throw new PanelError('server.backups.archive.fileMissing', { name: file.path });
    if (record.size !== file.size || record.sha256 !== file.sha256) {
      throw new PanelError('server.backups.archive.checksumMismatch', { name: file.path });
    }
  }
  for (const [key, record] of seen) {
    if (!record.directory && !listed.has(key)) {
      throw new PanelError('server.backups.archive.unexpectedFile', { name: record.path });
    }
  }
  // gunzip 读完时输入已全部流过计数器，此时的摘要覆盖整个文件。
  return {
    manifest,
    fileCount: manifest.files.length,
    contentBytes,
    archiveBytes,
    archiveSha256: archiveHash.digest('hex'),
  };
}
