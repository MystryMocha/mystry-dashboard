import fs, { createWriteStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { config } from '../config.js';
import { createByteCounter } from '../utils/byte-counter.js';
import { abortError, isPanelError, PanelError } from '../utils/errors.js';
import { createTimeoutAbort, USER_AGENT } from './core-utils.js';
import {
  describeFailures,
  rejectInsecureRedirect,
  type DownloadPlan,
  type ExpectedDigest,
  type SourceFailure,
} from './download-sources.js';

export function isUsableCoreCache(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/** Computes a file digest by streaming; core files are tens of MB and are not read into memory whole. */
async function hashFile(filePath: string, algorithm: ExpectedDigest['algorithm'], signal?: AbortSignal): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of fs.createReadStream(filePath, { signal })) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function statOrNull(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function isSameFile(a: fs.Stats, b: fs.Stats): boolean {
  return a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.birthtimeMs === b.birthtimeMs;
}

/**
 * Whether a core cache can be used directly: a non-empty file whose content matches the checksum when the plan carries one. The cache is named only by core type and version, not by source,
 * and an older panel or another source may have left it, so before every use it is re-checked against this plan's checksum; a mismatch is deleted and left for the caller to download again.
 * When the plan has no checksum (for example the official checksum file cannot be fetched offline), only non-emptiness can be checked.
 */
export async function verifyCoreCache(
  filePath: string,
  expected: ExpectedDigest | undefined,
  signal?: AbortSignal,
): Promise<boolean> {
  const before = statOrNull(filePath);
  if (!before?.isFile() || before.size === 0) return false;
  if (!expected) return true;
  let actual: string;
  try {
    actual = await hashFile(filePath, expected.algorithm, signal);
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    throw error;
  }
  if (actual === expected.hex.toLowerCase()) return true;
  const now = statOrNull(filePath);
  if (!now) return false;
  // While the digest was being computed the file may have been replaced by another download with a newly verified file; in that case verify the new file, it must not be deleted.
  if (!isSameFile(before, now)) return verifyCoreCache(filePath, expected, signal);
  fs.rmSync(filePath, { force: true });
  return false;
}

export type DownloadOptions = {
  /** Checksum verified before writing to the final path; the file is discarded on mismatch. */
  expected?: ExpectedDigest;
  /** Per-file size limit, MAX_CORE_DOWNLOAD_BYTES by default. */
  maxBytes?: number;
  /** Time limit for waiting for response headers; used when fallback sources remain, so a stalled mirror does not use up the whole download timeout. */
  responseTimeoutMs?: number;
  /** Stall/idle timeout for body transfer (resets on every chunk); defaults to CORE_DOWNLOAD_TIMEOUT_MS. */
  idleTimeoutMs?: number;
};

/** Requests the file and waits for response headers; the time limit covers only this part, and the body is still bound by the outer download timeout. */
async function fetchDownload(url: string, signal: AbortSignal, responseTimeoutMs?: number): Promise<Response> {
  const init = { headers: { 'User-Agent': USER_AGENT } };
  if (responseTimeoutMs === undefined) return fetch(url, { ...init, signal });
  const timeout = createTimeoutAbort(signal, responseTimeoutMs, 'server.deploy.downloadTimeout');
  try {
    return await fetch(url, { ...init, signal: timeout.signal });
  } catch (error) {
    throw timeout.errorFor(error);
  } finally {
    timeout.dispose();
  }
}

export async function downloadToFile(
  url: string,
  dest: string,
  onProgress?: (ratio: number) => void,
  signal?: AbortSignal,
  options: DownloadOptions = {},
): Promise<void> {
  if (signal?.aborted) throw abortError(signal);
  const maxBytes = options.maxBytes ?? config.maxCoreDownloadBytes;
  const idleTimeoutMs = options.idleTimeoutMs ?? config.coreDownloadTimeoutMs;
  const timeout = createTimeoutAbort(signal, idleTimeoutMs, 'server.deploy.downloadTimeout');
  const part = path.join(
    path.dirname(dest),
    `.part-${path.basename(dest)}-${Date.now()}-${randomBytes(12).toString('hex')}`,
  );
  let renamed = false;

  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    const res = await fetchDownload(url, timeout.signal, options.responseTimeoutMs);
    timeout.reset();
    await rejectInsecureRedirect(url, res);
    if (!res.ok || !res.body) {
      throw new PanelError('server.deploy.downloadHttpFailed', { status: res.status, url });
    }

    const total = Number(res.headers.get('content-length') || 0);
    if (total > maxBytes) throw new PanelError('server.deploy.downloadTooLarge');
    let downloaded = 0;
    const digest = options.expected ? createHash(options.expected.algorithm) : null;
    const nodeStream = Readable.fromWeb(res.body as import('stream/web').ReadableStream);
    const counter = createByteCounter((chunkBytes, chunk) => {
      // Reset the stall timer on every arriving chunk so slow but steady transfers complete while stalled mirrors fail promptly.
      if (chunkBytes > 0) timeout.reset();
      downloaded += chunkBytes;
      if (downloaded > maxBytes) return new PanelError('server.deploy.downloadTooLarge');
      digest?.update(chunk);
      if (total > 0 && onProgress) onProgress(downloaded / total);
      return undefined;
    });
    await pipeline(
      nodeStream,
      counter,
      createWriteStream(part, { flags: 'wx', mode: 0o600 }),
      { signal: timeout.signal },
    );
    if (timeout.signal.aborted) throw abortError(timeout.signal);
    if (digest && digest.digest('hex') !== options.expected!.hex.toLowerCase()) {
      throw new PanelError('server.system.downloadChecksumMismatch');
    }

    // Only a complete part file is promoted to the final cache file; the final path is never used as a staging area for a download in progress.
    // With a checksum the part has been verified and always replaces the existing file: the existing file was not verified this time and must not be preferred.
    if (!options.expected && isUsableCoreCache(dest)) {
      fs.rmSync(part, { force: true });
      renamed = true;
    } else {
      fs.rmSync(dest, { force: true });
      fs.renameSync(part, dest);
      renamed = true;
    }
  } catch (error) {
    try {
      if (!renamed) fs.rmSync(part, { force: true });
    } catch {
      /* A cleanup failure does not override the original error */
    }
    throw timeout.errorFor(error);
  } finally {
    timeout.dispose();
  }
}

/** Progress callback: the ratio and the name of the source currently in use. */
export type PlanProgress = (ratio: number, source: string) => void;

export type PlanDownloadOptions = {
  /** File name shown in the error when every source fails. */
  name: string;
  onProgress?: PlanProgress;
  signal?: AbortSignal;
  maxBytes?: number;
};

/** Tries the sources in the plan in order and stops at the first success. With only one source its own error is thrown as is, not a summary of failed sources. */
export async function downloadFromPlan(plan: DownloadPlan, dest: string, options: PlanDownloadOptions): Promise<void> {
  const failures: SourceFailure[] = [];
  const { candidates, expected } = plan;
  for (const [index, candidate] of candidates.entries()) {
    const hasFallback = index < candidates.length - 1;
    try {
      await downloadToFile(
        candidate.url,
        dest,
        options.onProgress && ((ratio) => options.onProgress!(ratio, candidate.label)),
        options.signal,
        {
          expected,
          maxBytes: options.maxBytes,
          responseTimeoutMs: hasFallback ? config.coreMetadataTimeoutMs : undefined,
        },
      );
      return;
    } catch (error) {
      if (options.signal?.aborted || candidates.length === 1) throw error;
      failures.push({ source: candidate.label, error });
    }
  }
  throw new PanelError('server.system.downloadAllSourcesFailed', {
    name: options.name,
    attempts: describeFailures(failures),
  });
}

/** Download errors for runtime archives: an aggregated multi-source error is thrown as is, and a single source is mapped to that runtime's own wording. */
export function toRuntimeDownloadError(
  error: unknown,
  keys: {
    failed: 'server.frp.downloadFailed' | 'server.lan.downloadFailed';
    mismatch: 'server.frp.checksumMismatch' | 'server.lan.checksumMismatch';
  },
): PanelError {
  if (isPanelError(error)) {
    if (error.messageKey === 'server.system.downloadAllSourcesFailed') return error;
    if (error.messageKey === 'server.system.downloadChecksumMismatch') return new PanelError(keys.mismatch);
  }
  return new PanelError(keys.failed, undefined, { cause: error });
}

type CacheDownloadFlight = {
  controller: AbortController;
  promise: Promise<void>;
  waiters: number;
  callbacks: Set<PlanProgress>;
  finished: boolean;
};

const cacheDownloadFlights = new Map<string, CacheDownloadFlight>();

function waitForCacheDownload(flight: CacheDownloadFlight, signal?: AbortSignal): Promise<void> {
  if (!signal) return flight.promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    flight.promise.then(
      () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

/**
 * Merges concurrent downloads by final cache path, so multiple tasks do not overwrite the same core file at once.
 * An existing cache is reused only after being checked against the plan's checksum; a mismatch is deleted and downloaded again.
 */
export async function ensureCoreCache(
  plan: DownloadPlan,
  cachePath: string,
  name: string,
  onProgress?: PlanProgress,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw abortError(signal);

  // When the same path is already downloading, join it directly without checking (or deleting) the old file from before the download completes.
  let flight = cacheDownloadFlights.get(cachePath);
  if (!flight) {
    if (await verifyCoreCache(cachePath, plan.expected, signal)) return;
    // The check is asynchronous, and another call may have started a download in the meantime.
    flight = cacheDownloadFlights.get(cachePath);
  }
  if (!flight) {
    const controller = new AbortController();
    const callbacks = new Set<PlanProgress>();
    flight = {
      controller,
      promise: Promise.resolve(),
      waiters: 0,
      callbacks,
      finished: false,
    };
    flight.promise = downloadFromPlan(plan, cachePath, {
      name,
      onProgress: (ratio, source) => {
        for (const callback of callbacks) callback(ratio, source);
      },
      signal: controller.signal,
    }).finally(() => {
      flight!.finished = true;
      if (cacheDownloadFlights.get(cachePath) === flight) cacheDownloadFlights.delete(cachePath);
    });
    cacheDownloadFlights.set(cachePath, flight);
  }

  flight.waiters += 1;
  if (onProgress) flight.callbacks.add(onProgress);
  try {
    await waitForCacheDownload(flight, signal);
  } finally {
    if (onProgress) flight.callbacks.delete(onProgress);
    flight.waiters -= 1;
    if (flight.waiters === 0 && !flight.finished && !flight.controller.signal.aborted) {
      // Remove from the table before aborting: calls arriving while the old download finishes up start a fresh download instead of receiving someone else's cancel reason.
      if (cacheDownloadFlights.get(cachePath) === flight) cacheDownloadFlights.delete(cachePath);
      flight.controller.abort(signal?.reason);
    }
  }
}
