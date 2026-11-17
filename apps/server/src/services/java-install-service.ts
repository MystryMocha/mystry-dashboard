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
import { getTask, runBackgroundTask } from './task-service.js';
import { safeExtract } from './zip-service.js';

/**
 * 面板自动安装 Java：下载钉死版本的 Eclipse Temurin JRE，按钉死的 SHA-256 校验，
 * 解压到 <数据根>/runtimes/java/<版本>，执行 -version 确认后登记进 Java 运行时注册表。
 * 下载来源跟随面板的下载来源设置（GitHub 或公共 GitHub 代理）；摘要钉死，所以来源不影响可信度。
 * 升级版本：改 TEMURIN_RELEASES 里的 tag、文件名和摘要（取自同一 Release 的 .sha256.txt）。
 * 旧版本的目录不会自动删除：已有实例可能还绑定着它。
 */

interface TemurinAsset {
  archive: string;
  sha256: string;
}

interface TemurinRelease {
  /** GitHub Release tag，如 jdk-25.0.5+8 */
  tag: string;
  /** 键为 `${process.platform}:${process.arch}` */
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

/** 官方 JRE 压缩包都在 40–62 MB；留出余量，挡住异常大的响应。 */
const ARCHIVE_BYTE_LIMIT = 128 * 1024 * 1024;
const STAGING_PREFIX = '.staging-';

type JavaMajor = (typeof JAVA_INSTALL_MAJORS)[number];

export interface JavaInstallHooks {
  /** 替换下载：把官方压缩包写到 destination */
  acquire?: (major: JavaMajor, asset: TemurinAsset, destination: string, onProgress: (ratio: number) => void, signal: AbortSignal) => Promise<void>;
  /** 替换平台判断，键同 TEMURIN_RELEASES 的 assets */
  platformKey?: () => string;
}

let hooks: JavaInstallHooks = {};
/** 同一主版本只跑一个安装任务：重复点击时返回同一个任务，不并发写同一个目录。 */
const inFlight = new Map<JavaMajor, string>();

/** 测试用：替换下载和平台判断；传 null 恢复默认并清空进行中的记录。 */
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

/** 这台电脑上能自动安装的主版本；系统或架构没有官方包时为空。 */
export function installableJavaMajors(): number[] {
  const key = currentPlatformKey();
  return JAVA_INSTALL_MAJORS.filter((major) => Boolean(TEMURIN_RELEASES[major].assets[key]));
}

/** 目录名：tag 里的 + 换成 _，避免在命令行和网址里被误读。 */
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

/** Linux 的 tar.gz 用系统 tar 解压（同 frp-runtime）；摘要已核对过，内容就是官方包。 */
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

/** 官方包解压后只有一个顶层目录（如 jdk-25.0.5+8-jre）；返回它，结构不对时返回 null。 */
function singleTopLevelDir(extractDir: string): string | null {
  const entries = fs.readdirSync(extractDir, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0]!.isDirectory()) return null;
  return path.join(extractDir, entries[0]!.name);
}

/** Windows 上杀毒软件扫描刚解压的 exe 时，rename 常短暂报 EPERM / EBUSY；重试几次。 */
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

/** 清掉上次中断留下的临时目录。 */
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

/** 装好（或已装好）并登记，返回运行时 ID。report 的进度在 0–100 之间。 */
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

  // 已经装过（例如上次装完但页面没刷新）：确认能运行就直接登记，不重复下载。
  if (fs.existsSync(javaExecutable(finalDir))) {
    report(95, { key: 'server.jvm.javaInstall.verifying', params: { major } });
    const existing = await registerPanelJavaRuntime(javaExecutable(finalDir));
    if (existing) return existing.id;
    // 目录坏了：删掉重装。
    fs.rmSync(finalDir, { recursive: true, force: true });
  }

  cleanStaging(root);
  const staging = path.join(root, `${STAGING_PREFIX}${randomBytes(6).toString('hex')}`);
  fs.mkdirSync(staging, { mode: 0o700 });
  const archivePath = path.join(staging, `${asset.archive}.partial`);
  const extractDir = path.join(staging, 'extract');
  try {
    report(2, { key: 'server.jvm.javaInstall.downloading', params: { major, percent: 0 } });
    try {
      const acquire = hooks.acquire ?? defaultAcquire;
      await acquire(major, asset, archivePath, (ratio) => {
        const percent = Math.max(0, Math.min(100, Math.round(ratio * 100)));
        report(2 + Math.round(percent * 0.78), { key: 'server.jvm.javaInstall.downloading', params: { major, percent } });
      }, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      if (isPanelError(error) && error.messageKey === 'server.system.downloadChecksumMismatch') {
        throw failure('server.jvm.javaInstall.checksumMismatch', major, error);
      }
      throw failure('server.jvm.javaInstall.downloadFailed', major, error);
    }
    // 下载器已按摘要校验；替身或以后换下载方式时这里再守一层。
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

/** 排进后台任务。同一主版本已有任务在排队或运行时，返回那个任务。 */
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
