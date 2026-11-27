import fs from 'node:fs';
import path from 'node:path';
import { createInflateRaw } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable, Writable } from 'node:stream';
import { inspectJvmArgFile, renderPanelMessage, type DetectedJvmConfig, type PanelMessage } from '@mystry/shared';
import { config } from '../config.js';
import { OWNERSHIP_MARKER_FILE, assertSafeInstanceRoot, resolveSafePath } from '../utils/path.js';
import { MAX_DETECTED_JVM_ARGS_BYTES } from './jvm-detection-service.js';
import { isEulaAcceptedText, MAX_EULA_FILE_BYTES } from './eula-detection.js';
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
 * Parses the central directory. maxArchiveBytes is only for fixed sources inside the panel (such as the EasyTier archive);
 * when omitted the upload limit is used, so the behavior of legacy callers is unchanged.
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
      // Bytes remaining in the central directory after the entries are parsed mean the entry count recorded in the EOCD does not match the directory content.
      const remaining = central.length - offset;
      if (remaining > 0) throw new PanelError('server.files.zip.entryCountMismatch');
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

/** Preview and extraction share the local file header and data range validation. */
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

  // Unsupported compression methods must be rejected before the file stream is created, so no unhandled asynchronous error is left behind.
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
  // Translatable messages carry both the key and params, and the frontend shows them in the UI language; raw errors give only the original text.
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

/**
 * Rejects panel-reserved ownership markers in a server import ZIP (at the archive root, or directly inside a single
 * wrapper folder that flattenSingleRoot would lift to the instance root).
 */
export function assertZipImportSafe(
  zipPath: string,
  signal: AbortSignal = new AbortController().signal,
): void {
  const entries = readZipEntries(zipPath, signal);
  const topLevels = new Set(entries.map((entry) => entry.normalizedName.split('/')[0]!));
  const singleTopLevel = topLevels.size === 1;
  const reservedLower = OWNERSHIP_MARKER_FILE.toLowerCase();
  for (const entry of entries) {
    const parts = entry.normalizedName.split('/');
    const atRoot = parts.length === 1 && parts[0]!.toLowerCase() === reservedLower;
    const atFlattenedRoot = singleTopLevel && parts.length === 2 && parts[1]!.toLowerCase() === reservedLower;
    if (atRoot || atFlattenedRoot) {
      throw new PanelError('server.files.zip.reservedName', { name: entry.name });
    }
  }
}

/** A ZIP preview reads only the central directory and a size-limited user_jvm_args.txt, without extracting the full package. */
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

/**
 * Whether the package's own eula.txt records acceptance, at the root or in its single top-level folder (the import flattens that folder).
 * Names are compared exactly, as the server reads `eula.txt`; a missing, duplicated or unreadable file counts as not accepted.
 */
export async function inspectZipEulaAccepted(
  zipPath: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<boolean> {
  const files = readZipEntries(zipPath, signal).filter((entry) => !entry.directory);
  const topLevels = new Set(files.map((entry) => entry.normalizedName.split('/')[0]!));
  const singleRoot = topLevels.size === 1 && files.every((entry) => entry.normalizedName.includes('/'))
    ? [...topLevels][0]
    : null;
  const candidates = files.filter((entry) => entry.normalizedName === 'eula.txt'
    || (singleRoot !== null && entry.normalizedName === `${singleRoot}/eula.txt`));
  if (candidates.length !== 1 || candidates[0]!.uncompressedSize > MAX_EULA_FILE_BYTES) return false;
  try {
    return isEulaAcceptedText(await readZipEntryText(zipPath, candidates[0]!, signal));
  } catch {
    return false;
  }
}

/** Stream-extracts a ZIP; only the central directory is kept in memory, and the whole upload is never read into memory. */
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
    // A failed extraction may already have written most of a large archive: awaited rather than rmSync, which would hold
    // every request and all console output until the half-extracted tree was gone.
    await fs.promises.rm(destDir, { recursive: true, force: true });
    if (signal.aborted) throw abortError(signal);
    throw err;
  }
}

/** Lists the normalized names of all non-directory entries in a ZIP; reads only the central directory without extracting data. */
export function listZipEntryNames(
  zipPath: string,
  signal: AbortSignal = new AbortController().signal,
  maxArchiveBytes?: number,
): string[] {
  return readZipEntries(zipPath, signal, maxArchiveBytes)
    .filter((entry) => !entry.directory)
    .map((entry) => entry.normalizedName);
}

/** Extracts a single entry into memory by normalized name; only stored and Deflate are supported, and it aborts once the extracted result exceeds maxBytes. */
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
  // The entry given by the caller does not exist; treated as the archive content not matching.
  if (!entry) throw new PanelError('server.files.zip.corrupted');
  if (entry.uncompressedSize > maxBytes) throw new PanelError('server.files.zip.tooLarge');
  // Reject unsupported compression methods first, then open the file stream, so no unhandled asynchronous error is left behind.
  if (entry.compression !== 0 && entry.compression !== 8) {
    throw new PanelError('server.files.zip.unsupportedCompression', { name: entry.name });
  }
  const dataStart = zipEntryDataStart(zipPath, entry);

  const chunks: Buffer[] = [];
  let bytes = 0;
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      // The declared size in the central directory is not trusted; the limit is applied again by the actual number of bytes extracted.
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
