import fs from 'node:fs';
import path from 'node:path';
import { createInflateRaw } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable, Writable } from 'node:stream';
import { inspectJvmArgFile, renderPanelMessage, type DetectedJvmConfig, type PanelMessage } from '@mystry/shared';
import { config } from '../config.js';
import { assertSafeInstanceRoot, resolveSafePath } from '../utils/path.js';
import { MAX_DETECTED_JVM_ARGS_BYTES } from './jvm-detection-service.js';
import { createByteCounter } from '../utils/byte-counter.js';
import { abortError, errorMessage, PanelError, throwIfAborted, toPanelMessage } from '../utils/errors.js';

type ZipEntry = {
  name: string;
  normalizedName: string;
  compressedSize: number;
  uncompressedSize: number;
  compression: number;
  flags: number;
  localHeaderOffset: number;
  directory: boolean;
};

function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const bytes = fs.readSync(fd, buffer, 0, length, position);
  if (bytes !== length) throw new PanelError('server.files.zip.corrupted');
  return buffer;
}

function zipPathFromEntry(name: string): string {
  if (!name || name.includes('\0')) throw new PanelError('server.files.zip.entryNameInvalid');
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new PanelError('server.files.zip.unsafePath', { name });
  }
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => part === '..')) {
    throw new PanelError('server.files.zip.unsafePath', { name });
  }
  if (!parts.length) throw new PanelError('server.files.zip.entryNameEmpty');
  return parts.join('/');
}

/**
 * 解析中央目录。maxArchiveBytes 只给面板内部固定来源（如 EasyTier 压缩包）使用，
 * 省略时沿用上传上限，旧调用方行为不变。
 */
