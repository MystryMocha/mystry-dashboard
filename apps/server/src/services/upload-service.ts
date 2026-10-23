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

/** 将 multipart 流直接写入受控临时目录，不把上传内容聚合到内存。 */
export async function streamToUploadTemp(input: Readable, prefix: string): Promise<string> {
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
      return bytes > config.maxUploadBytes ? new UploadTooLargeError() : undefined;
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
      /* 清理失败不覆盖原始错误 */
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

/** 确保后台任务只接收 uploads 目录中的临时文件。 */
export function assertUploadPath(filePath: string): string {
  const safe = resolveSafePath(config.uploadDir, path.basename(filePath));
  if (!path.basename(safe).startsWith('.tmp-import-')) {
    throw new PanelError('server.files.upload.invalidTemp');
  }
  return safe;
}

/** ZIP 预览只能引用专用前缀的受控上传临时文件。 */
export function assertImportPreviewUploadPath(filePath: string): string {
  const safe = resolveSafePath(config.uploadDir, path.basename(filePath));
  if (!path.basename(safe).startsWith('.tmp-import-preview-')) {
    throw new PanelError('server.files.upload.invalidPreviewTemp');
  }
  return safe;
}
