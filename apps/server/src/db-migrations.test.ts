/**
 * Versioned schema migrations: fresh and legacy panel.db files reach the latest version through the same path,
 * a database newer than the program is refused untouched, a failing step rolls back and the pre-migration copy
 * stays, and a second start changes nothing. Test-only migration lists exercise the runner itself.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { migrateDatabase, type DbMigration, type DbMigrationOptions } from './db-migrations.js';

process.env.JWT_SECRET = 'a'.repeat(64);
process.env.SETUP_TOKEN = 'b'.repeat(64);
process.env.LAUNCHER_TOKEN = 'c'.repeat(64);

const BACKUP_NAME = /^panel-\d{8}T\d{9}Z-v(\d+)\.db$/;

type Scratch = {
  dir: string;
  open(file: string, readOnly?: boolean): DatabaseSync;
};

function scratch(t: test.TestContext, label: string): Scratch {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mystry-db-migrations-${label}-`));
  const opened: DatabaseSync[] = [];
  t.after(async () => {
    for (const db of opened) {
      try {
        db.close();
      } catch {
        /* Already closed by the test */
      }
    }
    const { closeDb } = await import('./db.js');
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    open(file, readOnly = false) {
      const db = new DatabaseSync(path.isAbsolute(file) ? file : path.join(dir, file), { readOnly });
      opened.push(db);
      return db;
    },
  };
}

function useDataDir(s: Scratch): string {
  process.env.MYSTRY_DATA_DIR = s.dir;
  return path.join(s.dir, 'panel.db');
}

function runnerOptions(s: Scratch, extra: Partial<DbMigrationOptions> = {}): DbMigrationOptions {
  return { backupDir: path.join(s.dir, 'db-backups'), backupPrefix: 'panel', keepBackups: 5, ...extra };
}

function openWal(s: Scratch, file = 'panel.db'): DatabaseSync {
  const db = s.open(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

function pragmaNumber(db: DatabaseSync, name: string): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, number>;
  return Number(row[name]);
}

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((column) => column.name)
    .sort();
}

function tableNames(db: DatabaseSync): string[] {
  return (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string }>).map((row) => row.name);
}

function columnMap(db: DatabaseSync): Record<string, string[]> {
  return Object.fromEntries(tableNames(db).map((table) => [table, columns(db, table)]));
}

function schemaDump(db: DatabaseSync): string {
  return JSON.stringify(db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all());
}

function dataDump(db: DatabaseSync): string {
  return JSON.stringify(tableNames(db).map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

function backupsIn(s: Scratch): string[] | null {
  const dir = path.join(s.dir, 'db-backups');
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : null;
}

function rowCount(db: DatabaseSync, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c);
}

async function freshPanelColumns(t: test.TestContext): Promise<Record<string, string[]>> {
  const s = scratch(t, 'reference');
  useDataDir(s);
  const { initDb, getDb, closeDb } = await import('./db.js');
  initDb();
  const map = columnMap(getDb());
  closeDb();
  return map;
}

const items: DbMigration = {
  version: 1,
  name: 'items',
  up: (db) => db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)'),
};
const addNote: DbMigration = {
  version: 2,
  name: 'add note',
  up: (db) => db.exec("ALTER TABLE items ADD COLUMN note TEXT NOT NULL DEFAULT ''"),
};

test('a fresh panel database starts at the latest version, takes no copy, and a second start changes nothing', async (t) => {
  const s = scratch(t, 'fresh');
  useDataDir(s);
  const { initDb, getDb, closeDb, PANEL_DB_MIGRATIONS } = await import('./db.js');

  initDb();
  assert.equal(pragmaNumber(getDb(), 'user_version'), PANEL_DB_MIGRATIONS.length);
  assert.ok(getDb().prepare("SELECT id FROM nodes WHERE id = 'local'").get(), 'the built-in local node exists');
  assert.equal(backupsIn(s), null, 'an empty database is not copied');
  const schema = schemaDump(getDb());
  const data = dataDump(getDb());

  closeDb();
  initDb();
  assert.equal(pragmaNumber(getDb(), 'user_version'), PANEL_DB_MIGRATIONS.length);
  assert.equal(schemaDump(getDb()), schema);
  assert.equal(dataDump(getDb()), data);
  assert.equal(backupsIn(s), null);
});

type LegacyShape = {
  name: string;
  build(db: DatabaseSync): void;
  check(db: DatabaseSync): void;
  /** A column the pre-upgrade copy must still lack */
  missingInCopy: [table: string, column: string];
};

