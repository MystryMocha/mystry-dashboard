import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { writeFileAtomic } from '../utils/atomic-write.js';
import { hasErrorCode } from '../utils/errors.js';

const require = createRequire(import.meta.url);
const panelVersion: string = (require('../../package.json') as { version: string }).version;

const LOCK_DIR_NAME = '.mystry-panel-lock';
const OWNER_FILE = 'owner.json';

export type PanelLockOwner = {
  pid: number;
  fingerprint: string;
  version: string;
  createdAt: string;
};

export type PanelDataLock = {
  dataDir: string;
  lockDir: string;
  owner: PanelLockOwner;
  release: () => void;
};

function lockDirPath(dataDir: string): string {
  return path.join(dataDir, LOCK_DIR_NAME);
}

function readOwner(lockDir: string): PanelLockOwner | null {
  const ownerPath = path.join(lockDir, OWNER_FILE);
  if (!fs.existsSync(ownerPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) as PanelLockOwner;
    if (
      typeof parsed.pid !== 'number'
      || typeof parsed.fingerprint !== 'string'
      || typeof parsed.version !== 'string'
      || typeof parsed.createdAt !== 'string'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Tells whether a PID is still alive; treated as alive when it cannot be confirmed, to avoid double writes to the database. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH confirms the process does not exist; EPERM (which platforms such as Windows may return for a live process) and other errors are all treated as alive.
    return !hasErrorCode(error, 'ESRCH');
  }
}

function writeOwner(lockDir: string, owner: PanelLockOwner): void {
  writeFileAtomic(path.join(lockDir, OWNER_FILE), `${JSON.stringify(owner)}\n`);
}

/** Cleans up quarantine lock directories older than 7 days, so junk directories do not pile up after repeated abnormal panel exits. */
function cleanupOldQuarantines(dataDir: string): void {
  const cutoffMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
  try {
    for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(`${LOCK_DIR_NAME}.quarantine.`)) continue;
      const dir = path.join(dataDir, entry.name);
      try {
        if (fs.statSync(dir).mtimeMs < cutoffMs) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      } catch {
        /* A failure to clean one directory does not affect the others */
      }
    }
  } catch {
    /* Skip cleanup when the data directory is unreadable */
  }
}

function quarantineStaleLock(dataDir: string, lockDir: string): boolean {
  cleanupOldQuarantines(dataDir);
  const quarantineName = `${LOCK_DIR_NAME}.quarantine.${Date.now()}.${process.pid}.${nanoid(8)}`;
  const quarantinePath = path.join(dataDir, quarantineName);
  try {
    fs.renameSync(lockDir, quarantinePath);
    return true;
  } catch {
    return false;
  }
}

function lockConflictError(dataDir: string, owner: PanelLockOwner | null): Error {
  const pidText = owner ? String(owner.pid) : '未知';
  return new Error(
    `数据目录已被其他面板进程占用（${dataDir}）。`
      + `记录 PID：${pidText}。`
      + '请先关闭已运行的面板，或在确认该进程已退出后手动检查 '
      + `\`${path.join(dataDir, LOCK_DIR_NAME)}\` 与 \`owner.json\`，勿删除实例或世界目录。`,
  );
}

function tryAcquireOnce(dataDir: string): PanelDataLock | 'exists' {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lockDir = lockDirPath(dataDir);
  try {
    fs.mkdirSync(lockDir, { mode: 0o700 });
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) {
      return 'exists';
    }
    throw error;
  }

  const owner: PanelLockOwner = {
    pid: process.pid,
    fingerprint: config.processFingerprint ?? nanoid(16),
    version: panelVersion,
    createdAt: new Date().toISOString(),
  };
  try {
    writeOwner(lockDir, owner);
  } catch (error) {
    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {
      /* Ignore cleanup failures */
    }
    throw error;
  }

  let released = false;
  return {
    dataDir,
    lockDir,
    owner,
    release: () => {
      if (released) return;
      released = true;
      try {
        const current = readOwner(lockDir);
        if (current?.pid === owner.pid && current.fingerprint === owner.fingerprint) {
          fs.rmSync(lockDir, { recursive: true, force: true });
        }
      } catch {
        /* A release failure is not thrown, so it does not mask the original shutdown error */
      }
    },
  };
}

/**
 * Acquires the data directory lifecycle lock; startup is refused when a live PID holds the lock.
 */
export function acquirePanelDataLock(dataDir: string = config.dataDir): PanelDataLock {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = tryAcquireOnce(dataDir);
    if (result !== 'exists') return result;

    const lockDir = lockDirPath(dataDir);
    const owner = readOwner(lockDir);
    if (owner && isProcessAlive(owner.pid)) {
      throw lockConflictError(dataDir, owner);
    }
    if (!owner) {
      // When the owner cannot be parsed, do not risk deleting; treat it as still held
      throw lockConflictError(dataDir, owner);
    }

    if (!quarantineStaleLock(dataDir, lockDir)) {
      continue;
    }
  }

  throw new Error(`无法取得数据目录锁（${dataDir}），请稍后重试或检查是否有其他面板正在启动。`);
}
