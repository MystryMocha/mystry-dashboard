import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ensureSecureDirectory, forceSecureSensitiveFile } from './utils/data-dir-permissions.js';

/** One step of a database's schema history; its position in the list is its version, recorded in PRAGMA user_version. */
export type DbMigration = {
  /** Schema version after this step. The list counts up from 1 without gaps. */
  version: number;
  /** Short label for the startup error when this step fails. */
  name: string;
  /**
   * Runs inside the transaction that also sets user_version, so a throw undoes everything it did.
   * It must not BEGIN, COMMIT or ROLLBACK itself, and PRAGMA foreign_keys is a no-op inside a transaction:
   * use disableForeignKeys instead.
   */
  up(db: DatabaseSync): void;
  /**
   * For table rebuilds (create, copy, drop, rename): with foreign keys on, dropping the old table would
   * cascade-delete or reject the rows that reference it. Foreign keys are switched off before the transaction
   * starts and back on after it ends, and the step commits only if PRAGMA foreign_key_check finds nothing.
   */
  disableForeignKeys?: boolean;
};

export type DbMigrationOptions = {
  /** Where the copy taken before migrating goes; created only when a copy is taken. */
  backupDir: string;
  /** File name prefix of the copies, e.g. "panel" for panel-20261123T040000000Z-v1.db. */
  backupPrefix: string;
  /** Number of copies kept; older ones with the same prefix are deleted after a new copy succeeds. */
  keepBackups: number;
  now?: () => Date;
};

export type DbMigrationResult = {
  fromVersion: number;
  toVersion: number;
  /** The copy taken before migrating, or null when nothing was pending or the database was still empty. */
  backupPath: string | null;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertMigrationList(migrations: readonly DbMigration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(
        `数据库迁移列表无效：第 ${index + 1} 项的版本应为 ${index + 1}，实际为 ${migration.version}`,
      );
    }
  });
}

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return Number(row.user_version);
}

function hasTables(db: DatabaseSync): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1").get() !== undefined;
}

function foreignKeysEnabled(db: DatabaseSync): boolean {
  const row = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
  return Number(row.foreign_keys) === 1;
}

function rollbackQuietly(db: DatabaseSync): void {
  try {
    db.exec('ROLLBACK');
  } catch {
    // SQLite already rolls back on some errors (disk full, I/O); a second ROLLBACK then reports no active transaction.
  }
}

function applyMigration(db: DatabaseSync, migration: DbMigration): void {
  const restoreForeignKeys = migration.disableForeignKeys === true && foreignKeysEnabled(db);
  if (migration.disableForeignKeys) db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      // isTransaction is missing on older Node 22 releases; there the COMMIT below still fails, just after the fact.
      if (db.isTransaction === false) {
        throw new Error('迁移步骤自行结束了事务');
      }
      if (migration.disableForeignKeys) {
        const violations = db.prepare('PRAGMA foreign_key_check').all();
        if (violations.length > 0) {
          throw new Error(`外键检查未通过：${violations.length} 处引用指向不存在的行`);
        }
      }
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (error) {
      rollbackQuietly(db);
      throw error;
    }
  } finally {
    // Only once the transaction has ended: inside one, switching foreign keys back on would be ignored.
    if (restoreForeignKeys) db.exec('PRAGMA foreign_keys = ON');
  }
}

function backupStamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, '');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function backupNamePattern(prefix: string, suffix = ''): RegExp {
  return new RegExp(`^${escapeRegExp(prefix)}-(\\d{8}T\\d{9}Z)-v\\d+\\.db${escapeRegExp(suffix)}$`);
}

function stampTime(stamp: string): number {
  const [, y, mo, d, h, mi, s, ms] = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/.exec(stamp)!;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(ms));
}

/** Existing copies, oldest first: the fixed-width timestamp leads the name, so name order is age order. */
function listBackups(dir: string, prefix: string): string[] {
  const pattern = backupNamePattern(prefix);
  return fs.readdirSync(dir).filter((name) => pattern.test(name)).sort();
}

