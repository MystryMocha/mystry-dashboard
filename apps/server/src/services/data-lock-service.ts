import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { writeFileAtomic } from '../utils/atomic-write.js';

const require = createRequire(import.meta.url);
const panelVersion: string = (require('../../package.json') as { version: string }).version;

const LOCK_DB_NAME = '.mystry-panel-lock.db';
const LOCK_DIR_NAME = '.mystry-panel-lock';
const OWNER_FILE = 'owner.json';
/** The launcher probes the lock by taking it for an instant; wait that out instead of failing a real startup. */
const LOCK_BUSY_TIMEOUT_MS = 1_000;
const SQLITE_BUSY = 5;

/** Diagnostic record of the lock holder. It names the process in messages and is never used to decide liveness. */
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

function readOwner(lockDir: string): PanelLockOwner | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(lockDir, OWNER_FILE), 'utf8')) as PanelLockOwner;
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

/** Removes quarantine directories left by the earlier directory-based lock once they are older than 7 days. */
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

function lockConflictError(dataDir: string, owner: PanelLockOwner | null): Error {
  const pidText = owner ? String(owner.pid) : '未知';
  return new Error(
    `数据目录已被其他面板进程占用（${dataDir}）。`
      + `记录 PID：${pidText}。`
      + '请先关闭已运行的面板；若它已不再响应，通常是在等它启动的 Minecraft 服务器退出。'
      + '勿删除实例或世界目录。',
  );
}

function isSqliteBusy(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { errcode?: unknown }).errcode === SQLITE_BUSY;
}

/**
 * Acquires the data directory lifecycle lock; startup is refused while another process holds it.
 *
 * The lock is an exclusive SQLite transaction on a dedicated database, kept open for the life of the process. The
 * operating system drops it when the holder exits, however it exits, so no PID, clock or boot-time reasoning is needed
 * to tell a live holder from a vanished one.
 *
 * Two rules keep it sound on POSIX, where file locks belong to the process rather than the handle: nothing in this
 * process may open the lock database except this connection (closing any other handle would drop the lock), and the
 * file is never deleted or renamed (a newcomer would lock a fresh file while the old holder keeps the unlinked one).
 * On every platform the caller must keep the returned object referenced until release: a connection that becomes
 * garbage is closed by the collector, which silently drops the lock.
 */
export function acquirePanelDataLock(dataDir: string = config.dataDir): PanelDataLock {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lockDir = path.join(dataDir, LOCK_DIR_NAME);
  const lockDbPath = path.join(dataDir, LOCK_DB_NAME);

  const connection = new DatabaseSync(lockDbPath);
  let owner: PanelLockOwner;
  try {
    connection.exec(`PRAGMA busy_timeout = ${LOCK_BUSY_TIMEOUT_MS}`);
    try {
      connection.exec('BEGIN EXCLUSIVE');
    } catch (error) {
      throw isSqliteBusy(error) ? lockConflictError(dataDir, readOwner(lockDir)) : error;
    }
    if (process.platform !== 'win32') fs.chmodSync(lockDbPath, 0o600);

    // Whatever is in the lock directory now was left by a holder that is gone.
    fs.rmSync(lockDir, { recursive: true, force: true });
    fs.mkdirSync(lockDir, { mode: 0o700 });
    owner = {
      pid: process.pid,
      fingerprint: config.processFingerprint ?? nanoid(16),
      version: panelVersion,
      createdAt: new Date().toISOString(),
    };
    writeFileAtomic(path.join(lockDir, OWNER_FILE), `${JSON.stringify(owner)}\n`);
  } catch (error) {
    connection.close();
    throw error;
  }
  cleanupOldQuarantines(dataDir);

  let released = false;
  return {
    dataDir,
    lockDir,
    owner,
    release: () => {
      if (released) return;
      released = true;
      try {
        fs.rmSync(lockDir, { recursive: true, force: true });
      } catch {
        /* A release failure is not thrown, so it does not mask the original shutdown error */
      }
      try {
        connection.close();
      } catch {
        /* Same as above; the lock is dropped when the process exits regardless */
      }
    },
  };
}
