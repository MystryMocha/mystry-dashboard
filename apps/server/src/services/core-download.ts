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

/** 流式计算文件摘要，核心文件有几十 MB，不整体读进内存。 */
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
 * 核心缓存能否直接使用：非空文件，且计划带校验值时内容与之相符。缓存只按核心类型和版本命名、不分来源，
 * 旧版面板或别的来源都可能留下它，所以每次使用前按本次计划的校验值重新核对，不符的删掉，交给调用方重新下载。
 * 计划没有校验值时（例如离线取不到官方校验文件）只能按非空判断，与以前一致。
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
  // 计算摘要期间文件可能已被别的下载替换成核对过的新文件，这时核对新文件，不能把它删掉。
  if (!isSameFile(before, now)) return verifyCoreCache(filePath, expected, signal);
  fs.rmSync(filePath, { force: true });
  return false;
}

export type DownloadOptions = {
  /** 写入最终路径前核对的校验值；不符时丢弃文件。 */
  expected?: ExpectedDigest;
  /** 单文件大小上限，默认 MAX_CORE_DOWNLOAD_BYTES。 */
  maxBytes?: number;
  /** 等待响应头的时限；还有后备来源时用它，避免卡死的镜像耗尽整段下载超时。 */
  responseTimeoutMs?: number;
};

/** 请求文件并等待响应头；时限只覆盖这一段，正文仍受外层下载超时约束。 */
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
  const timeout = createTimeoutAbort(signal, config.coreDownloadTimeoutMs, 'server.deploy.downloadTimeout');
  const part = path.join(
    path.dirname(dest),
    `.part-${path.basename(dest)}-${Date.now()}-${randomBytes(12).toString('hex')}`,
  );
  let renamed = false;

  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    const res = await fetchDownload(url, timeout.signal, options.responseTimeoutMs);
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

    // 只把完整 part 文件提升为最终缓存文件；最终路径不会被用作下载中的暂存区。
    // 带校验值时 part 已核对过，总是替换已有文件：已有文件未经本次核对，不能优先保留。
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
      /* 清理失败不覆盖原始错误 */
    }
    throw timeout.errorFor(error);
  } finally {
    timeout.dispose();
  }
}

/** 进度回调：比例和当前正在使用的来源名。 */
export type PlanProgress = (ratio: number, source: string) => void;

export type PlanDownloadOptions = {
  /** 所有来源都失败时显示在错误里的文件名称。 */
  name: string;
  onProgress?: PlanProgress;
  signal?: AbortSignal;
  maxBytes?: number;
};

/** 按顺序尝试计划里的来源，成功即止。只有一个来源时保留它自己的错误，文案与切换来源前一致。 */
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

/** 运行时压缩包的下载错误：多来源汇总错误原样抛出，单一来源映射成该运行时自己的文案。 */
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
 * 按最终缓存路径合并并发下载，避免多个任务同时覆盖同一个核心文件。
 * 已有缓存按计划的校验值核对后才复用，不符时删掉重新下载。
 */
export async function ensureCoreCache(
  plan: DownloadPlan,
  cachePath: string,
  name: string,
  onProgress?: PlanProgress,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw abortError(signal);

  // 同一路径正在下载时直接加入，不去核对（或删除）下载完成前的旧文件。
  let flight = cacheDownloadFlights.get(cachePath);
  if (!flight) {
    if (await verifyCoreCache(cachePath, plan.expected, signal)) return;
    // 核对是异步的，期间可能已有别的调用发起了下载。
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
      // 先从表中移除再中止：旧下载收尾期间新来的调用会重新下载，而不是拿到别人的取消原因。
      if (cacheDownloadFlights.get(cachePath) === flight) cacheDownloadFlights.delete(cachePath);
      flight.controller.abort(signal?.reason);
    }
  }
}
