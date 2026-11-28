import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { migrateDatabase, type DbMigration } from './db-migrations.js';
import { STAGING_ROOT_DIR } from './services/task-staging-service.js';
import {
  finalizeSensitiveDataFiles,
  forceSecureSensitiveFile,
  prepareSecureDataLayout,
} from './utils/data-dir-permissions.js';

export type UserRow = {
  id: string;
  username: string;
  password_hash: string;
  /** Token version: incremented on every password change or reset; issued JWTs carry it, and a mismatch invalidates them */
  token_version: number;
  created_at: string;
};

export type InstanceRow = {
  id: string;
  name: string;
  core_type: string;
  mc_version: string | null;
  jar_file: string;
  java_path: string;
  jvm_args: string;
  accept_eula: number;
  install_path: string | null;
  /** Ownership marker of the default managed directory; empty for legacy instances */
  ownership_marker: string | null;
  /** ID of the owning node, defaults to the built-in local node 'local' */
  node_id: string;
  /** ID of the bound Java runtime (java_runtimes.id); NULL means use the java on PATH */
  java_runtime_id: string | null;
  created_at: string;
  updated_at: string;
};

/** Java runtimes the panel detected and verified; paths may only come from the panel's scan and are never accepted from requests */
export type JavaRuntimeRow = {
  id: string;
  path: string;
  version: string | null;
  major_version: number | null;
  source: 'env' | 'scan' | 'panel';
  verified_at: string;
  /** Whether the latest full scan still found and verified this runtime */
  available: number;
};

/** Node: the local node (built in, id='local') or a remote Agent node */
export type NodeRow = {
  id: string;
  name: string;
  /** Hash of the node secret (sha256 hex); the local node needs no secret, so it is an empty string */
  secret_hash: string;
  is_local: number;
  /** Host info reported by the Agent (JSON string); may be empty for the local node */
  host_info: string | null;
  created_at: string;
  updated_at: string;
};

export type TaskRow = {
  id: string;
  type: string;
  status: string;
  /** Task file phase: staging / finalizing / completed / failed; may be NULL in old databases */
  phase: string | null;
  progress: number;
  message: string;
  /** Progress message key and params (JSON); NULL in old databases and old tasks, in which case only the message text is shown */
  message_i18n: string | null;
  result_json: string | null;
  error: string | null;
  /** Failure reason message key and params (JSON); NULL for old tasks and raw errors that cannot be classified */
  error_i18n: string | null;
  created_at: string;
  updated_at: string;
};

/** The daily automatic backup of one instance, with what the scheduler has to remember across panel restarts. */
export type BackupScheduleRow = {
  instance_id: string;
  enabled: number;
  /** HH:MM, read on the clock of the computer the panel runs on */
  time_of_day: string;
  keep_count: number;
  /**
   * Calendar date (YYYY-MM-DD, panel computer's clock) of the latest daily slot that is settled: backed up, failed,
   * skipped, or older than the schedule itself. A later slot that has come is due, however many were missed in between.
   * NULL until the schedule is first enabled.
   */
  last_slot: string | null;
  /** The latest scheduled backup that succeeded: when it was taken, and its ID */
  last_backup_at: string | null;
  last_backup_id: string | null;
  /** Whether the server has run, or files were changed through the panel, since last_backup_at */
  server_ran: number;
  /** Set while the latest scheduled run is a failed one, with its reason as text and as a message key with params (JSON) */
  last_failure_at: string | null;
  last_failure: string | null;
  last_failure_i18n: string | null;
  created_at: string;
  updated_at: string;
};

/** One start-to-exit run of an instance; ended_at is NULL while the server is still running. */
export type InstanceRunRow = {
  id: number;
  instance_id: string;
  started_at: string;
  /** UTC ISO-8601 time the server printed its ready marker; NULL when it never finished starting. */
  ready_at: string | null;
  ended_at: string | null;
  end_reason: 'stopped' | 'crashed' | 'start-failed' | 'panel-exit' | null;
  /** OS process ID of the spawned server; NULL before spawn or in pre-v5 databases. */
  pid: number | null;
  /** Platform-specific process start identity (e.g. linux:<bootId>:<ticks> or win32:<ticks>) to detect PID reuse. */
  process_identity: string | null;
};