const now = '2026-01-01T00:00:00.000Z';

const legacyShapes: LegacyShape[] = [
  {
    name: 'early: users without token_version, instances and tasks without later columns, no other tables',
    build(db) {
      db.exec(`
        CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE instances (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, core_type TEXT NOT NULL DEFAULT 'custom', mc_version TEXT,
          jar_file TEXT NOT NULL DEFAULT 'server.jar', java_path TEXT NOT NULL DEFAULT 'java',
          jvm_args TEXT NOT NULL DEFAULT '-Xms1G -Xmx2G', accept_eula INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, progress REAL NOT NULL DEFAULT 0,
          message TEXT NOT NULL DEFAULT '', result_json TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
      `);
      db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
        .run('u1', 'admin', '$2a$04$legacyhash', now);
      db.prepare(`INSERT INTO instances (id, name, core_type, mc_version, jvm_args, accept_eula, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('i1', 'Survival', 'paper', '1.21.4', '-Xms2G -Xmx4G', 1, now, now);
      const task = db.prepare('INSERT INTO tasks (id, type, status, message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
      for (const status of ['completed', 'failed', 'running', 'pending']) task.run(`t-${status}`, 'deploy', status, `旧任务 ${status}`, now, now);
    },
    check(db) {
      const user = db.prepare('SELECT username, password_hash, token_version FROM users WHERE id = ?').get('u1') as Record<string, unknown>;
      assert.equal(user.username, 'admin');
      assert.equal(user.password_hash, '$2a$04$legacyhash');
      assert.equal(Number(user.token_version), 0);
      const instance = db.prepare('SELECT * FROM instances WHERE id = ?').get('i1') as Record<string, unknown>;
      assert.equal(instance.name, 'Survival');
      assert.equal(instance.jvm_args, '-Xms2G -Xmx4G');
      assert.equal(Number(instance.accept_eula), 1);
      assert.equal(instance.node_id, 'local');
      assert.equal(instance.install_path, null);
      assert.equal(instance.ownership_marker, null);
      assert.equal(instance.java_runtime_id, null);
      const phases = Object.fromEntries((db.prepare('SELECT id, phase, message, message_i18n FROM tasks').all() as Array<Record<string, unknown>>)
        .map((row) => {
          assert.equal(row.message_i18n, null);
          assert.match(String(row.message), /^旧任务 /);
          return [row.id, row.phase];
        }));
      assert.deepEqual(phases, {
        't-completed': 'completed',
        't-failed': 'failed',
        't-running': 'staging',
        't-pending': 'staging',
      });
    },
    missingInCopy: ['tasks', 'phase'],
  },
  {
    name: 'later: every table present, but instances, java_runtimes, instance_lans and tasks miss their newest columns',
    build(db) {
      db.exec(`
        CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
          token_version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
        CREATE TABLE instances (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, core_type TEXT NOT NULL DEFAULT 'custom', mc_version TEXT,
          jar_file TEXT NOT NULL DEFAULT 'server.jar', java_path TEXT NOT NULL DEFAULT 'java',
          jvm_args TEXT NOT NULL DEFAULT '-Xms1G -Xmx2G', accept_eula INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          install_path TEXT, node_id TEXT NOT NULL DEFAULT 'local', ownership_marker TEXT
        );
        CREATE TABLE nodes (id TEXT PRIMARY KEY, name TEXT NOT NULL, secret_hash TEXT NOT NULL DEFAULT '',
          is_local INTEGER NOT NULL DEFAULT 0, host_info TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, progress REAL NOT NULL DEFAULT 0,
          message TEXT NOT NULL DEFAULT '', result_json TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          phase TEXT
        );
        CREATE TABLE java_runtimes (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, version TEXT, major_version INTEGER,
          source TEXT NOT NULL, verified_at TEXT NOT NULL);
        CREATE TABLE frp_endpoints (id TEXT PRIMARY KEY, name TEXT NOT NULL, server_addr TEXT NOT NULL, server_port INTEGER NOT NULL,
          visit_host TEXT NOT NULL DEFAULT '', transport TEXT NOT NULL, tls INTEGER NOT NULL DEFAULT 1, token TEXT NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE instance_tunnels (instance_id TEXT PRIMARY KEY, endpoint_id TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
          mode TEXT NOT NULL, remote_port INTEGER, visitor_bind_port INTEGER NOT NULL, secret_key TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE CASCADE, FOREIGN KEY (endpoint_id) REFERENCES frp_endpoints(id));
        CREATE TABLE panel_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE instance_lans (instance_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, network_name TEXT NOT NULL,
          network_secret TEXT NOT NULL, ipv4_octet INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE CASCADE);
        CREATE INDEX idx_tasks_status ON tasks(status);
      `);
      db.prepare('INSERT INTO users (id, username, password_hash, token_version, created_at) VALUES (?, ?, ?, ?, ?)')
        .run('u1', 'admin', '$2a$04$laterhash', 3, now);
      db.prepare(`INSERT INTO nodes (id, name, secret_hash, is_local, created_at, updated_at) VALUES ('local', 'Local', '', 1, ?, ?)`)
        .run(now, now);
      db.prepare(`INSERT INTO instances (id, name, install_path, node_id, ownership_marker, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run('i1', 'Creative', null, 'local', 'marker-1', now, now);
      db.prepare(`INSERT INTO java_runtimes (id, path, version, major_version, source, verified_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run('j1', '/opt/java/bin/java', '21.0.5', 21, 'scan', now);
      db.prepare(`INSERT INTO instance_lans (instance_id, enabled, network_name, network_secret, ipv4_octet, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run('i1', 1, 'net-1', 'secret-1', 7, now, now);
      db.prepare('INSERT INTO panel_settings (key, value, updated_at) VALUES (?, ?, ?)').run('downloadSource', 'mirror', now);
      const task = db.prepare('INSERT INTO tasks (id, type, status, phase, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
      task.run('t-done', 'deploy', 'completed', 'completed', now, now);
      task.run('t-null', 'import', 'failed', null, now, now);
    },
    check(db) {
      const user = db.prepare('SELECT token_version FROM users WHERE id = ?').get('u1') as { token_version: number };
      assert.equal(Number(user.token_version), 3);
      const instance = db.prepare('SELECT ownership_marker, java_runtime_id FROM instances WHERE id = ?').get('i1') as Record<string, unknown>;
      assert.equal(instance.ownership_marker, 'marker-1');
      assert.equal(instance.java_runtime_id, null);
      const runtime = db.prepare('SELECT path, available FROM java_runtimes WHERE id = ?').get('j1') as Record<string, unknown>;
      assert.equal(runtime.path, '/opt/java/bin/java');
      assert.equal(Number(runtime.available), 1);
      const lan = db.prepare('SELECT network_secret, custom_peers, use_shared_peers FROM instance_lans WHERE instance_id = ?').get('i1') as Record<string, unknown>;
      assert.equal(lan.network_secret, 'secret-1');
      assert.equal(lan.custom_peers, '[]');
      assert.equal(Number(lan.use_shared_peers), 1);
      const setting = db.prepare('SELECT value FROM panel_settings WHERE key = ?').get('downloadSource') as { value: string };
      assert.equal(setting.value, 'mirror');
      const phases = db.prepare('SELECT id, phase FROM tasks ORDER BY id').all() as Array<{ id: string; phase: string }>;
      assert.deepEqual(phases.map((row) => [row.id, row.phase]), [['t-done', 'completed'], ['t-null', 'failed']]);
      assert.equal(rowCount(db, 'nodes'), 1, 'the existing local node is kept, not duplicated');
    },
    missingInCopy: ['java_runtimes', 'available'],
  },
];

test('legacy databases are copied, then upgraded to the latest version with their data intact', async (t) => {
  const reference = await freshPanelColumns(t);
  for (const shape of legacyShapes) {
    await t.test(shape.name, async (t) => {
      const s = scratch(t, 'legacy');
      const dbPath = useDataDir(s);
      const legacy = new DatabaseSync(dbPath);
      shape.build(legacy);
      legacy.close();

      const { initDb, getDb, closeDb, PANEL_DB_MIGRATIONS } = await import('./db.js');
      initDb();
      const db = getDb();
      assert.equal(pragmaNumber(db, 'user_version'), PANEL_DB_MIGRATIONS.length);
      assert.deepEqual(columnMap(db), reference, 'an upgraded database has the same tables and columns as a fresh one');
      for (const index of ['idx_tasks_status', 'idx_tasks_created_at', 'idx_instances_node_id']) {
        assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(index), index);
      }
      shape.check(db);

      const copies = backupsIn(s);
      assert.equal(copies?.length, 1, `one pre-migration copy: ${copies?.join(', ')}`);
      const [copyName] = copies!;
      assert.equal(BACKUP_NAME.exec(copyName)?.[1], '0', 'the copy is named after the version it holds');
      const copyPath = path.join(s.dir, 'db-backups', copyName);
      const copy = s.open(copyPath, true);
      assert.equal(pragmaNumber(copy, 'user_version'), 0);
      assert.equal((copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
      assert.equal(rowCount(copy, 'users'), 1);
      const [table, column] = shape.missingInCopy;
      assert.ok(!columns(copy, table).includes(column), `the copy predates the upgrade (${table}.${column})`);
      copy.close();
      if (process.platform !== 'win32') {
        assert.equal(fs.statSync(path.join(s.dir, 'db-backups')).mode & 0o777, 0o700);
        assert.equal(fs.statSync(copyPath).mode & 0o777, 0o600);
      }

      const schema = schemaDump(db);
      const data = dataDump(db);
      closeDb();
      initDb();
      assert.equal(schemaDump(getDb()), schema, 'a second start leaves the schema alone');
      assert.equal(dataDump(getDb()), data, 'a second start leaves the data alone');
      assert.deepEqual(backupsIn(s), copies, 'a second start takes no new copy');
    });
  }
});

test('a database newer than the program is refused untouched, naming both versions', async (t) => {
  const s = scratch(t, 'too-new');
  const dbPath = useDataDir(s);
  const { initDb, getDb, closeDb, PANEL_DB_MIGRATIONS } = await import('./db.js');
  const latest = PANEL_DB_MIGRATIONS.length;
  initDb();
  closeDb();
  const raw = new DatabaseSync(dbPath);
  raw.exec(`PRAGMA user_version = ${latest + 5}`);
  const schema = schemaDump(raw);
  raw.close();

  assert.throws(
    () => initDb(),
    (error: unknown) => error instanceof Error
      && error.message.includes(`数据库结构版本为 ${latest + 5}，高于本程序支持的 ${latest}`)
      && error.message.endsWith('拒绝启动'),
  );
  assert.throws(() => getDb(), /数据库尚未初始化/, 'the refused start released the database');

  const after = s.open('panel.db', true);
  assert.equal(pragmaNumber(after, 'user_version'), latest + 5);
  assert.equal(schemaDump(after), schema);
  assert.equal(backupsIn(s), null, 'no copy is taken when refusing');
});

test('a failing step rolls back on its own: earlier steps stay, the version stops before it and the copy remains', (t) => {
  const s = scratch(t, 'mid-failure');
  const db = openWal(s);
  const options = runnerOptions(s);
  migrateDatabase(db, [items], options);
  db.exec("INSERT INTO items (name) VALUES ('alpha'), ('beta')");

  const broken: DbMigration = {
    version: 3,
    name: 'broken',
    up(target) {
      target.exec('CREATE TABLE extra (id INTEGER PRIMARY KEY)');
      target.exec("UPDATE items SET name = 'changed'");
      throw new Error('simulated failure');
    },
  };
  let copyPath = '';
  assert.throws(
    () => migrateDatabase(db, [items, addNote, broken], options),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^数据库结构迁移到版本 3（broken）失败，已回滚，结构版本仍为 2；升级前的副本：/);
      assert.match(error.message, /拒绝启动：simulated failure$/);
      copyPath = /升级前的副本：(.+?)，拒绝启动/.exec(error.message)?.[1] ?? '';
      return true;
    },
  );
  assert.equal(pragmaNumber(db, 'user_version'), 2);
  assert.ok(columns(db, 'items').includes('note'), 'the step before the failure is kept');
  assert.ok(!tableNames(db).includes('extra'), 'the failing step left no table behind');
  assert.deepEqual((db.prepare('SELECT name FROM items ORDER BY id').all() as Array<{ name: string }>).map((r) => r.name), ['alpha', 'beta']);
  assert.equal(pragmaNumber(db, 'foreign_keys'), 1);

  assert.ok(fs.existsSync(copyPath), copyPath);
  assert.equal(BACKUP_NAME.exec(path.basename(copyPath))?.[1], '1');
  const copy = s.open(copyPath, true);
  assert.equal(pragmaNumber(copy, 'user_version'), 1);
  assert.ok(!columns(copy, 'items').includes('note'));
  assert.equal(rowCount(copy, 'items'), 2);

  // The next start with the step fixed resumes from version 2.
  const fixed: DbMigration = { version: 3, name: 'extra', up: (target) => target.exec('CREATE TABLE extra (id INTEGER PRIMARY KEY)') };
  const result = migrateDatabase(db, [items, addNote, fixed], options);
  assert.equal(result.fromVersion, 2);
  assert.equal(result.toVersion, 3);
  assert.equal(pragmaNumber(db, 'user_version'), 3);
  assert.equal(backupsIn(s)?.length, 2);
});

test('when the first pending step fails on an SQL error, the version is unchanged', (t) => {
  const s = scratch(t, 'first-failure');
  const db = openWal(s);
  const options = runnerOptions(s);
  migrateDatabase(db, [items], options);
  const badSql: DbMigration = {
    version: 2,
    name: 'bad sql',
    up: (target) => target.exec("ALTER TABLE items ADD COLUMN note TEXT; ALTER TABLE missing_table ADD COLUMN x TEXT"),
  };
  assert.throws(() => migrateDatabase(db, [items, badSql], options), /版本 2（bad sql）失败，已回滚，结构版本仍为 1.*missing_table/);
  assert.equal(pragmaNumber(db, 'user_version'), 1);
  assert.ok(!columns(db, 'items').includes('note'));
  assert.equal(backupsIn(s)?.length, 1);
});

test('the backup schedule table is added to a database at the version before it, and its rows go with their instance', async (t) => {
  const s = scratch(t, 'backup-schedules');
  useDataDir(s);
  const { initDb, getDb, PANEL_DB_MIGRATIONS } = await import('./db.js');
  // Found by name: the entry may get another number when it is merged after a migration from another branch.
  const index = PANEL_DB_MIGRATIONS.findIndex((migration) => migration.name === 'instance backup schedules');
  assert.ok(index > 0, 'the migration list has the backup schedule entry after the baseline');

  const before = openWal(s);
  migrateDatabase(before, PANEL_DB_MIGRATIONS.slice(0, index), runnerOptions(s));
  assert.ok(!tableNames(before).includes('instance_backup_schedules'));
  before.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'admin', '$2a$04$hash', now);
  const instance = before.prepare('INSERT INTO instances (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)');
  instance.run('i1', 'Survival', now, now);
  instance.run('i2', 'Creative', now, now);
  before.close();

  initDb();
  const db = getDb();
  assert.equal(pragmaNumber(db, 'user_version'), PANEL_DB_MIGRATIONS.length);
  assert.deepEqual(
    (db.prepare('SELECT id, name FROM instances ORDER BY id').all() as Array<{ id: string; name: string }>).map((row) => [row.id, row.name]),
    [['i1', 'Survival'], ['i2', 'Creative']],
  );
  assert.equal(rowCount(db, 'users'), 1);
  assert.equal(rowCount(db, 'instance_backup_schedules'), 0, 'no instance gets a schedule it did not ask for');
  const copies = backupsIn(s);
  assert.equal(copies?.length, 1);
  assert.equal(BACKUP_NAME.exec(copies![0]!)?.[1], String(index), 'the copy holds the version before the upgrade');

  const schedule = db.prepare(
    `INSERT INTO instance_backup_schedules (instance_id, enabled, time_of_day, keep_count, created_at, updated_at)
     VALUES (?, 1, '04:00', 7, ?, ?)`,
  );
  schedule.run('i1', now, now);
  schedule.run('i2', now, now);
  assert.throws(() => schedule.run('missing', now, now), /FOREIGN KEY/);
  assert.throws(() => schedule.run('i1', now, now), /UNIQUE|PRIMARY/, 'one schedule per instance');
  const row = db.prepare('SELECT * FROM instance_backup_schedules WHERE instance_id = ?').get('i1') as Record<string, unknown>;
  assert.equal(row.last_slot, null);
  assert.equal(row.last_backup_at, null);
  assert.equal(Number(row.server_ran), 0);

  db.prepare('DELETE FROM instances WHERE id = ?').run('i1');
  assert.deepEqual(
    (db.prepare('SELECT instance_id FROM instance_backup_schedules').all() as Array<{ instance_id: string }>).map((item) => item.instance_id),
    ['i2'],
  );
});

test('a database that already has the backup schedule table but reports version 0 runs the steps again and keeps its schedules', async (t) => {
  const s = scratch(t, 'backup-schedules-rerun');
  useDataDir(s);
  const { initDb, getDb, closeDb, PANEL_DB_MIGRATIONS } = await import('./db.js');
  initDb();
  const schema = schemaDump(getDb());
  getDb().prepare('INSERT INTO instances (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('i1', 'Survival', now, now);
  getDb().prepare(
    `INSERT INTO instance_backup_schedules
       (instance_id, enabled, time_of_day, keep_count, last_slot, last_backup_at, last_backup_id, server_ran,
        last_failure_at, last_failure, last_failure_i18n, created_at, updated_at)
     VALUES (?, 1, '23:30', 3, '2026-01-01', ?, '20260101-233000-abcdef', 1, ?, 'Not enough disk space.', ?, ?, ?)`,
  ).run('i1', now, now, JSON.stringify({ key: 'server.backups.schedule.diskSpace', params: { needed: 2, available: 1 } }), now, now);
  const schedules = JSON.stringify(getDb().prepare('SELECT * FROM instance_backup_schedules').all());
  // What a database rebuilt from a dump looks like: every table is there, and the version reads 0.
  getDb().exec('PRAGMA user_version = 0');
  closeDb();

  initDb();
  const db = getDb();
  assert.equal(pragmaNumber(db, 'user_version'), PANEL_DB_MIGRATIONS.length);
  assert.equal(schemaDump(db), schema, 'running the steps again leaves the schema as it was');
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM instance_backup_schedules').all()), schedules);
  assert.equal(backupsIn(s)?.length, 1, 'the copy is still taken before the steps run');
});

test('overview run history and metric sample tables are added to a prior version and cascade on instance delete', async (t) => {
  const s = scratch(t, 'overview-stats');
  useDataDir(s);
  const { initDb, getDb, PANEL_DB_MIGRATIONS } = await import('./db.js');
  const index = PANEL_DB_MIGRATIONS.findIndex((migration) => migration.name === 'overview run history and metric samples');
  assert.ok(index > 0, 'the migration list has the overview stats entry after the baseline');

  const before = openWal(s);
  migrateDatabase(before, PANEL_DB_MIGRATIONS.slice(0, index), runnerOptions(s));
  assert.ok(!tableNames(before).includes('instance_runs'));
  assert.ok(!tableNames(before).includes('metric_samples'));
  before.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'admin', '$2a$04$hash', now);
  const instance = before.prepare('INSERT INTO instances (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)');
  instance.run('i1', 'Survival', now, now);
  instance.run('i2', 'Creative', now, now);
  before.close();

  initDb();
  const db = getDb();
  assert.equal(pragmaNumber(db, 'user_version'), PANEL_DB_MIGRATIONS.length);
  for (const idx of ['idx_instance_runs_instance', 'idx_metric_samples_time', 'idx_metric_samples_instance']) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(idx) as { sql: string } | undefined;
    assert.ok(row, idx);
    if (idx === 'idx_metric_samples_instance') {
      assert.match(row.sql, /WHERE instance_id IS NOT NULL/i);
    }
  }

  const insertRun = db.prepare(
    'INSERT INTO instance_runs (instance_id, started_at, ready_at, ended_at, end_reason) VALUES (?, ?, ?, ?, ?)',
  );
  insertRun.run('i1', now, now, null, null);
  insertRun.run('i2', now, now, now, 'stopped');
  assert.throws(() => insertRun.run('missing', now, null, null, null), /FOREIGN KEY/);

  const insertSample = db.prepare(
    'INSERT INTO metric_samples (sampled_at, instance_id, cpu_percent, memory_bytes) VALUES (?, ?, ?, ?)',
  );
  insertSample.run(now, null, 25, 4_000_000_000);
  insertSample.run(now, 'i1', 12, 1_000_000_000);
  insertSample.run(now, 'i2', 8, 500_000_000);
  assert.throws(() => insertSample.run(now, 'missing', 1, 1), /FOREIGN KEY/);

  db.prepare('DELETE FROM instances WHERE id = ?').run('i1');
  assert.deepEqual(
    (db.prepare('SELECT instance_id FROM instance_runs ORDER BY id').all() as Array<{ instance_id: string }>).map((r) => r.instance_id),
    ['i2'],
  );
  assert.deepEqual(
    (db.prepare('SELECT instance_id FROM metric_samples ORDER BY id').all() as Array<{ instance_id: string | null }>).map((r) => r.instance_id),
    [null, 'i2'],
    'deleting an instance cascades its metric rows while keeping host and other instance samples',
  );
});

test('a dump-rebuilt database with overview stats tables at version 0 replays migration v3 without error or data loss', async (t) => {
  const s = scratch(t, 'overview-stats-rerun');
  useDataDir(s);
  const { initDb, getDb, closeDb, PANEL_DB_MIGRATIONS } = await import('./db.js');
  initDb();
  const schema = schemaDump(getDb());
  getDb().prepare('INSERT INTO instances (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('i1', 'Survival', now, now);
  getDb().prepare(
    "INSERT INTO instance_runs (instance_id, started_at, ready_at, ended_at, end_reason) VALUES (?, ?, ?, ?, 'stopped')",
  ).run('i1', now, now, now);
  getDb().prepare(
    'INSERT INTO metric_samples (sampled_at, instance_id, cpu_percent, memory_bytes) VALUES (?, NULL, 30, 8000000000), (?, ?, 15, 2000000000)',
  ).run(now, now, 'i1');
  const runsBefore = JSON.stringify(getDb().prepare('SELECT * FROM instance_runs ORDER BY id').all());
  const samplesBefore = JSON.stringify(getDb().prepare('SELECT * FROM metric_samples ORDER BY id').all());

  getDb().exec('PRAGMA user_version = 0');
  closeDb();

  initDb();
  const db = getDb();
  assert.equal(pragmaNumber(db, 'user_version'), PANEL_DB_MIGRATIONS.length);
  assert.equal(schemaDump(db), schema);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM instance_runs ORDER BY id').all()), runsBefore);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM metric_samples ORDER BY id').all()), samplesBefore);
});

const tree: DbMigration = {
  version: 1,
  name: 'tree',
  up: (db) => db.exec(`
    CREATE TABLE parent (id INTEGER PRIMARY KEY, label TEXT);
    CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE);
  `),
};

function rebuildParent(disableForeignKeys: boolean): DbMigration {
  return {
    version: 2,
    name: 'rebuild parent',
    disableForeignKeys,
    up: (db) => db.exec(`
      CREATE TABLE parent_new (id INTEGER PRIMARY KEY, label TEXT NOT NULL DEFAULT '');
      INSERT INTO parent_new (id, label) SELECT id, COALESCE(label, '') FROM parent;
      DROP TABLE parent;
      ALTER TABLE parent_new RENAME TO parent;
    `),
  };
}

function seedTree(s: Scratch, file: string): DatabaseSync {
  const db = openWal(s, file);
  migrateDatabase(db, [tree], runnerOptions(s, { backupPrefix: path.parse(file).name }));
  db.exec(`
    INSERT INTO parent (id, label) VALUES (1, 'one'), (2, NULL);
    INSERT INTO child (id, parent_id) VALUES (10, 1), (11, 1), (12, 2);
  `);
  return db;
}

test('a table rebuild with foreign keys switched off keeps the rows that reference it', (t) => {
  const s = scratch(t, 'rebuild');
  const db = seedTree(s, 'panel.db');
  migrateDatabase(db, [tree, rebuildParent(true)], runnerOptions(s));
  assert.equal(pragmaNumber(db, 'user_version'), 2);
  assert.equal(rowCount(db, 'child'), 3);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(pragmaNumber(db, 'foreign_keys'), 1, 'foreign keys are back on afterwards');
  assert.equal((db.prepare('SELECT label FROM parent WHERE id = 2').get() as { label: string }).label, '');

  // Why the flag exists: with foreign keys on, DROP TABLE deletes the parent rows first and the cascade takes the children.
  const control = seedTree(s, 'control.db');
  migrateDatabase(control, [tree, rebuildParent(false)], runnerOptions(s, { backupPrefix: 'control' }));
  assert.equal(rowCount(control, 'child'), 0);
});

test('a step that leaves a broken reference is rolled back and foreign keys come back on', (t) => {
  const s = scratch(t, 'fk-violation');
  const db = seedTree(s, 'panel.db');
  const orphan: DbMigration = {
    version: 2,
    name: 'orphan',
    disableForeignKeys: true,
    up: (target) => target.exec('INSERT INTO child (id, parent_id) VALUES (99, 12345)'),
  };
  assert.throws(() => migrateDatabase(db, [tree, orphan], runnerOptions(s)), /版本 2（orphan）失败.*外键检查未通过：1 处/);
  assert.equal(pragmaNumber(db, 'user_version'), 1);
  assert.equal(db.prepare('SELECT 1 FROM child WHERE id = 99').get(), undefined);
  assert.equal(pragmaNumber(db, 'foreign_keys'), 1);
});

test('a list with a gap in its versions is rejected before the database is touched', (t) => {
  const s = scratch(t, 'bad-list');
  const db = openWal(s);
  const skipped: DbMigration = { ...addNote, version: 3 };
  assert.throws(() => migrateDatabase(db, [items, skipped], runnerOptions(s)), /数据库迁移列表无效：第 2 项的版本应为 2，实际为 3/);
  assert.equal(pragmaNumber(db, 'user_version'), 0);
  assert.deepEqual(tableNames(db), []);
  assert.equal(backupsIn(s), null);
});

test('the copy includes rows still in the WAL and is a self-contained file', (t) => {
  const s = scratch(t, 'wal-copy');
  const db = openWal(s);
  db.exec('PRAGMA wal_autocheckpoint = 0');
  migrateDatabase(db, [items], runnerOptions(s));
  const insert = db.prepare('INSERT INTO items (name) VALUES (?)');
  db.exec('BEGIN');
  for (let i = 0; i < 2000; i += 1) insert.run(`row-${i}`);
  db.exec('COMMIT');
  assert.ok(fs.statSync(path.join(s.dir, 'panel.db-wal')).size > 0, 'precondition: the rows are only in the WAL');

  const { backupPath } = migrateDatabase(db, [items, addNote], runnerOptions(s));
  assert.ok(backupPath);
  const copy = s.open(backupPath, true);
  assert.equal(rowCount(copy, 'items'), 2000);
  assert.equal((copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
  assert.equal((copy.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'delete');
  assert.equal(pragmaNumber(copy, 'user_version'), 1);
  assert.ok(!fs.existsSync(`${backupPath}-wal`));
});

test('only the newest copies are kept, unrelated files stay and a half-written copy is cleared', (t) => {
  const s = scratch(t, 'retention');
  const db = openWal(s);
  migrateDatabase(db, [items], runnerOptions(s));
  const backupDir = path.join(s.dir, 'db-backups');
  fs.mkdirSync(backupDir, { mode: 0o700 });
  fs.writeFileSync(path.join(backupDir, 'notes.txt'), 'keep me');
  fs.writeFileSync(path.join(backupDir, 'panel-20000101T000000000Z-v1.db'), 'oldest copy');
  fs.writeFileSync(path.join(backupDir, 'panel-20000101T000000000Z-v1.db.partial'), 'interrupted copy');

  const failing: DbMigration = { version: 2, name: 'failing', up: () => { throw new Error('still broken'); } };
  // A clock that stands still (several starts in one millisecond) must still name each copy after the previous one.
  const options = runnerOptions(s, { now: () => new Date('2026-11-23T04:00:00.000Z') });
  for (let start = 0; start < 7; start += 1) {
    assert.throws(() => migrateDatabase(db, [items, failing], options), /still broken/);
  }
  assert.deepEqual(fs.readdirSync(backupDir).sort(), [
    'notes.txt',
    'panel-20261123T040000002Z-v1.db',
    'panel-20261123T040000003Z-v1.db',
    'panel-20261123T040000004Z-v1.db',
    'panel-20261123T040000005Z-v1.db',
    'panel-20261123T040000006Z-v1.db',
  ]);

  // Nor may a clock set back a year make the newest copy look like the oldest and get pruned straight away.
  assert.throws(
    () => migrateDatabase(db, [items, failing], runnerOptions(s, { now: () => new Date('2025-11-23T04:00:00.000Z') })),
    /still broken/,
  );
  assert.deepEqual(fs.readdirSync(backupDir).sort().slice(-2), [
    'panel-20261123T040000006Z-v1.db',
    'panel-20261123T040000007Z-v1.db',
  ]);
  assert.equal(fs.readdirSync(backupDir).length, 6);
});

test('if the copy cannot be written, nothing is migrated', (t) => {
  const s = scratch(t, 'copy-fails');
  const db = openWal(s);
  migrateDatabase(db, [items], runnerOptions(s));
  fs.writeFileSync(path.join(s.dir, 'db-backups'), 'a file where the directory should be');
  assert.throws(() => migrateDatabase(db, [items, addNote], runnerOptions(s)), /^Error: 迁移前备份数据库失败，未做任何结构变更，拒绝启动：/);
  assert.equal(pragmaNumber(db, 'user_version'), 1);
  assert.ok(!columns(db, 'items').includes('note'));
});
