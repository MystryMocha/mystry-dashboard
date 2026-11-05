import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { resolveSafePath } from '../utils/path.js';
import { ensureCoreCache, downloadToFile } from './core-download.js';
import { buildResolvedCoreCacheBasename, resolveVanillaDownload } from './core-metadata.js';
import { mavenMirrorUrl } from './download-sources.js';
import { readZipEntryBuffer } from './zip-service.js';

const PROFILE_BYTE_LIMIT = 4 * 1024 * 1024;
const PREFETCH_CONCURRENCY = 6;
/** 连续失败这么多次就认为镜像不可用，剩下的交给安装器自己下载。 */
const MAX_CONSECUTIVE_FAILURES = 3;

const DEFAULT_SERVER_JAR_PATH = '{ROOT}/minecraft_server.{MINECRAFT_VERSION}.jar';

type LibraryEntry = {
  downloads?: { artifact?: { path?: string; url?: string; sha1?: string } };
};

type InstallProfile = {
  minecraft?: string;
  json?: string;
  serverJarPath?: string;
  libraries?: LibraryEntry[];
};

type PrefetchTarget = { relativePath: string; url: string; sha1: string };

async function readJsonEntry<T>(installerJar: string, entry: string, signal: AbortSignal): Promise<T> {
  const bytes = await readZipEntryBuffer(installerJar, entry, PROFILE_BYTE_LIMIT, signal, config.maxCoreDownloadBytes);
  return JSON.parse(bytes.toString('utf8')) as T;
}

/** 从安装器的依赖清单里挑出能走镜像的文件；没有校验值或不在已知仓库内的留给安装器处理。 */
export function collectPrefetchTargets(libraries: LibraryEntry[]): PrefetchTarget[] {
  const targets = new Map<string, PrefetchTarget>();
  for (const library of libraries) {
    const artifact = library.downloads?.artifact;
    if (!artifact?.path || !artifact.url || !artifact.sha1) continue;
    const url = mavenMirrorUrl(artifact.url);
    if (url) targets.set(artifact.path, { relativePath: artifact.path, url, sha1: artifact.sha1 });
  }
  return [...targets.values()];
}

/** 安装器放置 Vanilla 服务端的相对路径，由它自己的 serverJarPath 模板决定。 */
export function resolveServerJarPath(template: string | undefined, mcVersion: string): string {
  return (template ?? DEFAULT_SERVER_JAR_PATH)
    .replaceAll('{LIBRARY_DIR}', 'libraries')
    .replaceAll('{ROOT}', '.')
    .replaceAll('{MINECRAFT_VERSION}', mcVersion);
}

/** Vanilla 服务端经核心缓存下载，再复制到安装器要找的位置；文件存在时安装器不再联系 Mojang 下载它。 */
async function prefetchServerJar(profile: InstallProfile, dir: string, signal: AbortSignal): Promise<void> {
  const mcVersion = profile.minecraft;
  if (!mcVersion) return;
  const target = resolveSafePath(dir, resolveServerJarPath(profile.serverJarPath, mcVersion));
  const basename = buildResolvedCoreCacheBasename('vanilla', mcVersion, {});
  const cachePath = path.join(config.cacheDir, basename.replace(/[^\w.-]+/g, '_'));
  const plan = await resolveVanillaDownload(mcVersion, signal);
  // 校验值未知时计划里只有官方地址，这种情况让安装器自己下载。
  if (!plan.expected) return;
  await ensureCoreCache(plan, cachePath, basename, undefined, signal);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.copyFileSync(cachePath, target);
}

async function prefetchLibraries(
  targets: PrefetchTarget[],
  dir: string,
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void,
): Promise<void> {
  let next = 0;
  let done = 0;
  let consecutiveFailures = 0;
  const worker = async () => {
    while (next < targets.length && consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
      const target = targets[next]!;
      next += 1;
      try {
        const dest = resolveSafePath(dir, path.posix.join('libraries', target.relativePath));
        await downloadToFile(target.url, dest, undefined, signal, {
          expected: { algorithm: 'sha1', hex: target.sha1 },
          responseTimeoutMs: config.coreMetadataTimeoutMs,
        });
        consecutiveFailures = 0;
      } catch (error) {
        if (signal.aborted) throw error;
        consecutiveFailures += 1;
      }
      done += 1;
      onProgress(done, targets.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PREFETCH_CONCURRENCY, targets.length) }, worker));
}

/**
 * 国内来源下，在运行 Forge / NeoForge 安装器前把依赖经镜像下到实例目录。
 * 安装器的 --mirror 不覆盖 libraries.minecraft.net，NeoForge 的安装器不支持它，
 * 但两者都会跳过 SHA-1 相符的已有文件，所以预取对任何版本都安全。
 * 这一步只是加速：任何失败都不影响部署，缺的文件由安装器按官方地址补齐。
 */
export async function prefetchInstallerFiles(
  installerJar: string,
  dir: string,
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void,
): Promise<void> {
  try {
    const profile = await readJsonEntry<InstallProfile>(installerJar, 'install_profile.json', signal);
    // 1.12 及更早的安装器是另一种清单格式，没有 json 字段，保持原有流程。
    if (!profile.json) return;
    const version = await readJsonEntry<{ libraries?: LibraryEntry[] }>(
      installerJar,
      profile.json.replace(/^\/+/, ''),
      signal,
    );
    const targets = collectPrefetchTargets([...(profile.libraries ?? []), ...(version.libraries ?? [])]);
    await prefetchServerJar(profile, dir, signal).catch((error: unknown) => {
      if (signal.aborted) throw error;
    });
    await prefetchLibraries(targets, dir, signal, onProgress);
  } catch (error) {
    if (signal.aborted) throw error;
  }
}