let db: DatabaseSync | undefined;

export function closeDb(): void {
  if (db) {
    db.close();
    db = undefined;
  }
}

export function getDb(): DatabaseSync {
  if (!db) {
    throw new Error('数据库尚未初始化');
  }
  return db;
}

/**
 * Pre-migration copies of panel.db, under DATA_DIR. Kept apart from backups/, which holds instance backups
 * and can be moved elsewhere with BACKUP_DIR.
 */
const DB_BACKUP_DIR_NAME = 'db-backups';
const DB_BACKUPS_KEPT = 5;

/**
 * Schema history of panel.db, applied in order at startup and recorded in PRAGMA user_version.
 * Append new entries with the next version number; never edit, remove or reorder an entry that has shipped,
 * because databases already past it will not run it again.
 */
export const PANEL_DB_MIGRATIONS: readonly DbMigration[] = [
  { version: 1, name: 'baseline schema', up: applyBaselineSchema },
  { version: 2, name: 'instance backup schedules', up: createBackupSchedules },
  { version: 3, name: 'overview run history and metric samples', up: createOverviewStatsTables },
  { version: 4, name: 'overview network and disk io samples', up: addMetricSampleIoColumns },
  { version: 5, name: 'instance run process tracking', up: addInstanceRunProcessColumns },
];

export function initDb(): void {
  prepareSecureDataLayout(config.dataDir, [
    'instances',
    'imports',
    path.join('cache', 'cores'),
    'uploads',
    STAGING_ROOT_DIR,
    '.mystry-panel-lock',
  ]);

  db = new DatabaseSync(config.dbPath);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    // SQLite creates the main database and WAL/SHM files with the process umask; tighten them to 0600 right away
    forceSecureSensitiveFile(config.dbPath);
    forceSecureSensitiveFile(`${config.dbPath}-wal`);
    forceSecureSensitiveFile(`${config.dbPath}-shm`);
    finalizeSensitiveDataFiles(config.dbPath);

    migrateDatabase(db, PANEL_DB_MIGRATIONS, {
      backupDir: path.join(config.dataDir, DB_BACKUP_DIR_NAME),
      backupPrefix: 'panel',
      keepBackups: DB_BACKUPS_KEPT,
    });

    ensureLocalNode();

    const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number };
    if (Number(userCount.c) === 0 && config.setupToken === null) {
      throw new Error('用户表为空且未配置 SETUP_TOKEN，拒绝启动');
    }
  } catch (error) {
    // A refused start must not keep panel.db open: on Windows the handle would block replacing or restoring the file.
    closeDb();
    throw error;
  }
}

/**
 * Version 1: the schema as it stood before versioned migrations. Databases from before then all report
 * user_version 0 in whichever shape they had reached, so every step here checks before it changes anything.
 * Leave it as it is; later changes are new entries in PANEL_DB_MIGRATIONS.
 */
function applyBaselineSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      token_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS instances (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      core_type TEXT NOT NULL DEFAULT 'custom',
      mc_version TEXT,
      jar_file TEXT NOT NULL DEFAULT 'server.jar',
      java_path TEXT NOT NULL DEFAULT 'java',
      jvm_args TEXT NOT NULL DEFAULT '-Xms1G -Xmx2G',
      accept_eula INTEGER NOT NULL DEFAULT 0,
      install_path TEXT,
      ownership_marker TEXT,
      node_id TEXT NOT NULL DEFAULT 'local',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      secret_hash TEXT NOT NULL DEFAULT '',
      is_local INTEGER NOT NULL DEFAULT 0,
      host_info TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      progress REAL NOT NULL DEFAULT 0,
      message TEXT NOT NULL DEFAULT '',
      result_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS java_runtimes (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      version TEXT,
      major_version INTEGER,
      source TEXT NOT NULL,
      verified_at TEXT NOT NULL,
      available INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS frp_endpoints (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      server_addr TEXT NOT NULL,
      server_port INTEGER NOT NULL,
      visit_host TEXT NOT NULL DEFAULT '',
      transport TEXT NOT NULL,
      tls INTEGER NOT NULL DEFAULT 1,
      token TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS instance_tunnels (
      instance_id TEXT PRIMARY KEY,
      endpoint_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL,
      remote_port INTEGER,
      visitor_bind_port INTEGER NOT NULL,
      secret_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE CASCADE,
      FOREIGN KEY (endpoint_id) REFERENCES frp_endpoints(id)
    );

    CREATE TABLE IF NOT EXISTS panel_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS instance_lans (
      instance_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      network_name TEXT NOT NULL,
      network_secret TEXT NOT NULL,
      ipv4_octet INTEGER NOT NULL,
      custom_peers TEXT NOT NULL DEFAULT '[]',
      use_shared_peers INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE CASCADE
    );
  `);

  // Compatibility with existing databases: add the token version column to old users tables, with existing users starting at 0.
  // A single ALTER is atomic, so a failure leaves no half-migrated state; old tokens carry no version and are treated as 0, so after the upgrade they keep working until they expire or the password changes.
  const userCols = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
  if (!userCols.some((c) => c.name === 'token_version')) {
    db.exec('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0');
  }

  // Compatibility with existing databases: add the instance directory safety fields
  let cols = db.prepare(`PRAGMA table_info(instances)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'install_path')) {
    db.exec('ALTER TABLE instances ADD COLUMN install_path TEXT');
  }
  if (!cols.some((c) => c.name === 'node_id')) {
    db.exec("ALTER TABLE instances ADD COLUMN node_id TEXT NOT NULL DEFAULT 'local'");
  }
  cols = db.prepare(`PRAGMA table_info(instances)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'ownership_marker')) {
    db.exec('ALTER TABLE instances ADD COLUMN ownership_marker TEXT');
  }
  if (!cols.some((c) => c.name === 'java_runtime_id')) {
    db.exec('ALTER TABLE instances ADD COLUMN java_runtime_id TEXT');
  }
  // Custom relay peers for the virtual LAN: add the column to old databases, defaulting to the community shared peers so behavior is unchanged.
  const lanCols = db.prepare('PRAGMA table_info(instance_lans)').all() as Array<{ name: string }>;
  if (!lanCols.some((c) => c.name === 'custom_peers')) {
    db.exec("ALTER TABLE instance_lans ADD COLUMN custom_peers TEXT NOT NULL DEFAULT '[]'");
  }
  if (!lanCols.some((c) => c.name === 'use_shared_peers')) {
    db.exec('ALTER TABLE instance_lans ADD COLUMN use_shared_peers INTEGER NOT NULL DEFAULT 1');
  }
  const runtimeCols = db.prepare('PRAGMA table_info(java_runtimes)').all() as Array<{ name: string }>;
  if (!runtimeCols.some((c) => c.name === 'available')) {
    db.exec('ALTER TABLE java_runtimes ADD COLUMN available INTEGER NOT NULL DEFAULT 1');
  }

  let taskCols = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
  if (!taskCols.some((c) => c.name === 'phase')) {
    db.exec('ALTER TABLE tasks ADD COLUMN phase TEXT');
  }
  taskCols = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
  migrateLegacyTaskPhases(db, taskCols);
  // Localized task messages: only nullable columns are added; old tasks stay NULL and keep showing their existing text.
  if (!taskCols.some((c) => c.name === 'message_i18n')) {
    db.exec('ALTER TABLE tasks ADD COLUMN message_i18n TEXT');
  }
  if (!taskCols.some((c) => c.name === 'error_i18n')) {
    db.exec('ALTER TABLE tasks ADD COLUMN error_i18n TEXT');
  }

  // Indexes must come after the column migrations; CREATE INDEX fails when an old database is missing the column.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
    CREATE INDEX IF NOT EXISTS idx_instances_node_id ON instances(node_id);
  `);
}

/**
 * A database can report an earlier version than its tables show: one rebuilt from a dump keeps its tables and reports
 * user_version 0, and then runs every step again. So the table is created only when it is missing, and the schedules
 * already in it are left as they are.
 */