function fsyncFile(filePath: string): void {
  // VACUUM INTO does not sync its output; without this, a power cut right after startup could leave a truncated copy.
  const fd = fs.openSync(filePath, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function pruneBackups(dir: string, prefix: string, keep: number): void {
  const copies = listBackups(dir, prefix).reverse();
  for (const name of copies.slice(Math.max(keep, 1))) {
    fs.rmSync(path.join(dir, name), { force: true });
  }
}

/**
 * Writes a consistent copy of the open database with VACUUM INTO. Unlike checkpointing and copying the file,
 * this includes pages still in the WAL and stays correct while another connection holds a read transaction
 * (which would stop a checkpoint from finishing and leave a copied file malformed). The copy is a single file
 * in rollback-journal mode, written under a temporary name and renamed only once it is complete.
 */
export function backupDatabase(
  db: DatabaseSync,
  version: number,
  options: DbMigrationOptions,
): string {
  const { backupDir, backupPrefix } = options;
  ensureSecureDirectory(backupDir);
  // Left behind only if a previous start died mid-copy; never a usable backup.
  const partialPattern = backupNamePattern(backupPrefix, '.partial');
  for (const name of fs.readdirSync(backupDir)) {
    if (partialPattern.test(name)) fs.rmSync(path.join(backupDir, name), { force: true });
  }

  // The new copy must sort after every existing one even if the clock stood still or went back;
  // otherwise pruning would treat it as the oldest and delete the copy just taken.
  let time = (options.now ?? (() => new Date()))().getTime();
  const newest = listBackups(backupDir, backupPrefix).at(-1);
  if (newest) {
    time = Math.max(time, stampTime(backupNamePattern(backupPrefix).exec(newest)![1]) + 1);
  }
  const target = path.join(backupDir, `${backupPrefix}-${backupStamp(new Date(time))}-v${version}.db`);

  const partial = `${target}.partial`;
  try {
    db.prepare('VACUUM INTO ?').run(partial);
    forceSecureSensitiveFile(partial);
    fsyncFile(partial);
    fs.renameSync(partial, target);
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw error;
  }
  pruneBackups(backupDir, backupPrefix, options.keepBackups);
  return target;
}

/**
 * Brings the database up to the last version in the list. A database newer than the list is refused untouched.
 * When steps are pending and the database already has tables, a copy is taken first; if that fails nothing is changed.
 * Each step commits on its own, so a failure keeps the steps before it and leaves user_version at the last one that succeeded.
 */
export function migrateDatabase(
  db: DatabaseSync,
  migrations: readonly DbMigration[],
  options: DbMigrationOptions,
): DbMigrationResult {
  assertMigrationList(migrations);
  const latest = migrations.length;
  const current = readUserVersion(db);
  if (current < 0) {
    throw new Error(`数据库结构版本 ${current} 无效，拒绝启动`);
  }
  if (current > latest) {
    throw new Error(
      `数据库结构版本为 ${current}，高于本程序支持的 ${latest}，可能已被更新版本的面板升级过；`
        + `请改用更新版本的面板，或停止面板后用「${options.backupDir}」中升级前的副本替换数据库，拒绝启动`,
    );
  }
  if (current === latest) {
    return { fromVersion: current, toVersion: current, backupPath: null };
  }

  let backupPath: string | null = null;
  if (hasTables(db)) {
    try {
      backupPath = backupDatabase(db, current, options);
    } catch (error) {
      throw new Error(`迁移前备份数据库失败，未做任何结构变更，拒绝启动：${errorText(error)}`, { cause: error });
    }
  }

  let version = current;
  for (const migration of migrations.slice(current)) {
    try {
      applyMigration(db, migration);
    } catch (error) {
      const backupNote = backupPath ? `；升级前的副本：${backupPath}` : '';
      throw new Error(
        `数据库结构迁移到版本 ${migration.version}（${migration.name}）失败，已回滚，`
          + `结构版本仍为 ${version}${backupNote}，拒绝启动：${errorText(error)}`,
        { cause: error },
      );
    }
    version = migration.version;
  }
  return { fromVersion: current, toVersion: version, backupPath };
}
