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
 * Instance backup archive: a gzip-compressed POSIX tar (ustar + pax extended headers), whose last entry is the manifest
 * `.mystry-backup/manifest.json` recording each file's size and SHA-256.
 * Not ZIP: the existing ZIP reader does not support ZIP64, and world saves easily exceed 4 GiB or 65535 entries.
 * Both reading and writing are streamed, keeping only the manifest in memory.
 */

export const BACKUP_FORMAT = 'mystry-backup';
export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_MANIFEST_DIR = '.mystry-backup';
export const BACKUP_MANIFEST_PATH = `${BACKUP_MANIFEST_DIR}/manifest.json`;

const BLOCK = 512;
/** Largest value the ustar header size field (11 octal digits) can represent; beyond it a pax size record is used. */
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

/** An entry to archive: a POSIX path relative to the instance root; files carry the size at scan time and the absolute path. */
export type BackupSourceEntry =
  | { kind: 'dir'; path: string; mtimeMs: number }
  | { kind: 'file'; path: string; absolute: string; size: number; mtimeMs: number };

export type BackupArchiveLimits = { maxEntries: number; maxBytes: number };

function comparableKey(relativePath: string): string {
  return process.platform === 'win32' ? relativePath.toLowerCase() : relativePath;
}

/** Normalizes paths inside the archive: rejects absolute paths, drive letters, `..`, NUL and empty paths, and unifies to POSIX paths without leading or trailing slashes. */
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

/** Files the panel maintains itself do not go into backups, and may not be written back from a backup either. */
export function isReservedArchivePath(relativePath: string): boolean {
  const key = comparableKey(relativePath);
  const reserved = [OWNERSHIP_MARKER_FILE, STAGING_MARKER_FILE].map(comparableKey);
  if (reserved.includes(key)) return true;
  const manifestDir = comparableKey(BACKUP_MANIFEST_DIR);
  return key === manifestDir || key.startsWith(`${manifestDir}/`);
}

// ---------------------------------------------------------------------------
// Writing

function writeString(block: Buffer, offset: number, length: number, value: string | Buffer): void {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  bytes.copy(block, offset, 0, Math.min(bytes.length, length));
}

function writeOctal(block: Buffer, offset: number, length: number, value: number): void {
  // One trailing NUL is kept; the caller guarantees the value does not exceed the field width.
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

/** Entry header: a pax extended header is written first when the path exceeds 100 bytes or the file exceeds 8 GiB. */
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
  // The pax record takes precedence; the ustar name field holds only the first 100 bytes as a compatibility hint.
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
      // The file was truncated after the scan: the header size is already written, so this backup can only be abandoned.
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
  // End-of-archive marker: two all-zero blocks.
  yield Buffer.alloc(BLOCK * 2);
  manifestOut.value = manifest;
}

export type WrittenBackupArchive = { sizeBytes: number; sha256: string; manifest: BackupManifest };

/** Writes entries as a .tar.gz; output must be a temp file that does not exist yet, and the caller deletes it on failure. */
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
    // World region files are already compressed, so the fastest level trades ratio for speed; text such as config and logs still shrinks noticeably.
    createGzip({ level: zlibConstants.Z_BEST_SPEED }),
    hashCounter,
    fs.createWriteStream(options.output, { flags: 'wx', mode: 0o600 }),
    { signal: options.signal },
  );
  if (!manifestOut.value) throw new PanelError('server.backups.archive.manifestMissing');
  return { sizeBytes, sha256: archiveHash.digest('hex'), manifest: manifestOut.value };
}

// ---------------------------------------------------------------------------
// Reading and verification

/** Sequential byte queue: tar headers are taken by block, and file data is streamed out as much as is available. */
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
    // GNU base-256: the top bit of the first byte is 1, and the rest is a big-endian integer.
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
  /** Byte count and SHA-256 of the backup file itself (after compression). */
  archiveBytes: number;
  archiveSha256: string;
};

/**
 * Stream-reads and verifies a backup: path safety, entry types, count and size quotas, and per-file SHA-256 matching the manifest.
 * When destination is given, files are also extracted into that directory (it must be a newly created empty staging directory); without it, only verification is done.
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
  // The state is modified inside callbacks, which TypeScript cannot track, so reads all go through this function.
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
      // The manifest must be the last entry; anything appearing after it could not be covered by the manifest.
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
      // Extraction goes only into a brand-new staging directory and duplicates were rejected above; wx here prevents accidental overwrites.
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
          // Padding after the end blocks (usually zeros) is not parsed further.
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
    // Low-level failures such as zlib data errors and truncation are all treated as a corrupted file.
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
  // By the time gunzip finishes, all input has passed through the counter, so the digest covers the whole file.
  return {
    manifest,
    fileCount: manifest.files.length,
    contentBytes,
    archiveBytes,
    archiveSha256: archiveHash.digest('hex'),
  };
}
