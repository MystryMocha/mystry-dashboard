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

/** Limit for a manually uploaded archive, same as the download limit. */
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

/** Info about the official archive for this machine's platform, for downloading manually and uploading when GitHub is unreachable. */
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

/** Downloads the pinned official frpc (source per the download source setting), verifies the archive digest, and extracts only the client binary. */
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
 * Installs from an archive uploaded by the user. Only the pinned official digest is accepted, so it does not matter which mirror the file came from;
 * the caller is responsible for deleting source.
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
    // A crash may leave an old file behind, and the download does not overwrite an existing target.
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

/** Extracts frpc from the archive. archivePath has a .partial suffix, so the format is decided by whether it contains .zip. */
export async function extractMember(archivePath: string, member: string): Promise<Buffer> {
  if (member.includes('..') || member.startsWith('/') || member.includes('\\')) {
    throw new PanelError('server.frp.extractFailed');
  }
  return path.basename(archivePath).includes('.zip')
    ? extractZipMember(archivePath, member)
    : extractTarMember(archivePath, member);
}

/** The Windows package is a ZIP and is parsed with the panel's own parser: the tar on PATH may be the GNU tar shipped with Git, which cannot read zip and also treats C: as a remote host. */
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
