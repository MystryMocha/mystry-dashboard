import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FRP_CLIENT_VERSION, type RuntimeArchiveInfo } from '@mystry/shared';
import { config } from '../config.js';
import { forceSecureSensitiveFile } from '../utils/data-dir-permissions.js';
import { PanelError } from '../utils/errors.js';
import { downloadFromPlan, toRuntimeDownloadError } from './core-download.js';
import { createDownloadPlan, getDownloadSource, githubReleaseCandidates } from './download-sources.js';
import { readZipEntryBuffer } from './zip-service.js';

const ARCHIVE_BYTE_LIMIT = 32 * 1024 * 1024;
const BINARY_BYTE_LIMIT = 24 * 1024 * 1024;

/** 手动上传压缩包的上限，与下载上限一致。 */
export const FRPC_ARCHIVE_BYTE_LIMIT = ARCHIVE_BYTE_LIMIT;

interface FrpcAsset {
  archive: string;
  sha256: string;
  member: string;
  binaryName: string;
}

const ASSETS: Record<string, FrpcAsset> = {
  'win32:x64': {
    archive: 'frp_0.71.1_windows_amd64.zip',
    sha256: 'b90074b2b6a1d792a7a40f085ac6d276bcab2d1bc60201f8a86ca53ce65ce821',
    member: 'frp_0.71.1_windows_amd64/frpc.exe',
    binaryName: 'frpc.exe',
  },
  'linux:x64': {
    archive: 'frp_0.71.1_linux_amd64.tar.gz',
    sha256: '1d9875210972a5d1a62b2dc4c48df45ab0af05d3ca1b5e494a014428259df803',
    member: 'frp_0.71.1_linux_amd64/frpc',
    binaryName: 'frpc',
  },
};

export function resolveFrpcAsset(platform: NodeJS.Platform, arch: string): FrpcAsset {
  const asset = ASSETS[`${platform}:${arch}`];
  if (!asset) throw new PanelError('server.frp.platformUnsupported');
  return asset;
}

function frpcArchiveUrl(asset: FrpcAsset): string {
  return `https://github.com/fatedier/frp/releases/download/v${FRP_CLIENT_VERSION}/${asset.archive}`;
}

/** 本机平台对应的官方压缩包信息，供连不上 GitHub 时手动下载后上传。 */
export function frpcArchiveInfo(): RuntimeArchiveInfo | null {
  if (!frpcPlatformSupported()) return null;
  const asset = resolveFrpcAsset(process.platform, process.arch);
  return { name: asset.archive, sha256: asset.sha256, url: frpcArchiveUrl(asset), maxBytes: ARCHIVE_BYTE_LIMIT };
}

export function frpcRuntimeDir(): string {
  return path.join(config.dataDir, 'runtimes', 'frp', FRP_CLIENT_VERSION);
}

export function frpcBinaryPath(): string {
  return path.join(frpcRuntimeDir(), resolveFrpcAsset(process.platform, process.arch).binaryName);
}

export function frpcPlatformSupported(): boolean {
  return Object.prototype.hasOwnProperty.call(ASSETS, `${process.platform}:${process.arch}`);
}

export function frpcInstalled(): boolean {
  if (!frpcPlatformSupported()) return false;
  const asset = resolveFrpcAsset(process.platform, process.arch);
  const marker = path.join(frpcRuntimeDir(), 'archive.sha256');
  try {
    return fs.existsSync(frpcBinaryPath()) && fs.readFileSync(marker, 'utf8').trim() === asset.sha256;
  } catch {
    return false;
  }
}

let installing: Promise<void> | null = null;

/** 下载钉死版本的官方 frpc（来源见下载来源设置），校验压缩包摘要后只抽出客户端二进制。 */
export async function ensureFrpcInstalled(): Promise<void> {
  if (frpcInstalled()) return;
  if (!installing) {
    installing = installFrpc(downloadArchive, 'server.frp.checksumMismatch').finally(() => {
      installing = null;
    });
  }
  await installing;
}

/**
 * 用用户上传的压缩包安装。只认钉死的官方摘要，所以文件来自哪个镜像都无所谓；
 * 调用方负责删除 source。
 */
