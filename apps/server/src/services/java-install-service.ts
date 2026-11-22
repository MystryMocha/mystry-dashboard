import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { JAVA_INSTALL_MAJORS, type PanelMessage, type ServerMessageKey, type TaskInfo } from '@mystry/shared';
import { getMinecraftChildEnv } from '../utils/child-env.js';
import { isPanelError, PanelError } from '../utils/errors.js';
import { downloadFromPlan } from './core-download.js';
import { createDownloadPlan, getDownloadSource, githubReleaseCandidates } from './download-sources.js';
import { panelJavaRoot, registerPanelJavaRuntime } from './java-runtime-service.js';
import { cancelTask, getTask, runBackgroundTask } from './task-service.js';
import { safeExtract } from './zip-service.js';

/**
 * Automatic Java install by the panel: downloads a pinned version of the Eclipse Temurin JRE, verifies it against the pinned SHA-256,
 * extracts it to <data root>/runtimes/java/<version>, and after confirming with -version registers it in the Java runtime registry.
 * The download source follows the panel's download source setting (GitHub or a public GitHub proxy); the digest is pinned, so the source does not affect trust.
 * To upgrade a version: change the tag, file name and digest in TEMURIN_RELEASES (taken from the .sha256.txt of the same Release).
 * Directories of old versions are not deleted automatically: existing instances may still be bound to them.
 */

interface TemurinAsset {
  archive: string;
  sha256: string;
}

interface TemurinRelease {
  /** GitHub Release tag, e.g. jdk-25.0.5+8 */
  tag: string;
  /** The key is `${process.platform}:${process.arch}` */
  assets: Record<string, TemurinAsset>;
}

export const TEMURIN_RELEASES: Record<(typeof JAVA_INSTALL_MAJORS)[number], TemurinRelease> = {
  8: {
    tag: 'jdk8u512-b09',
    assets: {
      'win32:x64': { archive: 'OpenJDK8U-jre_x64_windows_hotspot_8u512b09.zip', sha256: 'ae1ae12f817d7735477c6555107eece73854da0654da69077309ef9bff0b78bf' },
      'linux:x64': { archive: 'OpenJDK8U-jre_x64_linux_hotspot_8u512b09.tar.gz', sha256: '57468dc8bfd71dd0578d9717e63a8c13b9efe0a2f2c85c2a13966d1c0f9b1e5f' },
    },
  },
  17: {
    tag: 'jdk-17.0.21+9',
    assets: {
      'win32:x64': { archive: 'OpenJDK17U-jre_x64_windows_hotspot_17.0.21_9.zip', sha256: 'fe4656bd78fb09812dc38c49da777f79cc33e7ee435a254be82f9e7f40d9d117' },
      'linux:x64': { archive: 'OpenJDK17U-jre_x64_linux_hotspot_17.0.21_9.tar.gz', sha256: '9f41bf88c7900c7097444a1bdeb84146ae692bc08842490ab098063c74bf9a8a' },
    },
  },
  21: {
    tag: 'jdk-21.0.13+9',
    assets: {
      'win32:x64': { archive: 'OpenJDK21U-jre_x64_windows_hotspot_21.0.13_9.zip', sha256: '2332c0b4cff6bed722da3567c91d5e47568bcba863fa4945d0a8d6fc76158628' },
      'linux:x64': { archive: 'OpenJDK21U-jre_x64_linux_hotspot_21.0.13_9.tar.gz', sha256: 'a535a1df9c6284d9618872984e026ae0352d1f7e9e0605425c0e6114f47351dd' },
    },
  },
  25: {
    tag: 'jdk-25.0.5+8',
    assets: {
      'win32:x64': { archive: 'OpenJDK25U-jre_x64_windows_hotspot_25.0.5_8.zip', sha256: 'da78d54a2fcdbba1e92d5e3f07dd30236f96297891c4a21a781c3f38f5c0beae' },
      'linux:x64': { archive: 'OpenJDK25U-jre_x64_linux_hotspot_25.0.5_8.tar.gz', sha256: '6fac98f0c8202efc3135a9e9e42aa61963ec42d1c5cbb40caf231e7b14a24ef6' },
    },
  },
};

/** Official JRE archives are all 40–62 MB; leave headroom while blocking abnormally large responses. */
const ARCHIVE_BYTE_LIMIT = 128 * 1024 * 1024;
const STAGING_PREFIX = '.staging-';

