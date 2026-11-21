import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import { resolveSafePath } from '../utils/path.js';
import { createByteCounter } from '../utils/byte-counter.js';
import { hasErrorCode, PanelError } from '../utils/errors.js';

export class UploadCapacityError extends PanelError {
  readonly code = 'UPLOAD_CAPACITY';

  constructor() {
    super('server.files.upload.capacity', undefined, { statusCode: 429 });
    this.name = 'UploadCapacityError';
  }
}

export class UploadTooLargeError extends PanelError {
  readonly code = 'UPLOAD_TOO_LARGE';

  constructor() {
    super('server.files.upload.tooLarge', undefined, { statusCode: 413 });
    this.name = 'UploadTooLargeError';
  }
}

export function isUploadCapacityError(error: unknown): error is UploadCapacityError {
  return error instanceof UploadCapacityError
    || hasErrorCode(error, 'UPLOAD_CAPACITY');
}

export function isUploadTooLargeError(error: unknown): error is UploadTooLargeError {
  return error instanceof UploadTooLargeError
    || hasErrorCode(error, 'UPLOAD_TOO_LARGE');
}

let activeUploads = 0;

function tempPath(prefix: string): string {
  return path.join(
    config.uploadDir,
    `.tmp-${prefix}-${Date.now()}-${randomBytes(12).toString('hex')}`,
  );
}

/** Writes the multipart stream straight into a controlled temp directory, without aggregating the upload in memory. maxBytes defaults to MAX_UPLOAD_BYTES. */
export async function streamToUploadTemp(
  input: Readable,
  prefix: string,
  options: { maxBytes?: number } = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? config.maxUploadBytes;
  if (activeUploads >= config.maxConcurrentUploads) throw new UploadCapacityError();
  activeUploads += 1;
  let target: string | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  let timedOut = false;

  const clearIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const armIdleTimer = () => {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      timedOut = true;
      const error = new PanelError('server.files.upload.idleTimeout');
      input.destroy(error);
    }, config.uploadIdleTimeoutMs);
  };

  try {
    fs.mkdirSync(config.uploadDir, { recursive: true, mode: 0o700 });
    target = tempPath(prefix);
    let bytes = 0;
    const counter = createByteCounter((chunkBytes) => {
      armIdleTimer();
      bytes += chunkBytes;
      return bytes > maxBytes ? new UploadTooLargeError() : undefined;
    });

    armIdleTimer();
    await pipeline(input, counter, fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }));
    if ((input as Readable & { truncated?: boolean }).truncated) {
      throw new UploadTooLargeError();
    }
    return target;
  } catch (err) {
    try {
      if (target) fs.rmSync(target, { force: true });
    } catch {
      /* A cleanup failure does not override the original error */
    }
    if ((input as Readable & { truncated?: boolean }).truncated) {
      throw new UploadTooLargeError();
    }
    if (timedOut) throw new PanelError('server.files.upload.idleTimeout');
    throw err;
  } finally {
    clearIdleTimer();
    activeUploads -= 1;
  }
}

export function removeUploadTemp(filePath: string): void {
  const resolved = path.resolve(filePath);
  const uploadRoot = path.resolve(config.uploadDir);
  const relative = path.relative(uploadRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new PanelError('server.files.upload.invalidTempPath');
  }
  fs.rmSync(resolved, { force: true });
}

/** Ensures background tasks receive only temp files in the uploads directory. */
export function assertUploadPath(filePath: string): string {
  const safe = resolveSafePath(config.uploadDir, path.basename(filePath));
  if (!path.basename(safe).startsWith('.tmp-import-')) {
    throw new PanelError('server.files.upload.invalidTemp');
  }
  return safe;
}

/** A ZIP preview can only reference controlled upload temp files with the dedicated prefix. */
export function assertImportPreviewUploadPath(filePath: string): string {
  const safe = resolveSafePath(config.uploadDir, path.basename(filePath));
  if (!path.basename(safe).startsWith('.tmp-import-preview-')) {
    throw new PanelError('server.files.upload.invalidPreviewTemp');
  }
  return safe;
}
