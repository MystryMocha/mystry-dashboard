import { spawnSync } from 'node:child_process';
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

export type WindowsAclRunner = (
  executable: string,
  args: readonly string[],
) => { status: number | null; stdout: string; stderr: string; error?: Error };

export type WindowsUserIdentity = {
  account: string;
  sid: string;
};

export type WindowsAclEntry = {
  principal: string;
  permissions: string;
};

export type WindowsAclInspection =
  | { status: 'secure' }
  | { status: 'permissive'; principals: string[] }
  | { status: 'unverified'; reason: string };

let windowsAclChecked = false;
const startupNotices: string[] = [];

/** Takes the startup notices so the panel logs and displays them once during startup. */
export function takeStartupNotices(): string[] {
  return startupNotices.splice(0);
}

/** Tests only: resets the once-per-process Windows ACL inspection flag and queued notices. */
export function resetWindowsAclCheckForTests(): void {
  windowsAclChecked = false;
  startupNotices.length = 0;
}

function isUnix(): boolean {
  return process.platform !== 'win32';
}

export function isDataPermissionRepairEnabled(): boolean {
  return process.env.MYSTRY_REPAIR_DATA_PERMISSIONS === '1';
}

const defaultWindowsAclRunner: WindowsAclRunner = (executable, args) => {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
};

/** Parses `whoami /user /fo csv /nh` output into account name and SID. */
export function parseWindowsUserIdentity(output: string): WindowsUserIdentity | null {
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^"([^"]+)","(S-1-[^"]+)"$/i.exec(line);
    if (match?.[1] && match[2]) {
      return { account: match[1].trim(), sid: match[2].trim() };
    }
  }
  return null;
}

/** Parses `icacls <path>` stdout lines into principal/permission entries in a locale-independent way. */
export function parseIcaclsOutput(output: string, targetPath: string): WindowsAclEntry[] {
  const normalizedTarget = path.resolve(targetPath);
  const trimmedTarget = normalizedTarget.length > 3 && normalizedTarget.endsWith('\\')
    ? normalizedTarget.slice(0, -1)
    : normalizedTarget;
  const entries: WindowsAclEntry[] = [];
  const lines = output.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    let candidate = lines[index] ?? '';
    if (!candidate.trim()) {
      if (entries.length > 0) break;
      continue;
    }
    if (index === 0) {
      const lowered = candidate.toLowerCase();
      if (lowered.startsWith(normalizedTarget.toLowerCase())) {
        candidate = candidate.slice(normalizedTarget.length);
      } else if (lowered.startsWith(trimmedTarget.toLowerCase())) {
        candidate = candidate.slice(trimmedTarget.length);
      } else {
        const prefixTrimmed = candidate.trimStart();
        const aceStart = prefixTrimmed.indexOf(' ', /^[A-Za-z]:\\/.test(prefixTrimmed) ? 3 : 0);
        if (aceStart > 0) candidate = prefixTrimmed.slice(aceStart);
      }
    }
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    const match = /^(.+?):((?:\([^)]+\))+)$/.exec(trimmed);
    if (!match?.[1] || !match[2]) continue;
    entries.push({ principal: match[1].trim(), permissions: match[2].trim() });
  }
  return entries;
}

function isAllowedWindowsPrincipal(principal: string, currentUser: WindowsUserIdentity | null): boolean {
  const lower = principal.trim().toLowerCase();
  if (!lower) return false;
  if (lower.startsWith('mandatory label\\') || lower.startsWith('ml\\') || lower.startsWith('s-1-16-')) {
    return true;
  }
  if (currentUser) {
    if (lower === currentUser.account.toLowerCase() || lower === currentUser.sid.toLowerCase()) {
      return true;
    }
  }
  if (
    lower === 's-1-5-18'
    || lower === 's-1-5-32-544'
    || lower === 's-1-3-0'
    || lower === 'nt authority\\system'
    || lower === 'builtin\\administrators'
    || lower === 'creator owner'
  ) {
    return true;
  }
  return /(?:^|\\)(?:system|administrators|administratoren|administrateurs|administradores|администраторы)$/.test(lower);
}

/** Returns principals granted access outside current user, SYSTEM, Administrators and CREATOR OWNER. */
export function findPermissiveWindowsPrincipals(
  entries: readonly WindowsAclEntry[],
  currentUser: WindowsUserIdentity | null,
): string[] {
  const permissive = new Set<string>();
  for (const entry of entries) {
    // Explicit deny and zero-access entries do not grant access.
    if (/\((?:DENY|N)\)/i.test(entry.permissions)) continue;
    if (!isAllowedWindowsPrincipal(entry.principal, currentUser)) {
      permissive.add(entry.principal);
    }
  }
  return [...permissive];
}

/** Inspects a directory's Windows ACL via `whoami` and `icacls` so overly broad inherited permissions are flagged. */
export function inspectWindowsDirectoryAcl(
  dirPath: string,
  runner: WindowsAclRunner = defaultWindowsAclRunner,
): WindowsAclInspection {
  const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const whoamiResult = runner(path.join(sys32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
  if (whoamiResult.error || whoamiResult.status !== 0) {
    return {
      status: 'unverified',
      reason: whoamiResult.error?.message || whoamiResult.stderr.trim() || `whoami exit ${whoamiResult.status ?? 'unknown'}`,
    };
  }
  const currentUser = parseWindowsUserIdentity(whoamiResult.stdout);
  if (!currentUser) {
    return { status: 'unverified', reason: '无法解析当前 Windows 用户 SID' };
  }

  const icaclsResult = runner(path.join(sys32, 'icacls.exe'), [path.resolve(dirPath)]);
  if (icaclsResult.error || icaclsResult.status !== 0) {
    return {
      status: 'unverified',
      reason: icaclsResult.error?.message || icaclsResult.stderr.trim() || `icacls exit ${icaclsResult.status ?? 'unknown'}`,
    };
  }
  const entries = parseIcaclsOutput(icaclsResult.stdout, dirPath);
  if (entries.length === 0) {
    return { status: 'unverified', reason: 'icacls 未返回可识别的 ACL 条目' };
  }
  const principals = findPermissiveWindowsPrincipals(entries, currentUser);
  if (principals.length > 0) {
    return { status: 'permissive', principals };
  }
  return { status: 'secure' };
}

export function warnWindowsAclBoundary(
  targetPath: string,
  runner: WindowsAclRunner = defaultWindowsAclRunner,
): void {
  if (windowsAclChecked || isUnix()) return;
  windowsAclChecked = true;
  const inspection = inspectWindowsDirectoryAcl(targetPath, runner);
  if (inspection.status === 'secure') return;
  if (inspection.status === 'permissive') {
    startupNotices.push(
      `Windows 目录「${targetPath}」权限过宽，以下其他账户或组具有访问权限：${inspection.principals.join('、')}。`
        + '请改用 mdash 启动以自动收紧权限，或手动通过 icacls 仅保留当前用户、SYSTEM 与 Administrators。详见 docs/configuration.zh-CN.md。',
    );
    return;
  }
  startupNotices.push(
    `无法在 Windows 上自动验证「${targetPath}」的 ACL（${inspection.reason}）。`
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
    if (isUnix()) {
      fs.chmodSync(dirPath, DIR_MODE);
      return;
    }
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