export async function installFrpcFromArchive(source: string): Promise<void> {
  if (installing) await installing.catch(() => undefined);
  if (frpcInstalled()) return;
  installing = installFrpc(
    async (_asset, destination) => {
      fs.copyFileSync(source, destination);
      forceSecureSensitiveFile(destination);
    },
    'server.frp.uploadMismatch',
  ).finally(() => {
    installing = null;
  });
  await installing;
}

async function installFrpc(
  acquire: (asset: FrpcAsset, destination: string) => Promise<void>,
  mismatchKey: 'server.frp.checksumMismatch' | 'server.frp.uploadMismatch',
): Promise<void> {
  const asset = resolveFrpcAsset(process.platform, process.arch);
  const dir = frpcRuntimeDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const archivePath = path.join(dir, `${asset.archive}.partial`);
  const binaryPath = path.join(dir, asset.binaryName);
  const marker = path.join(dir, 'archive.sha256');
  try {
    // 崩溃可能留下旧文件，而下载不会覆盖已存在的目标。
    fs.rmSync(archivePath, { force: true });
    await acquire(asset, archivePath);
    const digest = createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
    if (digest !== asset.sha256) throw new PanelError(mismatchKey);
    const bytes = await extractMember(archivePath, asset.member);
    const tempBinary = `${binaryPath}.partial`;
    fs.writeFileSync(tempBinary, bytes, { mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(tempBinary, 0o700);
    fs.renameSync(tempBinary, binaryPath);
    if (process.platform !== 'win32') fs.chmodSync(binaryPath, 0o700);
    fs.writeFileSync(marker, `${asset.sha256}\n`, { mode: 0o600 });
    forceSecureSensitiveFile(marker);
  } catch (error) {
    fs.rmSync(`${binaryPath}.partial`, { force: true });
    if (error instanceof PanelError) throw error;
    throw new PanelError('server.frp.downloadFailed', undefined, { cause: error });
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
}

async function downloadArchive(asset: FrpcAsset, destination: string): Promise<void> {
  const candidates = githubReleaseCandidates(
    getDownloadSource(),
    'fatedier/frp',
    `v${FRP_CLIENT_VERSION}`,
    asset.archive,
  );
  try {
    await downloadFromPlan(
      createDownloadPlan(candidates, { algorithm: 'sha256', hex: asset.sha256 }),
      destination,
      { name: 'frp', maxBytes: ARCHIVE_BYTE_LIMIT },
    );
  } catch (error) {
    throw toRuntimeDownloadError(error, {
      failed: 'server.frp.downloadFailed',
      mismatch: 'server.frp.checksumMismatch',
    });
  }
  forceSecureSensitiveFile(destination);
}

/** 从压缩包取出 frpc。archivePath 带 .partial 后缀，所以按包含 .zip 判断格式。 */
export async function extractMember(archivePath: string, member: string): Promise<Buffer> {
  if (member.includes('..') || member.startsWith('/') || member.includes('\\')) {
    throw new PanelError('server.frp.extractFailed');
  }
  return path.basename(archivePath).includes('.zip')
    ? extractZipMember(archivePath, member)
    : extractTarMember(archivePath, member);
}

/** Windows 包是 ZIP，用面板自带的解析：PATH 里可能是 Git 带的 GNU tar，它读不了 zip，还会把 C: 当成远程主机。 */
async function extractZipMember(archivePath: string, member: string): Promise<Buffer> {
  let bytes: Buffer;
  try {
    bytes = await readZipEntryBuffer(archivePath, member, BINARY_BYTE_LIMIT, undefined, ARCHIVE_BYTE_LIMIT);
  } catch (error) {
    throw new PanelError('server.frp.extractFailed', undefined, { cause: error });
  }
  if (bytes.length === 0) throw new PanelError('server.frp.extractFailed');
  return bytes;
}

function extractTarMember(archivePath: string, member: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xOf', archivePath, member], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const fail = (error: PanelError) => {
      if (failed) return;
      failed = true;
      child.kill();
      reject(error);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BINARY_BYTE_LIMIT) {
        fail(new PanelError('server.frp.extractFailed'));
        return;
      }
      chunks.push(chunk);
    });
    child.on('error', () => fail(new PanelError('server.frp.extractFailed')));
    child.on('exit', (code) => {
      if (failed) return;
      if (code !== 0 || size === 0) {
        reject(new PanelError('server.frp.extractFailed'));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}