type JavaMajor = (typeof JAVA_INSTALL_MAJORS)[number];

export interface JavaInstallHooks {
  /** Replaces the download: writes the official archive to destination */
  acquire?: (major: JavaMajor, asset: TemurinAsset, destination: string, onProgress: (ratio: number) => void, signal: AbortSignal) => Promise<void>;
  /** Replaces the platform check; same key as assets in TEMURIN_RELEASES */
  platformKey?: () => string;
}

let hooks: JavaInstallHooks = {};
/** Only one install task runs per major version: repeated clicks return the same task instead of writing the same directory concurrently. */
const inFlight = new Map<JavaMajor, string>();

/** For tests: replaces the download and the platform check; pass null to restore the defaults and clear the in-progress records. */
export function setJavaInstallForTests(next: JavaInstallHooks | null): void {
  hooks = next ?? {};
  if (next === null) inFlight.clear();
}

function currentPlatformKey(): string {
  return hooks.platformKey ? hooks.platformKey() : `${process.platform}:${process.arch}`;
}

export function isJavaInstallMajor(value: unknown): value is JavaMajor {
  return (JAVA_INSTALL_MAJORS as readonly unknown[]).includes(value);
}

/** Major versions that can be installed automatically on this computer; empty when there is no official package for the OS or architecture. */
export function installableJavaMajors(): number[] {
  const key = currentPlatformKey();
  return JAVA_INSTALL_MAJORS.filter((major) => Boolean(TEMURIN_RELEASES[major].assets[key]));
}

/** Directory name: the + in the tag is replaced with _, so it is not misread on command lines and in URLs. */
function installDirName(major: JavaMajor): string {
  return `temurin-${TEMURIN_RELEASES[major].tag.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

function javaExecutable(dir: string): string {
  return path.join(dir, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
}

function failure(key: ServerMessageKey, major: JavaMajor, cause?: unknown): PanelError {
  return new PanelError(key, { major }, cause === undefined ? undefined : { cause });
}

async function defaultAcquire(
  major: JavaMajor,
  asset: TemurinAsset,
  destination: string,
  onProgress: (ratio: number) => void,
  signal: AbortSignal,
): Promise<void> {
  const release = TEMURIN_RELEASES[major];
  const candidates = githubReleaseCandidates(getDownloadSource(), `adoptium/temurin${major}-binaries`, release.tag, asset.archive);
  await downloadFromPlan(
    createDownloadPlan(candidates, { algorithm: 'sha256', hex: asset.sha256 }),
    destination,
    { name: `Java ${major}`, maxBytes: ARCHIVE_BYTE_LIMIT, signal, onProgress: (ratio) => onProgress(ratio) },
  );
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    fs.createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

/** The Linux tar.gz is extracted with the system tar (same as frp-runtime); the digest has been verified, so the content is the official package. */
function extractTarGz(archive: string, destination: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xzf', archive, '-C', destination, '--no-same-owner'], {
      env: getMinecraftChildEnv(),
      stdio: 'ignore',
      signal,
    });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited with ${code}`))));
  });
}

/** The extracted official package has a single top-level directory (such as jdk-25.0.5+8-jre); returns it, or null when the structure is wrong. */
function singleTopLevelDir(extractDir: string): string | null {
  const entries = fs.readdirSync(extractDir, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0]!.isDirectory()) return null;
  return path.join(extractDir, entries[0]!.name);
}

/** On Windows, while antivirus scans a freshly extracted exe, rename often briefly fails with EPERM / EBUSY; retry a few times. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 9 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
}

/** Cleans up temp directories left by a previous interruption. */
function cleanStaging(root: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(STAGING_PREFIX)) fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
  }
}