function readZipEntries(zipPath: string, signal: AbortSignal, maxArchiveBytes?: number): ZipEntry[] {
  const archiveLimit = maxArchiveBytes ?? config.maxUploadBytes;
  const fileSize = fs.statSync(zipPath).size;
  if (fileSize > archiveLimit) throw new PanelError('server.files.zip.tooLarge');
  const tailLength = Math.min(fileSize, 65_557);
  const fd = fs.openSync(zipPath, 'r');
  try {
    const tail = readAt(fd, fileSize - tailLength, tailLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (
        tail.readUInt32LE(i) === 0x06054b50
        && i + 22 + tail.readUInt16LE(i + 20) === tail.length
      ) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new PanelError('server.files.zip.notZip');

    const diskNumber = tail.readUInt16LE(eocd + 4);
    const centralDisk = tail.readUInt16LE(eocd + 6);
    const entriesOnDisk = tail.readUInt16LE(eocd + 8);
    const totalEntries = tail.readUInt16LE(eocd + 10);
    const centralSize = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      throw new PanelError('server.files.zip.zip64Unsupported');
    }
    if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) {
      throw new PanelError('server.files.zip.multiVolumeUnsupported');
    }
    if (totalEntries > config.maxZipEntries) throw new PanelError('server.files.zip.tooManyEntries');
    if (centralSize > config.maxZipCentralDirectoryBytes) {
      throw new PanelError('server.files.zip.centralDirectoryTooLarge');
    }
    if (centralOffset + centralSize > fileSize) throw new PanelError('server.files.zip.centralDirectoryOffsetInvalid');

    const central = readAt(fd, centralOffset, centralSize);
    const entries: ZipEntry[] = [];
    const seen = new Set<string>();
    let offset = 0;
    let totalUncompressed = 0;
    for (let index = 0; index < totalEntries; index += 1) {
      throwIfAborted(signal);
      if (offset + 46 > central.length || central.readUInt32LE(offset) !== 0x02014b50) {
        throw new PanelError('server.files.zip.centralDirectoryCorrupted');
      }
      const flags = central.readUInt16LE(offset + 8);
      const compression = central.readUInt16LE(offset + 10);
      const compressedSize = central.readUInt32LE(offset + 20);
      const uncompressedSize = central.readUInt32LE(offset + 24);
      const nameLength = central.readUInt16LE(offset + 28);
      const extraLength = central.readUInt16LE(offset + 30);
      const commentLength = central.readUInt16LE(offset + 32);
      const externalAttributes = central.readUInt32LE(offset + 38);
      const localHeaderOffset = central.readUInt32LE(offset + 42);
      const end = offset + 46 + nameLength + extraLength + commentLength;
      if (end > central.length) throw new PanelError('server.files.zip.entryMetadataCorrupted');

      const name = central.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
      const normalizedName = zipPathFromEntry(name);
      const unixMode = (externalAttributes >>> 16) & 0xffff;
      const fileType = unixMode & 0xf000;
      if (fileType === 0xa000 || (unixMode !== 0 && fileType !== 0 && fileType !== 0x8000 && fileType !== 0x4000)) {
        throw new PanelError('server.files.zip.linkEntry', { name });
      }
      if ((flags & 1) !== 0) throw new PanelError('server.files.zip.encryptedEntry', { name });
      if (compressedSize > archiveLimit || uncompressedSize > config.maxZipEntryBytes) {
        throw new PanelError('server.files.zip.entryTooLarge', { name });
      }
      totalUncompressed += uncompressedSize;
      if (totalUncompressed > config.maxZipUncompressedBytes) {
        throw new PanelError('server.files.zip.uncompressedTooLarge');
      }

      const key = process.platform === 'win32' ? normalizedName.toLowerCase() : normalizedName;
      if (seen.has(key)) throw new PanelError('server.files.zip.duplicateEntry', { name });
      seen.add(key);
      entries.push({
        name,
        normalizedName,
        compressedSize,
        uncompressedSize,
        compression,
        flags,
        localHeaderOffset,
        directory: name.endsWith('/') || fileType === 0x4000,
      });
      offset = end;
    }
    if (offset !== central.length) {
      // 条目解析完后中央目录仍有剩余字节，说明 EOCD 记录的条目数与目录内容不符。
      const remaining = central.length - offset;
      if (remaining > 0) throw new PanelError('server.files.zip.entryCountMismatch');
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

/** 预览和解压共用本地文件头与数据范围校验。 */
function zipEntryDataStart(zipPath: string, entry: ZipEntry): number {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const local = readAt(fd, entry.localHeaderOffset, 30);
    if (local.readUInt32LE(0) !== 0x04034b50) throw new PanelError('server.files.zip.localHeaderInvalid', { name: entry.name });
    const localNameLength = local.readUInt16LE(26);
    const localExtraLength = local.readUInt16LE(28);
    const dataStart = entry.localHeaderOffset + 30 + localNameLength + localExtraLength;
    const fileSize = fs.statSync(zipPath).size;
    if (dataStart + entry.compressedSize > fileSize) throw new PanelError('server.files.zip.entryDataOutOfRange', { name: entry.name });
    return dataStart;
  } finally {
    fs.closeSync(fd);
  }
}

function createZipEntrySource(zipPath: string, entry: ZipEntry, dataStart: number): Readable {
  return entry.compressedSize === 0
    ? Readable.from([])
    : fs.createReadStream(zipPath, {
        start: dataStart,
        end: dataStart + entry.compressedSize - 1,
      });
}

async function extractZipEntry(
  zipPath: string,
  destDir: string,
  entry: ZipEntry,
  totalWritten: { value: number },
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const dataStart = zipEntryDataStart(zipPath, entry);
  throwIfAborted(signal);

  const target = resolveSafePath(destDir, entry.normalizedName);
  if (entry.directory) {
    throwIfAborted(signal);
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  if (fs.existsSync(target)) throw new PanelError('server.files.zip.entryWouldOverwrite', { name: entry.name });

  // 必须在创建文件流前拒绝不支持的压缩方式，避免留下无人处理的异步错误。
  if (entry.compression !== 0 && entry.compression !== 8) {
    throw new PanelError('server.files.zip.unsupportedCompression', { name: entry.name });
  }

  let written = 0;
  const counter = createByteCounter((chunkBytes) => {
    if (signal.aborted) return abortError(signal);
    written += chunkBytes;
    totalWritten.value += chunkBytes;
    if (written > config.maxZipEntryBytes || totalWritten.value > config.maxZipUncompressedBytes) {
      return new PanelError('server.files.zip.extractedTooLarge');
    }
    return undefined;
  });
  const source = createZipEntrySource(zipPath, entry, dataStart);
  const output = fs.createWriteStream(target, { flags: 'wx', mode: 0o600 });
  let success = false;
  try {
    if (entry.compression === 0) {
      await pipeline(source, counter, output, { signal });
    } else {
      await pipeline(source, createInflateRaw(), counter, output, { signal });
    }
    if (written !== entry.uncompressedSize) throw new PanelError('server.files.zip.entrySizeMismatch', { name: entry.name });
    success = true;
  } finally {
    if (fs.existsSync(target) && !success) {
      fs.rmSync(target, { force: true });
    }
  }
}

async function readZipEntryText(
  zipPath: string,
  entry: ZipEntry,
  signal: AbortSignal,
): Promise<string> {
  if (entry.uncompressedSize > MAX_DETECTED_JVM_ARGS_BYTES) {
    throw new PanelError('server.files.zip.jvmArgsTooLarge');
  }
  const dataStart = zipEntryDataStart(zipPath, entry);
  if (entry.compression !== 0 && entry.compression !== 8) {
    throw new PanelError('server.files.zip.jvmArgsUnsupportedCompression', { method: entry.compression });
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > MAX_DETECTED_JVM_ARGS_BYTES) {
        callback(new PanelError('server.files.zip.jvmArgsTooLarge'));
        return;
      }
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const source = createZipEntrySource(zipPath, entry, dataStart);
  if (entry.compression === 0) {
    await pipeline(source, sink, { signal });
  } else {
    await pipeline(source, createInflateRaw(), sink, { signal });
  }
  if (bytes !== entry.uncompressedSize) throw new PanelError('server.files.zip.jvmArgsSizeMismatch');
  return Buffer.concat(chunks).toString('utf8');
}

function invalidDetectedJvmConfig(message: PanelMessage | string): DetectedJvmConfig {
  // 可翻译消息同时带上键与参数，前端按界面语言显示；原始错误只给原文。
  const issue = typeof message === 'string'
    ? { code: 'ZIP_ARGFILE_ERROR', severity: 'error' as const, message }
    : {
        code: 'ZIP_ARGFILE_ERROR',
        severity: 'error' as const,
        message: renderPanelMessage(message),
        key: message.key,
        ...(message.params ? { params: message.params } : {}),
      };
  return {
    source: 'user_jvm_args.txt',
    raw: '',
    canonicalArgs: null,
    issues: [issue],
  };
}

/** ZIP 预览只读取中央目录和受限的 user_jvm_args.txt，不解压完整安装包。 */
export async function inspectZipJvmConfig(
  zipPath: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<DetectedJvmConfig | undefined> {
  const entries = readZipEntries(zipPath, signal);
  const files = entries.filter((entry) => !entry.directory);
  const topLevels = new Set(files.map((entry) => entry.normalizedName.split('/')[0]!.toLowerCase()));
  const singleRoot = topLevels.size === 1
    && files.every((entry) => entry.normalizedName.includes('/'))
    ? [...topLevels][0]
    : null;
  const candidates = files.filter((entry) => {
    const normalized = entry.normalizedName.toLowerCase();
    return normalized === 'user_jvm_args.txt'
      || (singleRoot !== null && normalized === `${singleRoot}/user_jvm_args.txt`);
  });
  if (candidates.length === 0) return undefined;
  if (candidates.length > 1) {
    return invalidDetectedJvmConfig({ key: 'server.files.zip.jvmArgsMultiple' });
  }
  try {
    const raw = await readZipEntryText(zipPath, candidates[0]!, signal);
    return inspectJvmArgFile(raw);
  } catch (error) {
    return invalidDetectedJvmConfig(toPanelMessage(error) ?? errorMessage(error));
  }
}

/** 流式解压 ZIP；只在内存中保留中央目录，不会把整个上传包读入内存。 */
export async function safeExtract(
  zipPath: string,
  destDir: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
  assertSafeInstanceRoot(destDir);
  try {
    throwIfAborted(signal);
    const entries = readZipEntries(zipPath, signal);
    const totalWritten = { value: 0 };
    for (const entry of entries) {
      throwIfAborted(signal);
      await extractZipEntry(zipPath, destDir, entry, totalWritten, signal);
    }
  } catch (err) {
    fs.rmSync(destDir, { recursive: true, force: true });
    if (signal.aborted) throw abortError(signal);
    throw err;
  }
}

/** 列出 ZIP 中所有非目录条目的规范化名称；只读中央目录，不解压数据。 */
export function listZipEntryNames(
  zipPath: string,
  signal: AbortSignal = new AbortController().signal,
  maxArchiveBytes?: number,
): string[] {
  return readZipEntries(zipPath, signal, maxArchiveBytes)
    .filter((entry) => !entry.directory)
    .map((entry) => entry.normalizedName);
}

/** 按规范化名称把单个条目解压到内存；只支持存储与 Deflate，解压结果超过 maxBytes 即中止。 */
export async function readZipEntryBuffer(
  zipPath: string,
  entryName: string,
  maxBytes: number,
  signal: AbortSignal = new AbortController().signal,
  maxArchiveBytes?: number,
): Promise<Buffer> {
  throwIfAborted(signal);
  const entry = readZipEntries(zipPath, signal, maxArchiveBytes)
    .find((candidate) => !candidate.directory && candidate.normalizedName === entryName);
  // 调用方给的条目不存在，按压缩包内容不符处理。
  if (!entry) throw new PanelError('server.files.zip.corrupted');
  if (entry.uncompressedSize > maxBytes) throw new PanelError('server.files.zip.tooLarge');
  // 先拒绝不支持的压缩方式，再打开文件流，避免留下无人处理的异步错误。
  if (entry.compression !== 0 && entry.compression !== 8) {
    throw new PanelError('server.files.zip.unsupportedCompression', { name: entry.name });
  }
  const dataStart = zipEntryDataStart(zipPath, entry);

  const chunks: Buffer[] = [];
  let bytes = 0;
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      // 不信任中央目录里的声明大小，按实际解压字节数再次限流。
      if (bytes > maxBytes) {
        callback(new PanelError('server.files.zip.tooLarge'));
        return;
      }
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const source = createZipEntrySource(zipPath, entry, dataStart);
  if (entry.compression === 0) {
    await pipeline(source, sink, { signal });
  } else {
    await pipeline(source, createInflateRaw(), sink, { signal });
  }
  if (bytes !== entry.uncompressedSize) throw new PanelError('server.files.zip.entrySizeMismatch', { name: entry.name });
  return Buffer.concat(chunks);
}
