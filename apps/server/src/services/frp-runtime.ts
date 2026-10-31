import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { FRP_CLIENT_VERSION } from '@mystry/shared';
import { config } from '../config.js';
import { forceSecureSensitiveFile } from '../utils/data-dir-permissions.js';
import { PanelError } from '../utils/errors.js';
import { USER_AGENT } from './core-utils.js';

const ARCHIVE_BYTE_LIMIT = 32 * 1024 * 1024;
const BINARY_BYTE_LIMIT = 24 * 1024 * 1024;

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

/** 下载钉死版本的官方 frpc，校验压缩包摘要后只抽出客户端二进制。 */
export async function ensureFrpcInstalled(): Promise<void> {
  if (frpcInstalled()) return;
  if (!installing) {
    installing = installFrpc().finally(() => {
      installing = null;
    });
  }
  await installing;
}

async function installFrpc(): Promise<void> {
  const asset = resolveFrpcAsset(process.platform, process.arch);
  const dir = frpcRuntimeDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const archivePath = path.join(dir, `${asset.archive}.partial`);
  const binaryPath = path.join(dir, asset.binaryName);
  const marker = path.join(dir, 'archive.sha256');
  try {
    await downloadArchive(asset, archivePath);
    const digest = createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
    if (digest !== asset.sha256) throw new PanelError('server.frp.checksumMismatch');
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
  const url = `https://github.com/fatedier/frp/releases/download/v${FRP_CLIENT_VERSION}/${asset.archive}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(config.coreDownloadTimeoutMs),
      redirect: 'follow',
    });
  } catch (error) {
    throw new PanelError('server.frp.downloadFailed', undefined, { cause: error });
  }
  if (!response.ok || !response.body) throw new PanelError('server.frp.downloadFailed');
  const contentLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > ARCHIVE_BYTE_LIMIT) {
    throw new PanelError('server.frp.downloadFailed');
  }
  let received = 0;
  const source = Readable.fromWeb(response.body as import('stream/web').ReadableStream);
  source.on('data', (chunk: Buffer) => {
    received += chunk.length;
    if (received > ARCHIVE_BYTE_LIMIT) source.destroy(new PanelError('server.frp.downloadFailed'));
  });
  try {
    await pipeline(source, fs.createWriteStream(destination, { mode: 0o600 }));
  } catch (error) {
    if (error instanceof PanelError) throw error;
    throw new PanelError('server.frp.downloadFailed', undefined, { cause: error });
  }
  forceSecureSensitiveFile(destination);
}

function extractMember(archivePath: string, member: string): Promise<Buffer> {
  if (member.includes('..') || member.startsWith('/') || member.includes('\\')) {
    return Promise.reject(new PanelError('server.frp.extractFailed'));
  }
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
