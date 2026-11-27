import fs from 'node:fs';
import path from 'node:path';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export class DataDirPermissionError extends Error {
  readonly code = 'DATA_DIR_PERMISSION';

  constructor(message: string) {
    super(message);
    this.name = 'DataDirPermissionError';
  }
}

let windowsAclWarningShown = false;
const startupNotices: string[] = [];

/** Takes the startup notices so the panel can write them to the log file; these notices are the same on every start and should not occupy the foreground window. */
export function takeStartupNotices(): string[] {
  return startupNotices.splice(0);
}

function isUnix(): boolean {
  return process.platform !== 'win32';
}

export function isDataPermissionRepairEnabled(): boolean {
  return process.env.MYSTRY_REPAIR_DATA_PERMISSIONS === '1';
}

function warnWindowsAclBoundary(targetPath: string): void {
  if (windowsAclWarningShown || isUnix()) return;
  windowsAclWarningShown = true;
  startupNotices.push(
    `无法在 Windows 上自动验证「${targetPath}」的 ACL。`
      + '请确保 DATA_DIR 仅当前运行面板的用户可读写；'
      + '若目录权限过宽，其他本机账户可能读取数据库与实例文件。'
      + '详见 docs/configuration.zh-CN.md。',
  );
}

export function formatUnixOwnerMismatch(targetPath: string, expectedUid: number, actualUid: number): string {
  return (
    `路径「${targetPath}」所有者不是当前用户（uid ${expectedUid}，实际 ${actualUid}），拒绝启动。`
    + `请使用 chown 将归属改为当前用户后重试（例如：chown -R "$(id -u):$(id -g)" "${targetPath}"）。`
  );
}

function assertUnixOwner(stat: fs.Stats, targetPath: string): void {
  if (!isUnix() || typeof process.getuid !== 'function') return;
  const uid = process.getuid();
  if (stat.uid !== uid) {
    throw new DataDirPermissionError(formatUnixOwnerMismatch(targetPath, uid, stat.uid));
  }
}

function normalizeMode(stat: fs.Stats): number {
  return stat.mode & 0o777;
}

function isDirModeUnsafe(mode: number): boolean {
  return (mode & 0o077) !== 0;
}

function isFileModeUnsafe(mode: number): boolean {
  return (mode & 0o077) !== 0;
}

function tightenOrReject(
  targetPath: string,
  kind: 'directory' | 'file',
  currentMode: number,
): void {
  const expected = kind === 'directory' ? DIR_MODE : FILE_MODE;
  const unsafe = kind === 'directory'
    ? isDirModeUnsafe(currentMode)
    : isFileModeUnsafe(currentMode);
  if (!unsafe) {
    if (isUnix() && currentMode !== expected) {
      fs.chmodSync(targetPath, expected);
    }
    return;
  }
  if (isDataPermissionRepairEnabled()) {
    fs.chmodSync(targetPath, expected);
    return;
  }
  const bits = currentMode.toString(8).padStart(3, '0');
  throw new DataDirPermissionError(
    `数据目录权限过宽：「${targetPath}」当前 mode ${bits}，`
      + `要求目录 ${DIR_MODE.toString(8)}、敏感文件 ${FILE_MODE.toString(8)}。`
      + '设置 MYSTRY_REPAIR_DATA_PERMISSIONS=1 可在启动时收紧权限，或手动 chmod 后重试。',
  );
}

/** Ensures the directory exists and is 0700 on Unix; verifies an existing path is not too permissive. */
export function ensureSecureDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode: DIR_MODE });
    if (isUnix()) fs.chmodSync(dirPath, DIR_MODE);
    return;
  }
  warnWindowsAclBoundary(dirPath);
  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) {
    throw new DataDirPermissionError(`期望目录但路径不是目录：${dirPath}`);
  }
  assertUnixOwner(stat, dirPath);
  if (isUnix()) {
    tightenOrReject(dirPath, 'directory', normalizeMode(stat));
  }
}

/** Sensitive files (database, WAL, SHM, etc.) should be 0600 on Unix. */
export function ensureSecureSensitiveFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  warnWindowsAclBoundary(path.dirname(filePath));
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return;
  assertUnixOwner(stat, filePath);
  if (isUnix()) {
    tightenOrReject(filePath, 'file', normalizeMode(stat));
  }
}

/** Initializes permissions of the data root and its subdirectories; call finalizeSensitiveDataFiles after initDb has created the database. */
export function prepareSecureDataLayout(dataDir: string, subdirectories: string[]): void {
  ensureSecureDirectory(dataDir);
  for (const relative of subdirectories) {
    ensureSecureDirectory(path.join(dataDir, relative));
  }
}

/** Permission check for the SQLite main database and its WAL/SHM companion files. */
export function finalizeSensitiveDataFiles(dbPath: string): void {
  ensureSecureSensitiveFile(dbPath);
  ensureSecureSensitiveFile(`${dbPath}-wal`);
  ensureSecureSensitiveFile(`${dbPath}-shm`);
}

/** Tightens a just-created file to 0600 right away (called after SQLite creates the database with the default mode). */
export function forceSecureSensitiveFile(filePath: string): void {
  if (!isUnix() || !fs.existsSync(filePath)) return;
  fs.chmodSync(filePath, FILE_MODE);
}