function createBackupSchedules(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS instance_backup_schedules (
      instance_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      time_of_day TEXT NOT NULL,
      keep_count INTEGER NOT NULL,
      last_slot TEXT,
      last_backup_at TEXT,
      last_backup_id TEXT,
      server_ran INTEGER NOT NULL DEFAULT 0,
      last_failure_at TEXT,
      last_failure TEXT,
      last_failure_i18n TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE CASCADE
    );
  `);
}

/**
 * Version 3: instance run history and 5-minute host/instance resource samples for the overview dashboard.
 * Uses IF NOT EXISTS on every table and index so a database rebuilt from a dump (user_version 0 with tables intact)
 * can replay the migration without error or data loss; the partial index on metric_samples.instance_id avoids full-table
 * scans when deleting an instance triggers ON DELETE CASCADE.
 */
function createOverviewStatsTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS instance_runs (
      id INTEGER PRIMARY KEY,
      instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      started_at TEXT NOT NULL,
      ready_at TEXT,
      ended_at TEXT,
      end_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_instance_runs_instance ON instance_runs(instance_id, started_at);

    CREATE TABLE IF NOT EXISTS metric_samples (
      id INTEGER PRIMARY KEY,
      sampled_at TEXT NOT NULL,
      instance_id TEXT REFERENCES instances(id) ON DELETE CASCADE,
      cpu_percent REAL,
      memory_bytes INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_metric_samples_time ON metric_samples(sampled_at, instance_id);
    CREATE INDEX IF NOT EXISTS idx_metric_samples_instance ON metric_samples(instance_id) WHERE instance_id IS NOT NULL;
  `);
}

const METRIC_SAMPLE_IO_COLUMNS = [
  'net_rx_bytes_per_sec',
  'net_tx_bytes_per_sec',
  'disk_read_bytes_per_sec',
  'disk_write_bytes_per_sec',
] as const;

/**
 * Version 4: host network and disk I/O rates on metric_samples. SQLite has no ADD COLUMN IF NOT EXISTS,
 * so each column is checked first; a database rebuilt from a dump (user_version 0, columns present) replays this as a no-op.
 */
function addMetricSampleIoColumns(db: DatabaseSync): void {
  const existing = new Set(
    (db.prepare('PRAGMA table_info(metric_samples)').all() as Array<{ name: string }>).map((column) => column.name),
  );
  for (const column of METRIC_SAMPLE_IO_COLUMNS) {
    if (!existing.has(column)) db.exec(`ALTER TABLE metric_samples ADD COLUMN ${column} REAL`);
  }
}

/**
 * Version 5: OS PID and process identity on instance_runs for detached-process detection across restarts.
 * Checked column by column so dump-rebuilt databases at user_version 0 replay without error.
 */
function addInstanceRunProcessColumns(db: DatabaseSync): void {
  const existing = new Set(
    (db.prepare('PRAGMA table_info(instance_runs)').all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!existing.has('pid')) db.exec('ALTER TABLE instance_runs ADD COLUMN pid INTEGER');
  if (!existing.has('process_identity')) db.exec('ALTER TABLE instance_runs ADD COLUMN process_identity TEXT');
}

/** Backfills phase for old task rows; idempotent and safe to run repeatedly. */
function migrateLegacyTaskPhases(db: DatabaseSync, taskCols: Array<{ name: string }>): void {
  if (!taskCols.some((c) => c.name === 'phase')) return;
  db.exec(`
    UPDATE tasks SET phase = 'completed'
    WHERE phase IS NULL AND status = 'completed';
    UPDATE tasks SET phase = 'failed'
    WHERE phase IS NULL AND status = 'failed';
    UPDATE tasks SET phase = 'staging'
    WHERE phase IS NULL AND status IN ('pending', 'running');
  `);
}

/** Ensures the built-in local node exists (the panel itself, representing the local execution capability that spawns directly) */
function ensureLocalNode(): void {
  const row = getDb().prepare('SELECT id FROM nodes WHERE id = ?').get('local');
  if (row) return;
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO nodes (id, name, secret_hash, is_local, host_info, created_at, updated_at)
     VALUES ('local', '本机节点', '', 1, NULL, ?, ?)`,
  ).run(now, now);
}
