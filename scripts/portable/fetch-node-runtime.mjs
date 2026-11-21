import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../is-main-module.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const runtimeConfig = JSON.parse(
  await fsp.readFile(path.join(scriptDir, 'runtime.json'), 'utf8'),
);

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unknown option: ${token}`);
    const name = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Option --${name} needs a value`);
    result[name] = value;
    index += 1;
  }
  return result;
}

function normalizePlatform(value) {
  if (value === 'windows') return 'win32';
  if (value === 'macos') return 'darwin';
  return value;
}

function archiveFor(version, platform, arch) {
  const prefix = `node-v${version}`;
  if (platform === 'win32' && arch === 'x64') return `${prefix}-win-x64.zip`;
  if (platform === 'linux' && ['x64', 'arm64'].includes(arch)) {
    return `${prefix}-linux-${arch}.tar.xz`;
  }
  if (platform === 'darwin' && ['x64', 'arm64'].includes(arch)) {
    return `${prefix}-darwin-${arch}.tar.gz`;
  }
  throw new Error(`Unsupported Node runtime target: ${platform}/${arch}`);
}

async function download(url, destination) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'nodejs.org') {
    throw new Error(`Refusing to download Node from a non-official URL: ${url}`);
  }
  const response = await fetch(parsed, { redirect: 'error' });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: ${url} (HTTP ${response.status})`);
  }
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > 200 * 1024 * 1024) {
    throw new Error(`The Node runtime archive exceeds the 200MB limit: ${declaredLength}`);
  }
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination, { flags: 'wx' }));
  const stat = await fsp.stat(destination);
  if (stat.size === 0 || stat.size > 200 * 1024 * 1024) {
    throw new Error(`The Node runtime archive has an abnormal size: ${stat.size}`);
  }
}

async function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

function assertEmptyOutput(outputDir) {
  if (!fs.existsSync(outputDir)) return;
  const entries = fs.readdirSync(outputDir);
  if (entries.length > 0) throw new Error(`The runtime output directory is not empty: ${outputDir}`);
}

/** The Node version bundled in the portable package; local CI uses it too, so what is tested is the version users actually run. */
export const nodeRuntimeVersion = runtimeConfig.nodeVersion;

function resolveTarget(version, platform, arch) {
  const targetPlatform = normalizePlatform(platform);
  const targetArch = arch === 'amd64' ? 'x64' : arch;
  return { targetPlatform, targetArch, archiveName: archiveFor(version, targetPlatform, targetArch) };
}

/**
 * Downloads the official archive from nodejs.org into directory (which must be empty), and verifies it against the SHASUMS256.txt of the same version.
 * Portable package assembly and local CI share this download and verification logic.
 */
export async function downloadVerifiedNodeArchive({
  version = runtimeConfig.nodeVersion,
  platform = process.platform,
  arch = process.arch,
  directory,
}) {
  if (!directory) throw new Error('A download directory for the Node archive is required');
  const { targetPlatform, targetArch, archiveName } = resolveTarget(version, platform, arch);
  const baseUrl = `https://nodejs.org/dist/v${version}`;
  const archivePath = path.join(directory, archiveName);
  const checksumsPath = path.join(directory, 'SHASUMS256.txt');
  await Promise.all([
    download(`${baseUrl}/${archiveName}`, archivePath),
    download(`${baseUrl}/SHASUMS256.txt`, checksumsPath),
  ]);

  const checksums = await fsp.readFile(checksumsPath, 'utf8');
  const checksumLine = checksums
    .split(/\r?\n/)
    .find((line) => line.trim().endsWith(`  ${archiveName}`));
  if (!checksumLine) throw new Error(`${archiveName} was not found in SHASUMS256.txt`);
  const expected = checksumLine.trim().split(/\s+/)[0].toLowerCase();
  const actual = await sha256(archivePath);
  if (actual !== expected) {
    throw new Error(`Node runtime SHA-256 mismatch: expected=${expected} actual=${actual}`);
  }
  return { version, platform: targetPlatform, arch: targetArch, archiveName, archivePath, sha256: actual };
}

export async function fetchNodeRuntime({
  version = runtimeConfig.nodeVersion,
  platform = process.platform,
  arch = process.arch,
  outputDir,
}) {
  if (!outputDir) throw new Error('An output directory for the Node runtime is required');
  // Validate the target platform first, so no output directory is created when it is unsupported
  const { targetPlatform, targetArch, archiveName } = resolveTarget(version, platform, arch);
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'mystry-node-runtime-'));
  const extractDir = path.join(tempRoot, 'extract');

  try {
    assertEmptyOutput(outputDir);
    await fsp.mkdir(outputDir, { recursive: true });
    const { archivePath, sha256: actual } = await downloadVerifiedNodeArchive({
      version,
      platform: targetPlatform,
      arch: targetArch,
      directory: tempRoot,
    });

    await fsp.mkdir(extractDir);
    const extracted = spawnSync('tar', ['-xf', archivePath, '-C', extractDir], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (extracted.status !== 0) {
      throw new Error(`Failed to extract the Node runtime: ${extracted.stderr || extracted.stdout}`);
    }
    const roots = await fsp.readdir(extractDir, { withFileTypes: true });
    const root = roots.find((entry) => entry.isDirectory());
    if (!root) throw new Error('The Node runtime archive has no root directory');
    const sourceRoot = path.join(extractDir, root.name);

    if (targetPlatform === 'win32') {
      await fsp.copyFile(path.join(sourceRoot, 'node.exe'), path.join(outputDir, 'node.exe'));
    } else {
      const binDir = path.join(outputDir, 'bin');
      await fsp.mkdir(binDir, { recursive: true });
      const nodePath = path.join(binDir, 'node');
      await fsp.copyFile(path.join(sourceRoot, 'bin', 'node'), nodePath);
      await fsp.chmod(nodePath, 0o755);
    }
    await fsp.copyFile(
      path.join(sourceRoot, 'LICENSE'),
      path.join(outputDir, 'LICENSE-node.txt'),
    );
    await fsp.writeFile(
      path.join(outputDir, 'runtime.json'),
      `${JSON.stringify({ nodeVersion: version, platform: targetPlatform, arch: targetArch }, null, 2)}\n`,
      'utf8',
    );
    return { version, platform: targetPlatform, arch: targetArch, archiveName, sha256: actual };
  } finally {
    const resolvedTemp = path.resolve(tempRoot);
    const resolvedSystemTemp = path.resolve(os.tmpdir());
    if (resolvedTemp.startsWith(`${resolvedSystemTemp}${path.sep}`)) {
      await fsp.rm(resolvedTemp, { recursive: true, force: true });
    }
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (!args.output) throw new Error('An empty runtime output directory must be given with --output');
  const result = await fetchNodeRuntime({
    version: args.version || runtimeConfig.nodeVersion,
    platform: args.platform || process.platform,
    arch: args.arch || process.arch,
    outputDir: path.resolve(args.output),
  });
  console.log(
    `Prepared Node ${result.version} ${result.platform}/${result.arch}: ${args.output}`,
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
