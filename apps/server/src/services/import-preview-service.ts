import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type { ConfirmZipImportInput, ImportPreviewInfo, ServerMessageKey, TaskInfo } from '@mystry/shared';
import { config } from '../config.js';
import { importZipPackage } from './import-service.js';
import { assertZipImportSafe, inspectZipEulaAccepted, inspectZipJvmConfig } from './zip-service.js';
import {
  assertImportPreviewUploadPath,
  removeUploadTemp,
} from './upload-service.js';
import { PanelError } from '../utils/errors.js';

type PreviewEntry = {
  info: ImportPreviewInfo;
  userId: string;
  zipPath: string;
  state: 'available' | 'confirming';
};

export class ImportPreviewHttpError extends PanelError {
  declare readonly statusCode: 404 | 409 | 410 | 429;

  constructor(
    key: ServerMessageKey,
    statusCode: 404 | 409 | 410 | 429,
  ) {
    super(key, undefined, { statusCode });
    this.name = 'ImportPreviewHttpError';
  }
}

const previews = new Map<string, PreviewEntry>();
const confirmedPreviews = new Map<string, { userId: string; expiresAt: string }>();
let cleanupTimer: NodeJS.Timeout | null = null;

function removeEntry(entry: PreviewEntry): void {
  previews.delete(entry.info.id);
  if (!fs.existsSync(entry.zipPath)) return;
  removeUploadTemp(assertImportPreviewUploadPath(entry.zipPath));
}

function findOwnedPreview(id: string, userId: string, now = Date.now()): PreviewEntry {
  const entry = previews.get(id);
  if (!entry || entry.userId !== userId) {
    throw new ImportPreviewHttpError('server.imports.preview.notFound', 404);
  }
  if (Date.parse(entry.info.expiresAt) <= now) {
    removeEntry(entry);
    throw new ImportPreviewHttpError('server.imports.preview.expired', 410);
  }
  return entry;
}

export function cleanupExpiredImportPreviews(now = Date.now()): number {
  let removed = 0;
  for (const entry of previews.values()) {
    if (Date.parse(entry.info.expiresAt) > now || entry.state === 'confirming') continue;
    removeEntry(entry);
    removed += 1;
  }
  for (const [id, entry] of confirmedPreviews) {
    if (Date.parse(entry.expiresAt) > now) continue;
    confirmedPreviews.delete(id);
  }
  return removed;
}

function purgeOrphanPreviewUploads(): number {
  fs.mkdirSync(config.uploadDir, { recursive: true, mode: 0o700 });
  let removed = 0;
  for (const entry of fs.readdirSync(config.uploadDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith('.tmp-import-preview-')) continue;
    const target = assertImportPreviewUploadPath(path.join(config.uploadDir, entry.name));
    removeUploadTemp(target);
    removed += 1;
  }
  return removed;
}

export function initializeImportPreviews(): { purged: number } {
  if (cleanupTimer) clearInterval(cleanupTimer);
  for (const entry of previews.values()) {
    try {
      removeEntry(entry);
    } catch {
      /* Initialization goes on to run the dedicated prefix cleanup. */
    }
  }
  previews.clear();
  confirmedPreviews.clear();
  const purged = purgeOrphanPreviewUploads();
  cleanupTimer = setInterval(() => cleanupExpiredImportPreviews(), 60_000);
  cleanupTimer.unref();
  return { purged };
}

export function shutdownImportPreviews(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  for (const entry of [...previews.values()]) {
    try {
      removeEntry(entry);
    } catch {
      /* On a safe shutdown the next start continues cleaning up the dedicated preview prefix. */
    }
  }
  previews.clear();
  confirmedPreviews.clear();
}

export async function createImportPreview(input: {
  userId: string;
  fileName: string;
  zipPath: string;
  now?: number;
}): Promise<ImportPreviewInfo> {
  const now = input.now ?? Date.now();
  cleanupExpiredImportPreviews(now);
  const previous = [...previews.values()].find((entry) => entry.userId === input.userId);
  if (previous?.state === 'confirming') {
    throw new ImportPreviewHttpError('server.imports.preview.replaceWhileConfirming', 409);
  }
  const otherCount = previews.size - (previous ? 1 : 0);
  if (otherCount >= config.maxImportPreviews) {
    throw new ImportPreviewHttpError('server.imports.preview.capacity', 429);
  }

  const zipPath = assertImportPreviewUploadPath(input.zipPath);
  assertZipImportSafe(zipPath);
  const detectedJvmConfig = await inspectZipJvmConfig(zipPath);
  const eulaAccepted = await inspectZipEulaAccepted(zipPath);
  const stat = fs.statSync(zipPath);
  const info: ImportPreviewInfo = {
    id: nanoid(32),
    fileName: path.basename(input.fileName || 'server.zip').slice(0, 255),
    sizeBytes: stat.size,
    expiresAt: new Date(now + config.importPreviewTtlSeconds * 1000).toISOString(),
    ...(detectedJvmConfig ? { detectedJvmConfig } : {}),
    ...(eulaAccepted ? { eulaAccepted: true } : {}),
  };
  previews.set(info.id, { info, userId: input.userId, zipPath, state: 'available' });
  if (previous) removeEntry(previous);
  return info;
}

export function getImportPreview(id: string, userId: string, now = Date.now()): ImportPreviewInfo {
  return findOwnedPreview(id, userId, now).info;
}

export function cancelImportPreview(id: string, userId: string, now = Date.now()): void {
  const entry = findOwnedPreview(id, userId, now);
  if (entry.state === 'confirming') {
    throw new ImportPreviewHttpError('server.imports.preview.cancelWhileConfirming', 409);
  }
  removeEntry(entry);
}

export async function confirmImportPreview(
  id: string,
  userId: string,
  input: ConfirmZipImportInput,
  now = Date.now(),
): Promise<TaskInfo> {
  const confirmed = confirmedPreviews.get(id);
  if (confirmed?.userId === userId && Date.parse(confirmed.expiresAt) > now) {
    throw new ImportPreviewHttpError('server.imports.preview.alreadyConfirmed', 409);
  }
  const entry = findOwnedPreview(id, userId, now);
  if (entry.state !== 'available') {
    throw new ImportPreviewHttpError('server.imports.preview.confirming', 409);
  }
  entry.state = 'confirming';
  try {
    const task = await importZipPackage({
      ...input,
      zipPath: entry.zipPath,
      preserveUploadOnEnqueueFailure: true,
    });
    previews.delete(entry.info.id);
    confirmedPreviews.set(entry.info.id, {
      userId: entry.userId,
      expiresAt: entry.info.expiresAt,
    });
    return task;
  } catch (error) {
    entry.state = 'available';
    throw error;
  }
}
