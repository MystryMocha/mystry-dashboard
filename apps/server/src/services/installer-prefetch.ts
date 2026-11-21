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
/** After this many consecutive failures the mirror is considered unavailable, and the rest is left for the installer to download itself. */
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

/** Picks the files that can go through the mirror from the installer's dependency list; those without a checksum or outside known repositories are left to the installer. */
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

/** Relative path where the installer places the Vanilla server, decided by its own serverJarPath template. */
export function resolveServerJarPath(template: string | undefined, mcVersion: string): string {
  return (template ?? DEFAULT_SERVER_JAR_PATH)
    .replaceAll('{LIBRARY_DIR}', 'libraries')
    .replaceAll('{ROOT}', '.')
    .replaceAll('{MINECRAFT_VERSION}', mcVersion);
}

/** The Vanilla server is downloaded through the core cache and then copied to where the installer looks for it; when the file exists the installer no longer contacts Mojang to download it. */
async function prefetchServerJar(profile: InstallProfile, dir: string, signal: AbortSignal): Promise<void> {
  const mcVersion = profile.minecraft;
  if (!mcVersion) return;
  const target = resolveSafePath(dir, resolveServerJarPath(profile.serverJarPath, mcVersion));
  const basename = buildResolvedCoreCacheBasename('vanilla', mcVersion, {});
  const cachePath = path.join(config.cacheDir, basename.replace(/[^\w.-]+/g, '_'));
  const plan = await resolveVanillaDownload(mcVersion, signal);
  // When the checksum is unknown the plan has only the official URL; in that case the installer downloads it itself.
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
 * Under the China source, downloads dependencies through the mirror into the instance directory before running the Forge / NeoForge installer.
 * The installer's --mirror does not cover libraries.minecraft.net and NeoForge's installer does not support it,
 * but both skip existing files whose SHA-1 matches, so prefetching is safe for any version.
 * This step is only a speedup: no failure affects the deploy, and missing files are fetched by the installer from the official URLs.
 */
export async function prefetchInstallerFiles(
  installerJar: string,
  dir: string,
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void,
): Promise<void> {
  try {
    const profile = await readJsonEntry<InstallProfile>(installerJar, 'install_profile.json', signal);
    // Installers for 1.12 and earlier use a different manifest format without a json field, so the original flow is kept.
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
