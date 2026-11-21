import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { resolveRealPath } from './utils/real-path.js';

for (const arg of process.argv) {
  const match = /^--mystry-fingerprint=(.+)$/.exec(arg);
  if (match?.[1]) {
    process.env.MYSTRY_PROCESS_FINGERPRINT = match[1].trim();
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

function resolveFromHome(value: string, homeDir: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(homeDir, value);
}

const configuredHome = process.env.MYSTRY_HOME?.trim();
const homeDir = configuredHome ? path.resolve(configuredHome) : repoRoot;
const configuredConfigPath = process.env.MYSTRY_CONFIG_PATH?.trim();
const configPath = configuredConfigPath
  ? resolveFromHome(configuredConfigPath, homeDir)
  : path.join(homeDir, configuredHome ? 'config' : '', configuredHome ? 'panel.env' : '.env');

// Development mode reads the repo's .env by default; the portable package's mdash wrapper points this at config/panel.env.
dotenv.config({ path: configPath });

const realParentCache = new Map<string, string>();

/**
 * Resolves symlinks and junctions only in the parent path (the install location) of the directory; the directory itself keeps its name.
 * For example, on distros where /home itself is a link, or when installed under a junction, the instance directory safety check would
 * treat the real path as an escape; switching to the real path here is enough. When the directory itself is a link, or contains links,
 * utils/path.ts still rejects it as before. Cached per config value so that not every config access walks the path with lstat.
 */
function withRealParent(dir: string): string {
  let real = realParentCache.get(dir);
  if (real === undefined) {
    const parent = path.dirname(dir);
    real = parent === dir ? dir : path.join(resolveRealPath(parent), path.basename(dir));
    realParentCache.set(dir, real);
  }
  return real;
}

function resolveDataDir(): string {
  const configured = process.env.MYSTRY_DATA_DIR?.trim() || process.env.DATA_DIR?.trim() || 'data';
  return withRealParent(resolveFromHome(configured, homeDir));
}

/** Backup directory: backups under the data root when BACKUP_DIR is unset; a relative value is resolved against MYSTRY_HOME (or the repo root). */
function resolveBackupDir(): string {
  const configured = process.env.BACKUP_DIR?.trim();
  return configured
    ? withRealParent(resolveFromHome(configured, homeDir))
    : path.join(resolveDataDir(), 'backups');
}

function parsePositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数`);
  }
  return value;
}

function parseOrigins(): string[] {
  const raw = process.env.CORS_ORIGINS === undefined
    ? 'http://127.0.0.1:5173,http://localhost:5173'
    : process.env.CORS_ORIGINS;
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function parseSecret(name: string, required: boolean): string | null {
  const value = process.env[name];
  if (value === undefined || (value === '' && !required)) {
    if (required) {
      throw new Error(`${name} 必须配置且必须为 64 位十六进制字符串`);
    }
    return null;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} 必须为 64 位十六进制字符串`);
  }
  return value;
}

export function assertDistinctSecrets(entries: ReadonlyArray<readonly [string, string | null]>): void {
  const configured = entries.filter((entry): entry is readonly [string, string] => entry[1] !== null);
  for (let index = 0; index < configured.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < configured.length; otherIndex += 1) {
      const current = configured[index]!;
      const other = configured[otherIndex]!;
      if (current[1].toLowerCase() === other[1].toLowerCase()) {
        throw new Error(`${current[0]} 与 ${other[0]} 必须使用不同的随机值`);
      }
    }
  }
}

const host = process.env.HOST || '127.0.0.1';
const jwtSecret = parseSecret('JWT_SECRET', true)!;
const setupToken = parseSecret('SETUP_TOKEN', false);
const launcherToken = parseSecret('LAUNCHER_TOKEN', false);
assertDistinctSecrets([
  ['JWT_SECRET', jwtSecret],
  ['SETUP_TOKEN', setupToken],
  ['LAUNCHER_TOKEN', launcherToken],
]);