/** Installs (or finds it already installed) and registers it, returning the runtime ID. The progress passed to report is between 0 and 100. */
async function installJava(
  major: JavaMajor,
  signal: AbortSignal,
  report: (progress: number, message: PanelMessage) => void,
): Promise<string> {
  const asset = TEMURIN_RELEASES[major].assets[currentPlatformKey()];
  if (!asset) throw failure('server.jvm.javaInstall.platformUnsupported', major);
  const root = panelJavaRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const finalDir = path.join(root, installDirName(major));

  // Already installed (for example the last install finished but the page was not refreshed): confirm it runs and register directly, without downloading again.
  if (fs.existsSync(javaExecutable(finalDir))) {
    report(95, { key: 'server.jvm.javaInstall.verifying', params: { major } });
    const existing = await registerPanelJavaRuntime(javaExecutable(finalDir));
    if (existing) return existing.id;
    // The directory is broken: delete it and reinstall.
    fs.rmSync(finalDir, { recursive: true, force: true });
  }

  cleanStaging(root);
  const staging = path.join(root, `${STAGING_PREFIX}${randomBytes(6).toString('hex')}`);
  fs.mkdirSync(staging, { mode: 0o700 });
  const archivePath = path.join(staging, `${asset.archive}.partial`);
  const extractDir = path.join(staging, 'extract');
  try {
    // The text no longer spells out a download percentage: overall progress is already shown to the right of the progress bar, and two numbers that disagree only confuse people.
    report(2, { key: 'server.jvm.javaInstall.downloading', params: { major } });
    try {
      const acquire = hooks.acquire ?? defaultAcquire;
      await acquire(major, asset, archivePath, (ratio) => {
        const percent = Math.max(0, Math.min(100, Math.round(ratio * 100)));
        report(2 + Math.round(percent * 0.78), { key: 'server.jvm.javaInstall.downloading', params: { major } });
      }, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      if (isPanelError(error) && error.messageKey === 'server.system.downloadChecksumMismatch') {
        throw failure('server.jvm.javaInstall.checksumMismatch', major, error);
      }
      throw failure('server.jvm.javaInstall.downloadFailed', major, error);
    }
    // The downloader has already verified the digest; this is one more guard for stubs or a future change of download method.
    if (await sha256File(archivePath) !== asset.sha256) throw failure('server.jvm.javaInstall.checksumMismatch', major);

    report(82, { key: 'server.jvm.javaInstall.extracting', params: { major } });
    fs.mkdirSync(extractDir, { mode: 0o700 });
    try {
      if (asset.archive.endsWith('.zip')) await safeExtract(archivePath, extractDir, signal);
      else await extractTarGz(archivePath, extractDir, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      throw failure('server.jvm.javaInstall.extractFailed', major, error);
    }
    fs.rmSync(archivePath, { force: true });
    const top = fs.existsSync(extractDir) ? singleTopLevelDir(extractDir) : null;
    if (!top || !fs.existsSync(javaExecutable(top))) throw failure('server.jvm.javaInstall.extractFailed', major);

    report(92, { key: 'server.jvm.javaInstall.verifying', params: { major } });
    fs.rmSync(finalDir, { recursive: true, force: true });
    await renameWithRetry(top, finalDir);
    const registered = await registerPanelJavaRuntime(javaExecutable(finalDir));
    if (!registered) {
      fs.rmSync(finalDir, { recursive: true, force: true });
      throw failure('server.jvm.javaInstall.verifyFailed', major);
    }
    return registered.id;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Queues a background task. When the same major version already has a task queued or running, that task is returned. */
export async function startJavaInstall(major: number): Promise<TaskInfo> {
  if (!isJavaInstallMajor(major)) {
    throw new PanelError('server.jvm.javaInstall.unsupportedMajor', { major }, { statusCode: 400 });
  }
  if (!installableJavaMajors().includes(major)) {
    throw new PanelError('server.jvm.javaInstall.platformUnsupported', { major }, { statusCode: 409 });
  }
  const running = inFlight.get(major);
  if (running) {
    const task = getTask(running);
    if (task && (task.status === 'pending' || task.status === 'running')) return task;
    inFlight.delete(major);
  }
  let taskId = '';
  const task = await runBackgroundTask(
    'download',
    { key: 'server.jvm.javaInstall.queued', params: { major } },
    async (_id, signal, report) => {
      try {
        const javaRuntimeId = await installJava(major, signal, report);
        return { javaRuntimeId };
      } finally {
        if (inFlight.get(major) === taskId) inFlight.delete(major);
      }
    },
  );
  taskId = task.id;
  inFlight.set(major, task.id);
  return task;
}

/**
 * The user cancels a one-click install. Only Java install tasks still queued or running in this process are accepted; deploy, import and other tasks never are.
 * A running task becomes cancelled only after the download or extraction stops and the temp directory is deleted, so the returned task may still be running.
 */
export function cancelJavaInstall(taskId: string): TaskInfo {
  const isJavaInstall = [...inFlight.values()].includes(taskId);
  if (!isJavaInstall || !cancelTask(taskId)) {
    throw new PanelError('server.jvm.javaInstall.notCancellable', undefined, { statusCode: 409 });
  }
  return getTask(taskId)!;
}
