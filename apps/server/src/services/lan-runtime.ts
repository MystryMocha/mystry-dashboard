import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { EASYTIER_VERSION } from '@mystry/shared';
import { config } from '../config.js';
import { forceSecureSensitiveFile } from '../utils/data-dir-permissions.js';
import { PanelError } from '../utils/errors.js';
import { USER_AGENT } from './core-utils.js';
import { listZipEntryNames, readZipEntryBuffer } from './zip-service.js';

const ARCHIVE_BYTE_LIMIT = 40 * 1024 * 1024;
const BINARY_BYTE_LIMIT = 40 * 1024 * 1024;

interface LanAsset {
  archive: string;
  sha256: string;
  coreName: string;
  cliName: string;
  extraNames: string[];
}

const ASSETS: Record<string, LanAsset> = {
  'win32:x64': {
    archive: 'easytier-windows-x86_64-v2.6.4.zip',
    sha256: '27af91e270e554709b048bd32327fefd2dfce5062ae1e8701af7550c6f525f84',
    coreName: 'easytier-core.exe',
    cliName: 'easytier-cli.exe',
    extraNames: ['wintun.dll'],
  },
  'linux:x64': {
    archive: 'easytier-linux-x86_64-v2.6.4.zip',
    sha256: '61b659eaedba658fa66fe47d17e1426cdd77e5d02fa15fed447bb4357c09dfd6',
    coreName: 'easytier-core',
    cliName: 'easytier-cli',
    extraNames: [],
  },
};

export function resolveLanAsset(platform: NodeJS.Platform, arch: string): LanAsset {
  const asset = ASSETS[`${platform}:${arch}`];
  if (!asset) throw new PanelError('server.lan.platformUnsupported');
  return asset;
}

export function lanRuntimeDir(): string {
  return path.join(config.dataDir, 'runtimes', 'easytier', EASYTIER_VERSION);
}

export function lanCorePath(): string {
  return path.join(lanRuntimeDir(), resolveLanAsset(process.platform, process.arch).coreName);
}

export function lanCliPath(): string {
  return path.join(lanRuntimeDir(), resolveLanAsset(process.platform, process.arch).cliName);
}

export function lanPlatformSupported(): boolean {
  return Object.prototype.hasOwnProperty.call(ASSETS, `${process.platform}:${process.arch}`);
}

export function lanInstalled(): boolean {
  if (!lanPlatformSupported()) return false;
  const asset = resolveLanAsset(process.platform, process.arch);
  const marker = path.join(lanRuntimeDir(), 'archive.sha256');
  try {
    const names = [asset.coreName, asset.cliName, ...asset.extraNames];
    const filesReady = names.every((name) => fs.existsSync(path.join(lanRuntimeDir(), name)));
    return filesReady && fs.readFileSync(marker, 'utf8').trim() === asset.sha256;
  } catch {
    return false;
  }
}

let installing: Promise<void> | null = null;

/** 下载钉死版本的官方 EasyTier，校验压缩包摘要后只抽出核心、命令行和 Windows 虚拟网卡驱动。 */
export async function ensureLanInstalled(): Promise<void> {
  if (lanInstalled()) return;
  if (!installing) {
    installing = installLan().finally(() => {
      installing = null;
    });
  }
  await installing;
}

async function installLan(): Promise<void> {
  const asset = resolveLanAsset(process.platform, process.arch);
  const dir = lanRuntimeDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const archivePath = path.join(dir, `${asset.archive}.partial`);
  const marker = path.join(dir, 'archive.sha256');
  try {
    await downloadArchive(asset, archivePath);
    const digest = createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
    if (digest !== asset.sha256) throw new PanelError('server.lan.checksumMismatch');
    const wanted = [asset.coreName, asset.cliName, ...asset.extraNames];
    const members = listMembers(archivePath, wanted);
    for (const name of wanted) {
      const member = members.get(name);
      if (!member) throw new PanelError('server.lan.extractFailed');
      const bytes = await extractMember(archivePath, member);
      const destination = path.join(dir, name);
      const temp = `${destination}.partial`;
      fs.writeFileSync(temp, bytes, { mode: 0o700 });
      if (process.platform !== 'win32') fs.chmodSync(temp, 0o700);
      fs.renameSync(temp, destination);
      if (process.platform !== 'win32' && name !== 'wintun.dll') fs.chmodSync(destination, 0o700);
    }
    fs.writeFileSync(marker, `${asset.sha256}\n`, { mode: 0o600 });
    forceSecureSensitiveFile(marker);
  } catch (error) {
    if (error instanceof PanelError) throw error;
    throw new PanelError('server.lan.downloadFailed', undefined, { cause: error });
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
}

async function downloadArchive(asset: LanAsset, destination: string): Promise<void> {
  const url = `https://github.com/EasyTier/EasyTier/releases/download/v${EASYTIER_VERSION}/${asset.archive}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(config.coreDownloadTimeoutMs),
      redirect: 'follow',
    });
  } catch (error) {
    throw new PanelError('server.lan.downloadFailed', undefined, { cause: error });
  }
  if (!response.ok || !response.body) throw new PanelError('server.lan.downloadFailed');
  const contentLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > ARCHIVE_BYTE_LIMIT) {
    throw new PanelError('server.lan.downloadFailed');
  }
  let received = 0;
  const source = Readable.fromWeb(response.body as import('stream/web').ReadableStream);
  source.on('data', (chunk: Buffer) => {
    received += chunk.length;
    if (received > ARCHIVE_BYTE_LIMIT) source.destroy(new PanelError('server.lan.downloadFailed'));
  });
  try {
    await pipeline(source, fs.createWriteStream(destination, { mode: 0o600 }));
  } catch (error) {
    if (error instanceof PanelError) throw error;
    throw new PanelError('server.lan.downloadFailed', undefined, { cause: error });
  }
  forceSecureSensitiveFile(destination);
}

/** 用面板自带的 ZIP 解析读取条目名，不依赖系统 tar（GNU tar 读不了 zip）。 */
function listMembers(archivePath: string, wanted: string[]): Map<string, string> {
  let names: string[];
  try {
    names = listZipEntryNames(archivePath, undefined, ARCHIVE_BYTE_LIMIT);
  } catch (error) {
    throw new PanelError('server.lan.extractFailed', undefined, { cause: error });
  }
  const found = new Map<string, string>();
  for (const member of names) {
    if (member.length === 0 || unsafeMemberName(member)) continue;
    const base = path.posix.basename(member);
    if (!wanted.includes(base)) continue;
    // 同名文件出现两次时无法确定该用哪一个，直接失败。
    if (found.has(base)) throw new PanelError('server.lan.extractFailed');
    found.set(base, member);
  }
  return found;
}

async function extractMember(archivePath: string, member: string): Promise<Buffer> {
  if (unsafeMemberName(member)) throw new PanelError('server.lan.extractFailed');
  let bytes: Buffer;
  try {
    bytes = await readZipEntryBuffer(archivePath, member, BINARY_BYTE_LIMIT, undefined, ARCHIVE_BYTE_LIMIT);
  } catch (error) {
    throw new PanelError('server.lan.extractFailed', undefined, { cause: error });
  }
  if (bytes.length === 0) throw new PanelError('server.lan.extractFailed');
  return bytes;
}

/** zip-service 已把反斜杠转成 /、并拒绝 .. 与绝对路径；这里再守一层，防止规范化规则日后变化。 */
function unsafeMemberName(member: string): boolean {
  return member.includes('..') || member.startsWith('/') || member.includes('\\');
}