export const config = {
  host,
  port: parsePositiveInt('PORT', 3000),
  jwtSecret,
  setupToken,
  launcherToken,
  corsOrigins: parseOrigins(),
  repoRoot,
  homeDir,
  configPath,
  get dataDir() {
    return resolveDataDir();
  },
  processFingerprint: process.env['MYSTRY_PROCESS_FINGERPRINT']?.trim() || null,
  get dbPath() {
    return path.join(resolveDataDir(), 'panel.db');
  },
  get instancesDir() {
    return path.join(resolveDataDir(), 'instances');
  },
  get existingServerImportDir() {
    return path.join(resolveDataDir(), 'imports');
  },
  get cacheDir() {
    return path.join(resolveDataDir(), 'cache', 'cores');
  },
  get uploadDir() {
    return path.join(resolveDataDir(), 'uploads');
  },
  get backupDir() {
    return resolveBackupDir();
  },
  maxJsonBodyBytes: parsePositiveInt('MAX_JSON_BODY_BYTES', 1048576),
  maxTextFileBytes: parsePositiveInt('MAX_TEXT_FILE_BYTES', 1048576),
  maxCommandBytes: parsePositiveInt('MAX_COMMAND_BYTES', 4096),
  maxConsoleBufferBytes: parsePositiveInt('MAX_CONSOLE_BUFFER_BYTES', 1048576),
  maxConsoleChunkBytes: parsePositiveInt('MAX_CONSOLE_CHUNK_BYTES', 65536),
  /** Per-file upload limit, 512MB by default */
  maxUploadBytes: parsePositiveInt('MAX_UPLOAD_BYTES', 512 * 1024 * 1024),
  /** Backup upload limit, 10 GiB by default (world saves are usually far larger than ordinary uploads). */
  maxBackupUploadBytes: parsePositiveInt('MAX_BACKUP_UPLOAD_BYTES', 10 * 1024 * 1024 * 1024),
  uploadIdleTimeoutMs: parsePositiveInt('UPLOAD_IDLE_TIMEOUT_MS', 30_000),
  maxConcurrentUploads: parsePositiveInt('MAX_CONCURRENT_UPLOADS', 1),
  /** ZIP import preview lifetime and global capacity. */
  importPreviewTtlSeconds: parsePositiveInt('IMPORT_PREVIEW_TTL_SECONDS', 30 * 60),
  maxImportPreviews: parsePositiveInt('MAX_IMPORT_PREVIEWS', 2),
  maxConcurrentFileDownloads: parsePositiveInt('MAX_CONCURRENT_FILE_DOWNLOADS', 4),
  fileDownloadIdleTimeoutMs: parsePositiveInt('FILE_DOWNLOAD_IDLE_TIMEOUT_MS', 60_000),
  maxConcurrentTasks: parsePositiveInt('MAX_CONCURRENT_TASKS', 1),
  maxQueuedTasks: parsePositiveInt('MAX_QUEUED_TASKS', 2),
  taskTimeoutMs: parsePositiveInt('TASK_TIMEOUT_MS', 1800000),
  /** Time limit for backup and restore tasks, 6 hours by default: packing a large world, the pre-restore backup and extraction all count within one task. */
  backupTaskTimeoutMs: parsePositiveInt('BACKUP_TASK_TIMEOUT_MS', 6 * 60 * 60 * 1000),
  maxCoreDownloadBytes: parsePositiveInt('MAX_CORE_DOWNLOAD_BYTES', 536870912),
  coreDownloadTimeoutMs: parsePositiveInt('CORE_DOWNLOAD_TIMEOUT_MS', 300000),
  httpRequestTimeoutMs: parsePositiveInt('HTTP_REQUEST_TIMEOUT_MS', 900_000),
  httpConnectionTimeoutMs: parsePositiveInt('HTTP_CONNECTION_TIMEOUT_MS', 300_000),
  httpKeepAliveTimeoutMs: parsePositiveInt('HTTP_KEEP_ALIVE_TIMEOUT_MS', 72_000),
  maxCoreMetadataBytes: parsePositiveInt('MAX_CORE_METADATA_BYTES', 2_097_152),
  coreMetadataTimeoutMs: parsePositiveInt('CORE_METADATA_TIMEOUT_MS', 15_000),
  maxConsoleIncomingBytes: parsePositiveInt('MAX_CONSOLE_INCOMING_BYTES', 4_352),
  maxConsoleConnections: parsePositiveInt('MAX_CONSOLE_CONNECTIONS', 20),
  maxConsoleCommandsPerWindow: parsePositiveInt('MAX_CONSOLE_COMMANDS_PER_WINDOW', 60),
  consoleCommandWindowMs: parsePositiveInt('CONSOLE_COMMAND_WINDOW_MS', 60_000),
  maxConsoleStdinBytes: parsePositiveInt('MAX_CONSOLE_STDIN_BYTES', 65_536),
  installerKillGraceMs: parsePositiveInt('INSTALLER_KILL_GRACE_MS', 5_000),
  maxInstallerOutputBytes: parsePositiveInt('MAX_INSTALLER_OUTPUT_BYTES', 65536),
  /** ZIP safety quotas */
  maxZipEntries: parsePositiveInt('MAX_ZIP_ENTRIES', 10_000),
  maxZipEntryBytes: parsePositiveInt('MAX_ZIP_ENTRY_BYTES', 1024 * 1024 * 1024),
  maxZipUncompressedBytes: parsePositiveInt(
    'MAX_ZIP_UNCOMPRESSED_BYTES',
    2 * 1024 * 1024 * 1024,
  ),
  maxZipCentralDirectoryBytes: parsePositiveInt(
    'MAX_ZIP_CENTRAL_DIRECTORY_BYTES',
    32 * 1024 * 1024,
  ),
  /** Scan and copy quotas for the handoff area of existing servers on the same machine. */
  maxExistingImportEntries: parsePositiveInt('MAX_EXISTING_IMPORT_ENTRIES', 200_000),
  maxExistingImportBytes: parsePositiveInt(
    'MAX_EXISTING_IMPORT_BYTES',
    100 * 1024 * 1024 * 1024,
  ),
  /** ModLoader precheck budget in the existing-server list endpoint */
  modLoaderPrecheckMaxDepth: parsePositiveInt('MOD_LOADER_PRECHECK_MAX_DEPTH', 4),
  modLoaderPrecheckMaxEntries: parsePositiveInt('MOD_LOADER_PRECHECK_MAX_ENTRIES', 200),
  modLoaderPrecheckTimeoutMs: parsePositiveInt('MOD_LOADER_PRECHECK_TIMEOUT_MS', 250),
  /** ModLoader deep-scan budget in import/deploy tasks */
  modLoaderScanMaxDepth: parsePositiveInt('MOD_LOADER_SCAN_MAX_DEPTH', 64),
  modLoaderScanMaxEntries: parsePositiveInt('MOD_LOADER_SCAN_MAX_ENTRIES', 50_000),
  modLoaderScanTimeoutMs: parsePositiveInt('MOD_LOADER_SCAN_TIMEOUT_MS', 30_000),
  consoleTicketTtlSeconds: parsePositiveInt('CONSOLE_TICKET_TTL_SECONDS', 60),
  /** Lifetime of a one-time file download ticket (seconds) */
  fileDownloadTicketTtlSeconds: parsePositiveInt('FILE_DOWNLOAD_TICKET_TTL_SECONDS', 60),
  rateLimitMax: parsePositiveInt('RATE_LIMIT_MAX', 120),
  rateLimitWindowMs: parsePositiveInt('RATE_LIMIT_WINDOW_MS', 60_000),
  authRateLimitMax: parsePositiveInt('AUTH_RATE_LIMIT_MAX', 10),
  authRateLimitWindowMs: parsePositiveInt('AUTH_RATE_LIMIT_WINDOW_MS', 5 * 60_000),
  webDist: path.resolve(__dirname, '../../web/dist'),
};
