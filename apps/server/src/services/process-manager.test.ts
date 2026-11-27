/**
 * Process mutual exclusion and stop semantics regression.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { InstanceRow } from '../db.js';
import {
  captureProcessIdentityAsync,
  verifyTrackedProcessAlive,
} from '../utils/process-inspect.js';

function prepareTempDataRoot(t: test.TestContext): string {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-process-mgr-test-'));
  t.after(async () => {
    try {
      const { closeDb } = await import('../db.js');
      closeDb();
    } catch {
      /* The module may not be loaded yet */
    }
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });
  process.env.MYSTRY_DATA_DIR = dataRoot;
  process.env.JWT_SECRET = 'a'.repeat(64);
  process.env.SETUP_TOKEN = 'b'.repeat(64);
  return dataRoot;
}

function fakeChild(options?: { onKill?: (signal?: NodeJS.Signals) => void }): ChildProcessWithoutNullStreams {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, {
    pid: Math.floor(Math.random() * 100_000) + 10_000,
    stdin,
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    kill: (signal?: NodeJS.Signals) => {
      options?.onKill?.(signal);
      return true;
    },
  });
  setImmediate(() => child.emit('spawn'));
  return child;
}

test('concurrent start should spawn only one managed Minecraft process', async (t) => {
  prepareTempDataRoot(t);
  const { ProcessManager } = await import('./process-manager.js');
  const { initDb } = await import('../db.js');
  const { createInstance, getInstanceRow } = await import('./instance-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const info = createInstance({ name: 'concurrent-start' });
  const instanceDir = defaultInstanceDir(info.id);
  fs.writeFileSync(path.join(instanceDir, 'server.jar'), 'stub-jar');
  const row = getInstanceRow(info.id)!;

  let spawnCount = 0;
  const manager = new ProcessManager(
    () => {
      spawnCount += 1;
      return fakeChild();
    },
    async () => 'java',
  );

  await Promise.allSettled([
    manager.start(row as InstanceRow),
    manager.start(row as InstanceRow),
  ]);

  assert.equal(spawnCount, 1);
});

test('the first start writes normal difficulty, and an existing server.properties is not overwritten', async (t) => {
  prepareTempDataRoot(t);
  const { ProcessManager } = await import('./process-manager.js');
  const { initDb } = await import('../db.js');
  const { createInstance, getInstanceRow } = await import('./instance-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const missing = createInstance({ name: 'start-default-difficulty' });
  const existing = createInstance({ name: 'start-preserve-difficulty' });
  const missingDir = defaultInstanceDir(missing.id);
  const existingDir = defaultInstanceDir(existing.id);
  fs.writeFileSync(path.join(missingDir, 'server.jar'), 'stub-jar');
  fs.writeFileSync(path.join(existingDir, 'server.jar'), 'stub-jar');
  const existingProperties = 'difficulty=hard\nmotd=keep\n';
  fs.writeFileSync(path.join(existingDir, 'server.properties'), existingProperties, 'utf8');

  const manager = new ProcessManager(
    () => fakeChild(),
    async () => 'java',
  );
  await manager.start(getInstanceRow(missing.id)! as InstanceRow);
  await manager.start(getInstanceRow(existing.id)! as InstanceRow);

  assert.match(
    fs.readFileSync(path.join(missingDir, 'server.properties'), 'utf8'),
    /^difficulty=normal$/m,
  );
  assert.equal(
    fs.readFileSync(path.join(existingDir, 'server.properties'), 'utf8'),
    existingProperties,
  );
});

test('an exit with the EULA not accepted is recorded as stopped with a reason; a Java mismatch is recorded as crashed; starting again clears the reason', async (t) => {
  prepareTempDataRoot(t);
  const { ProcessManager } = await import('./process-manager.js');
  const { initDb } = await import('../db.js');
  const { createInstance, getInstanceRow } = await import('./instance-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const info = createInstance({ name: 'start-issue' });
  fs.writeFileSync(path.join(defaultInstanceDir(info.id), 'server.jar'), 'stub-jar');
  const row = getInstanceRow(info.id)! as InstanceRow;

  const children: ChildProcessWithoutNullStreams[] = [];
  const manager = new ProcessManager(
    () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
    async () => 'java',
  );
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  await manager.start(row);
  children[0].stdout.emit('data', Buffer.from(
    '[13:23:04] [Server thread/INFO]: You need to agree to the EULA in order to run the server. Go to eula.txt for more info.\n',
  ));
  await flush();
  children[0].emit('exit', 0, null);
  assert.equal(manager.getStatus(info.id), 'stopped');
  assert.deepEqual(manager.getStartIssue(info.id), { kind: 'eula', requiredJava: null });

  await manager.start(row);
  assert.equal(manager.getStartIssue(info.id), null, '启动中不应保留上一次的原因');
  children[1].stderr.emit('data', Buffer.from(
    'java.lang.ClassCastException: class jdk.internal.loader.ClassLoaders$AppClassLoader cannot be cast to class java.net.URLClassLoader\n',
  ));
  await flush();
  children[1].emit('exit', 1, null);
  assert.equal(manager.getStatus(info.id), 'crashed');
  assert.deepEqual(manager.getStartIssue(info.id), { kind: 'java-too-new', requiredJava: 8 });

  // An exit after the user deliberately stopped it is not diagnosed.
  await manager.start(row);
  children[2].stderr.emit('data', Buffer.from('java.lang.UnsupportedClassVersionError: x (class file version 65.0)\n'));
  await flush();
  const stopping = manager.stop(info.id);
  await flush();
  children[2].emit('exit', 0, null);
  await stopping;
  assert.equal(manager.getStatus(info.id), 'stopped');
  assert.equal(manager.getStartIssue(info.id), null);
});

test('withdrawing EULA acceptance in instance settings: eula.txt goes back to false and later starts no longer write true; an instance that never accepted keeps its eula.txt untouched; refused during a restore', async (t) => {
  prepareTempDataRoot(t);
  const { ProcessManager, processManager, InstanceOperationConflictError } = await import('./process-manager.js');
  const { initDb } = await import('../db.js');
  const { createInstance, getInstance, getInstanceRow, updateInstanceSettings } = await import('./instance-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const agreed = createInstance({ name: 'eula-revoke', acceptEula: true });
  const imported = createInstance({ name: 'eula-imported', acceptEula: false });
  const agreedEula = path.join(defaultInstanceDir(agreed.id), 'eula.txt');
  const importedEula = path.join(defaultInstanceDir(imported.id), 'eula.txt');
  fs.writeFileSync(path.join(defaultInstanceDir(agreed.id), 'server.jar'), 'stub-jar');
  fs.writeFileSync(path.join(defaultInstanceDir(imported.id), 'server.jar'), 'stub-jar');
  // The imported server comes with its own acceptance record, and it is not checked in the panel.
  fs.writeFileSync(importedEula, 'eula=true\n', 'utf8');

  const children: ChildProcessWithoutNullStreams[] = [];
  const manager = new ProcessManager(() => {
    const child = fakeChild();
    children.push(child);
    return child;
  }, async () => 'java');

  await manager.start(getInstanceRow(agreed.id)! as InstanceRow);
  assert.equal(fs.readFileSync(agreedEula, 'utf8'), 'eula=true\n');
  children[0].emit('exit', 0, null);

  await updateInstanceSettings(agreed.id, { acceptEula: false });
  assert.equal(getInstance(agreed.id)?.acceptEula, false);
  assert.equal(fs.readFileSync(agreedEula, 'utf8'), 'eula=false\n');
  await manager.start(getInstanceRow(agreed.id)! as InstanceRow);
  assert.equal(fs.readFileSync(agreedEula, 'utf8'), 'eula=false\n', '不同意时启动不写 eula.txt');
  children[1].emit('exit', 0, null);

  // Never checked: saving (even with acceptEula: false) does not change the existing file, and neither does starting.
  await updateInstanceSettings(imported.id, { name: 'eula-imported-2', acceptEula: false });
  assert.equal(fs.readFileSync(importedEula, 'utf8'), 'eula=true\n');
  await manager.start(getInstanceRow(imported.id)! as InstanceRow);
  assert.equal(fs.readFileSync(importedEula, 'utf8'), 'eula=true\n');
  children[2].emit('exit', 0, null);

  // Restoring a backup replaces the whole directory, so files written now would be lost: rejected, with both the database and the files unchanged.
  await updateInstanceSettings(agreed.id, { acceptEula: true });
  fs.writeFileSync(agreedEula, 'eula=true\n', 'utf8');
  const endMaintenance = processManager.beginMaintenance(agreed.id, 'server.backups.busyRestoring');
  t.after(endMaintenance);
  await assert.rejects(updateInstanceSettings(agreed.id, { acceptEula: false }), InstanceOperationConflictError);
  assert.equal(getInstance(agreed.id)?.acceptEula, true);
  assert.equal(fs.readFileSync(agreedEula, 'utf8'), 'eula=true\n');
  // Settings that do not touch eula.txt, such as a rename, can still be saved as usual.
  await updateInstanceSettings(agreed.id, { name: 'eula-revoke-renamed' });
  assert.equal(getInstance(agreed.id)?.name, 'eula-revoke-renamed');
  endMaintenance();
});

test('a normal stop timing out must not implicitly SIGKILL', async (t) => {
  prepareTempDataRoot(t);
  process.env.MYSTRY_TEST_STOP_GRACE_MS = '40';
  t.after(() => {
    delete process.env.MYSTRY_TEST_STOP_GRACE_MS;
  });

  const { ProcessManager, isInstanceStopPendingError } = await import('./process-manager.js');
  const { initDb } = await import('../db.js');
  const { createInstance, getInstanceRow } = await import('./instance-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const info = createInstance({ name: 'stop-timeout' });
  fs.writeFileSync(path.join(defaultInstanceDir(info.id), 'server.jar'), 'stub-jar');
  const row = getInstanceRow(info.id)!;

  const killSignals: Array<string | undefined> = [];
  const manager = new ProcessManager(
    () => fakeChild({ onKill: (signal) => killSignals.push(signal) }),
    async () => 'java',
  );

  await manager.start(row as InstanceRow);
  await assert.rejects(
    () => manager.stop(row.id),
    (err: unknown) => isInstanceStopPendingError(err),
  );
  assert.deepEqual(killSignals, []);
  assert.equal(manager.getStatus(row.id), 'stopping');
});

test('on shutdown a server that missed the first stop gets it once more, and one that ignores both is reported as still running', async (t) => {
  prepareTempDataRoot(t);
  process.env.MYSTRY_TEST_STOP_GRACE_MS = '40';
  t.after(() => {
    delete process.env.MYSTRY_TEST_STOP_GRACE_MS;
  });

  const { ProcessManager } = await import('./process-manager.js');
  const { initDb } = await import('../db.js');
  const { createInstance, getInstanceRow } = await import('./instance-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const late = createInstance({ name: 'stops-on-second-stop' });
  const stuck = createInstance({ name: 'never-stops' });
  for (const info of [late, stuck]) fs.writeFileSync(path.join(defaultInstanceDir(info.id), 'server.jar'), 'stub-jar');

  const stops = new Map<string, number>();
  const killSignals: Array<string | undefined> = [];
  const manager = new ProcessManager(
    (_command, _args, options) => {
      const id = String(options.cwd).includes(late.id) ? late.id : stuck.id;
      const child = fakeChild({ onKill: (signal) => killSignals.push(signal) });
      child.stdin.on('data', (chunk: Buffer) => {
        if (!chunk.toString('utf8').includes('stop')) return;
        const count = (stops.get(id) ?? 0) + 1;
        stops.set(id, count);
        // Like a server that dropped the stop it received while still loading.
        if (id === late.id && count === 2) {
          Object.assign(child, { exitCode: 0 });
          child.emit('exit', 0, null);
        }
      });
      return child;
    },
    async () => 'java',
  );

  await manager.start(getInstanceRow(late.id) as InstanceRow);
  await manager.start(getInstanceRow(stuck.id) as InstanceRow);
  const result = await manager.stopAll();

  assert.equal(stops.get(late.id), 2);
  assert.equal(stops.get(stuck.id), 2);
  assert.deepEqual(result.stillStopping, [stuck.id]);
  assert.deepEqual(result.errors, []);
  assert.equal(manager.getStatus(late.id), 'stopped');
  // Still no forced kill: the server keeps its chance to save.
  assert.deepEqual(killSignals, []);
});

test('a Forge start rewrites user_jvm_args.txt with the normalized arguments', async (t) => {
  prepareTempDataRoot(t);
  const { ProcessManager } = await import('./process-manager.js');
  const { initDb } = await import('../db.js');
  const { createInstance, getInstanceRow } = await import('./instance-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');
  const { parseJvmArgFile } = await import('@mystry/shared');

  initDb();
  const info = createInstance({
    name: 'forge-args',
    coreType: 'forge',
    jarFile: '@args:libraries/net/minecraftforge/forge/win_args.txt',
    jvmArgs: String.raw`-Xms1G -Xmx2G "-Dfolder=C:\Minecraft Server"`,
  });
  const instanceDir = defaultInstanceDir(info.id);
  const argsFile = path.join(instanceDir, 'libraries', 'net', 'minecraftforge', 'forge', 'win_args.txt');
  fs.mkdirSync(path.dirname(argsFile), { recursive: true });
  fs.writeFileSync(argsFile, '--launchTarget forge_server', 'utf8');
  const row = getInstanceRow(info.id)!;

  let spawnedArgs: readonly string[] = [];
  const manager = new ProcessManager(
    (_command, args) => {
      spawnedArgs = [...args];
      return fakeChild();
    },
    async () => 'java',
  );
  await manager.start(row as InstanceRow);

  assert.deepEqual(spawnedArgs, [
    '@user_jvm_args.txt',
    '@libraries/net/minecraftforge/forge/win_args.txt',
    'nogui',
  ]);
  assert.deepEqual(
    parseJvmArgFile(fs.readFileSync(path.join(instanceDir, 'user_jvm_args.txt'), 'utf8')),
    ['-Xms1G', '-Xmx2G', String.raw`-Dfolder=C:\Minecraft Server`],
  );
});

test('a Forge start switches a foreign-platform @args: record to the current platform sibling when present', async (t) => {
  prepareTempDataRoot(t);
  const { ProcessManager } = await import('./process-manager.js');
  const { initDb } = await import('../db.js');
  const { createInstance, getInstanceRow } = await import('./instance-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const baseDir = 'libraries/net/minecraftforge/forge/1.20.1-47.2.0';
  const foreignFile = process.platform === 'win32' ? 'unix_args.txt' : 'win_args.txt';
  const nativeFile = process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';
  const info = createInstance({
    name: 'forge-cross-os',
    coreType: 'forge',
    jarFile: `@args:${baseDir}/${foreignFile}`,
  });
  const instanceDir = defaultInstanceDir(info.id);
  const fullDir = path.join(instanceDir, ...baseDir.split('/'));
  fs.mkdirSync(fullDir, { recursive: true });
  fs.writeFileSync(path.join(fullDir, 'win_args.txt'), '-cp a;b', 'utf8');
  fs.writeFileSync(path.join(fullDir, 'unix_args.txt'), '-cp a:b', 'utf8');

  let spawnedArgs: readonly string[] = [];
  const manager = new ProcessManager(
    (_command, args) => {
      spawnedArgs = [...args];
      return fakeChild();
    },
    async () => 'java',
  );
  await manager.start(getInstanceRow(info.id)! as InstanceRow);

  assert.deepEqual(spawnedArgs, [
    '@user_jvm_args.txt',
    `@${baseDir}/${nativeFile}`,
    'nogui',
  ]);
});

test('delete must wait for an unfinished start, and a directory being started must not be torn down', async (t) => {
  prepareTempDataRoot(t);
  const { processManager } = await import('./process-manager.js');
  const { initDb } = await import('../db.js');
  const { createInstance, deleteInstance, getInstanceRow } = await import('./instance-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const info = createInstance({ name: 'delete-lock' });
  const instanceDir = defaultInstanceDir(info.id);
  fs.writeFileSync(path.join(instanceDir, 'server.jar'), 'stub-jar');
  const row = getInstanceRow(info.id)!;

  let releaseJava!: () => void;
  const javaGate = new Promise<void>((resolve) => {
    releaseJava = resolve;
  });
  const singleton = processManager as unknown as {
    spawnMinecraft: (...args: unknown[]) => ChildProcessWithoutNullStreams;
    resolveJavaCommand: (id: string | null) => Promise<string>;
  };
  const originalSpawn = singleton.spawnMinecraft;
  const originalResolve = singleton.resolveJavaCommand;
  singleton.spawnMinecraft = () => {
    const child = fakeChild({
      onKill() {
        Object.assign(child, { exitCode: 1 });
        child.emit('exit', 1, 'SIGKILL');
      },
    });
    return child;
  };
  singleton.resolveJavaCommand = async () => {
    await javaGate;
    return 'java';
  };
  t.after(async () => {
    singleton.spawnMinecraft = originalSpawn;
    singleton.resolveJavaCommand = originalResolve;
    try {
      await processManager.stop(info.id, true);
    } catch {
      /* The instance may already be stopped */
    }
  });

  const startPromise = processManager.start(row as InstanceRow);
  const deletePromise = deleteInstance(info.id);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(fs.existsSync(instanceDir), 'start 持锁期间删除不得先拆目录');
  assert.ok(getInstanceRow(info.id), 'start 持锁期间删除不得先删库行');

  releaseJava();
  await startPromise;
  await assert.rejects(deletePromise, { messageKey: 'server.instance.deleteRunning' });
  assert.equal(processManager.isRunning(info.id), true);
});

async function waitForStatus(
  manager: { getStatus(id: string): string },
  instanceId: string,
  expected: string,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (manager.getStatus(instanceId) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(manager.getStatus(instanceId), expected);
}

test('a start that has not spawned yet is cancelled on shutdown, leaving no orphan process', async (t) => {
  prepareTempDataRoot(t);
  const { ProcessManager } = await import('./process-manager.js');
  const { initDb } = await import('../db.js');
  const { createInstance, getInstanceRow } = await import('./instance-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const info = createInstance({ name: 'shutdown-cancel-start' });
  fs.writeFileSync(path.join(defaultInstanceDir(info.id), 'server.jar'), 'stub-jar');
  const row = getInstanceRow(info.id)!;

  let spawnCount = 0;
  let releaseJava!: () => void;
  const javaGate = new Promise<void>((resolve) => {
    releaseJava = resolve;
  });
  const manager = new ProcessManager(
    () => {
      spawnCount += 1;
      return fakeChild();
    },
    async () => {
      await javaGate;
      return 'java';
    },
  );

  const startPromise = manager.start(row as InstanceRow);
  await waitForStatus(manager, info.id, 'starting');
  const stopAllPromise = manager.stopAll();
  releaseJava();

  await assert.rejects(startPromise, { messageKey: 'server.instance.startCancelledShuttingDown' });
  const result = await stopAllPromise;
  assert.equal(spawnCount, 0);
  assert.equal(manager.getRunningCount(), 0);
  assert.equal(manager.getStatus(info.id), 'stopped');
  assert.equal(result.attempted, 0);
});

test('new starts are refused after shutdown', async (t) => {
  prepareTempDataRoot(t);
  const { ProcessManager } = await import('./process-manager.js');
  const { initDb } = await import('../db.js');
  const { createInstance, getInstanceRow } = await import('./instance-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const info = createInstance({ name: 'shutdown-reject-start' });
  fs.writeFileSync(path.join(defaultInstanceDir(info.id), 'server.jar'), 'stub-jar');
  const row = getInstanceRow(info.id)!;

  let spawnCount = 0;
  const manager = new ProcessManager(
    () => {
      spawnCount += 1;
      return fakeChild();
    },
    async () => 'java',
  );
  manager.beginShutdown();

  await assert.rejects(() => manager.start(row as InstanceRow), { messageKey: 'server.instance.startShuttingDown' });
  assert.equal(spawnCount, 0);
  assert.equal(manager.getRunningCount(), 0);
});

test('a sent command is written to stdin and echoed to the console history as "> command"', async (t) => {
  prepareTempDataRoot(t);
  const { ProcessManager } = await import('./process-manager.js');
  const { initDb } = await import('../db.js');
  const { createInstance, getInstanceRow } = await import('./instance-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const info = createInstance({ name: 'command-echo' });
  fs.writeFileSync(path.join(defaultInstanceDir(info.id), 'server.jar'), 'stub-jar');
  const children: ChildProcessWithoutNullStreams[] = [];
  const manager = new ProcessManager(
    () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
    async () => 'java',
  );
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  await manager.start(getInstanceRow(info.id)! as InstanceRow);
  const written: string[] = [];
  children[0].stdin.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')));
  children[0].stdout.emit('data', Buffer.from('[13:23:09] [Server thread/INFO]: Done (4.512s)! For help, type "help"\n'));
  await flush();

  manager.sendCommand(info.id, 'list');
  // When the previous output chunk stopped mid-line, the echo starts on a new line.
  children[0].stdout.emit('data', Buffer.from('> '));
  await flush();
  manager.sendCommand(info.id, 'save-all');
  await flush();

  assert.deepEqual(written, ['list\n', 'save-all\n']);
  assert.match(manager.getHistory(info.id), /help"\n> list\n> \n> save-all\n$/);
});

test('marked as joinable after the finished-startup marker line is printed; cleared after stop or exit', async (t) => {
  prepareTempDataRoot(t);
  const { ProcessManager } = await import('./process-manager.js');
  const { initDb } = await import('../db.js');
  const { createInstance, getInstanceRow } = await import('./instance-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const info = createInstance({ name: 'ready-flag' });
  fs.writeFileSync(path.join(defaultInstanceDir(info.id), 'server.jar'), 'stub-jar');
  const row = getInstanceRow(info.id)! as InstanceRow;

  const children: ChildProcessWithoutNullStreams[] = [];
  const manager = new ProcessManager(
    () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
    async () => 'java',
  );
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(manager.isReady(info.id), false);
  await manager.start(row);
  children[0].stdout.emit('data', Buffer.from('[13:23:04] [Server thread/INFO]: Preparing spawn area: 83%\n'));
  // The same words appearing in player chat do not count.
  children[0].stdout.emit('data', Buffer.from('[13:23:05] [Server thread/INFO]: <Steve> Done (1s)\n'));
  await flush();
  assert.equal(manager.getStatus(info.id), 'running');
  assert.equal(manager.isReady(info.id), false);

  // The marker line must be recognized even when split across two output chunks.
  children[0].stdout.emit('data', Buffer.from('[13:23:09] [Server thread/INFO]: Do'));
  children[0].stdout.emit('data', Buffer.from('ne (4.512s)! For help, type "help"\n'));
  await flush();
  assert.equal(manager.isReady(info.id), true);

  const stopping = manager.stop(info.id);
  await flush();
  assert.equal(manager.isReady(info.id), false, '正在停止时不再提示可以进服');
  children[0].emit('exit', 0, null);
  await stopping;
  assert.equal(manager.isReady(info.id), false);
});

test('when the bound Java is unavailable or no longer in the registry, the instance info reports java-unavailable without waiting for a start', async (t) => {
  prepareTempDataRoot(t);
  const { initDb, getDb } = await import('../db.js');
  const { createInstance, getInstance, listInstances } = await import('./instance-service.js');

  initDb();
  const info = createInstance({ name: 'java-gone' });
  assert.equal(getInstance(info.id)?.startIssue, null, '用系统默认 Java 的实例不提前报问题');

  const db = getDb();
  db.prepare(
    'INSERT INTO java_runtimes (id, path, version, major_version, source, verified_at, available) VALUES (?, ?, ?, ?, ?, ?, 1)',
  ).run('rt-test', path.join(os.tmpdir(), 'mystry-missing-java'), '21.0.1', 21, 'scan', new Date().toISOString());
  db.prepare('UPDATE instances SET java_runtime_id = ? WHERE id = ?').run('rt-test', info.id);
  assert.equal(getInstance(info.id)?.startIssue, null, '登记为可用的运行时不提前报问题');

  db.prepare('UPDATE java_runtimes SET available = 0 WHERE id = ?').run('rt-test');
  assert.deepEqual(getInstance(info.id)?.startIssue, { kind: 'java-unavailable', requiredJava: null });

  db.prepare('DELETE FROM java_runtimes WHERE id = ?').run('rt-test');
  assert.deepEqual(
    listInstances().find((item) => item.id === info.id)?.startIssue,
    { kind: 'java-unavailable', requiredJava: null },
  );

  db.prepare('UPDATE instances SET java_runtime_id = NULL WHERE id = ?').run(info.id);
  assert.equal(getInstance(info.id)?.startIssue, null, '改回系统默认 Java 后提示消失');
});

test('run history persists spawned PID and process identity, keeps verified orphans open, and closes dead or stale runs', async (t) => {
  prepareTempDataRoot(t);
  const { ProcessManager } = await import('./process-manager.js');
  const { initDb, getDb } = await import('../db.js');
  const { createInstance, getInstanceRow } = await import('./instance-service.js');
  const { createRunHistoryTracker } = await import('./run-history-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const aliveInst = createInstance({ name: 'orphan-alive' });
  const staleInst = createInstance({ name: 'orphan-stale' });
  fs.writeFileSync(path.join(defaultInstanceDir(aliveInst.id), 'server.jar'), 'stub-jar');

  const child = fakeChild();
  Object.assign(child, { pid: 55123 });
  let resolveIdentity!: (value: string | null) => void;
  const identityPromise = new Promise<string | null>((resolve) => {
    resolveIdentity = resolve;
  });

  const manager = new ProcessManager(
    () => child,
    async () => 'java',
    {
      captureIdentitySync: () => null,
      captureIdentityAsync: () => identityPromise,
      verifyTrackedProcessAlive: async () => true,
      isTrackedProcessPresentSync: () => true,
      signalProcess: () => {},
    },
  );
  const tracker = createRunHistoryTracker({
    events: manager,
    now: () => new Date('2026-11-27T08:00:00.000Z'),
  });
  tracker.attach();
  t.after(() => tracker.detach());

  await manager.start(getInstanceRow(aliveInst.id)! as InstanceRow);
  const rowAfterSpawn = getDb()
    .prepare('SELECT id, pid, process_identity FROM instance_runs WHERE instance_id = ?')
    .get(aliveInst.id) as { id: number; pid: number | null; process_identity: string | null };
  assert.equal(rowAfterSpawn.pid, 55123);
  assert.equal(rowAfterSpawn.process_identity, null);

  resolveIdentity('win32:999888777');
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  const rowAfterAsync = getDb()
    .prepare('SELECT pid, process_identity FROM instance_runs WHERE id = ?')
    .get(rowAfterSpawn.id) as { pid: number | null; process_identity: string | null };
  assert.equal(rowAfterAsync.process_identity, 'win32:999888777');

  // Seed an exited/recycled open run and a no-PID open run for the second instance before simulating panel recovery.
  getDb()
    .prepare('INSERT INTO instance_runs (instance_id, started_at, pid, process_identity) VALUES (?, ?, ?, ?)')
    .run(staleInst.id, '2026-11-27T07:50:00.000Z', 888002, 'linux:boot-old:1');
  getDb()
    .prepare('INSERT INTO instance_runs (instance_id, started_at, pid, process_identity) VALUES (?, ?, NULL, NULL)')
    .run(staleInst.id, '2026-11-27T07:40:00.000Z');
  tracker.detach();

  const registered: Array<[string, number]> = [];
  const nextTracker = createRunHistoryTracker({
    orphanRegistry: {
      clearOrphanProcesses: () => { registered.length = 0; },
      registerOrphanProcess: (id, rec) => { registered.push([id, rec.pid]); },
    },
    verifyAlive: async (candidate) => candidate.pid === 55123,
    canGracefulStop: () => false,
    now: () => new Date('2026-11-27T08:05:00.000Z'),
  });
  const recovery = await nextTracker.recoverOrphanProcesses();
  assert.deepEqual(recovery.orphans, [{ instanceId: aliveInst.id, pid: 55123, runId: rowAfterSpawn.id }]);
  assert.deepEqual([...recovery.activeRunIds], [rowAfterSpawn.id]);
  assert.deepEqual(registered, [[aliveInst.id, 55123]]);

  const interrupted = nextTracker.recoverInterrupted(recovery.activeRunIds);
  assert.equal(interrupted.recovered, 2);

  const aliveRow = getDb()
    .prepare('SELECT ended_at, end_reason FROM instance_runs WHERE id = ?')
    .get(rowAfterSpawn.id) as { ended_at: string | null; end_reason: string | null };
  assert.deepEqual({ ...aliveRow }, { ended_at: null, end_reason: null });

  const staleRows = getDb()
    .prepare('SELECT ended_at, end_reason FROM instance_runs WHERE instance_id = ?')
    .all(staleInst.id) as Array<{ ended_at: string | null; end_reason: string | null }>;
  assert.ok(staleRows.every((r) => r.ended_at !== null && r.end_reason === 'panel-exit'));
});

test('orphan stop respects Windows Force Stop requirement and Unix SIGTERM graceful shutdown', async (t) => {
  prepareTempDataRoot(t);
  const { ProcessManager, InstanceOperationConflictError, InstanceStopPendingError } = await import('./process-manager.js');
  const { initDb, getDb } = await import('../db.js');
  const { createInstance, getInstanceRow } = await import('./instance-service.js');
  const { createRunHistoryTracker } = await import('./run-history-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  const prevGrace = process.env.MYSTRY_TEST_STOP_GRACE_MS;
  process.env.MYSTRY_TEST_STOP_GRACE_MS = '250';
  t.after(() => {
    if (prevGrace === undefined) delete process.env.MYSTRY_TEST_STOP_GRACE_MS;
    else process.env.MYSTRY_TEST_STOP_GRACE_MS = prevGrace;
  });

  const winInst = createInstance({ name: 'win-orphan' });
  const unixInst = createInstance({ name: 'unix-orphan' });
  fs.writeFileSync(path.join(defaultInstanceDir(winInst.id), 'server.jar'), 'stub-jar');
  fs.writeFileSync(path.join(defaultInstanceDir(unixInst.id), 'server.jar'), 'stub-jar');

  const alivePids = new Set([71001, 71002]);
  const signals: Array<[number, string]> = [];
  const spawned: string[] = [];

  const manager = new ProcessManager(
    (_cmd, _args, opts) => {
      spawned.push(opts.cwd);
      return fakeChild();
    },
    async () => 'java',
    {
      captureIdentitySync: () => 'test:boot:1',
      captureIdentityAsync: async () => 'test:boot:1',
      verifyTrackedProcessAlive: async (candidate) => alivePids.has(candidate.pid),
      isTrackedProcessPresentSync: (candidate) => alivePids.has(candidate.pid),
      signalProcess: (pid, sig) => {
        signals.push([pid, sig]);
        if (pid === 71001 && sig === 'SIGKILL') alivePids.delete(pid);
        if (pid === 71002 && sig === 'SIGTERM') alivePids.delete(pid);
      },
    },
  );
  const tracker = createRunHistoryTracker({
    events: manager,
    now: () => new Date('2026-11-27T09:05:00.000Z'),
  });
  tracker.attach();
  t.after(() => tracker.detach());

  getDb()
    .prepare('INSERT INTO instance_runs (instance_id, started_at, pid, process_identity) VALUES (?, ?, ?, ?)')
    .run(winInst.id, '2026-11-27T09:00:00.000Z', 71001, 'win32:1');
  const winRun = getDb().prepare('SELECT last_insert_rowid() AS id').get() as { id: number };
  getDb()
    .prepare('INSERT INTO instance_runs (instance_id, started_at, pid, process_identity) VALUES (?, ?, ?, ?)')
    .run(unixInst.id, '2026-11-27T09:00:00.000Z', 71002, 'linux:boot:2');
  const unixRun = getDb().prepare('SELECT last_insert_rowid() AS id').get() as { id: number };

  manager.registerOrphanProcess(winInst.id, {
    pid: 71001,
    startedAt: '2026-11-27T09:00:00.000Z',
    canGracefulStop: false,
    runId: winRun.id,
    processIdentity: 'win32:1',
  });
  manager.registerOrphanProcess(unixInst.id, {
    pid: 71002,
    startedAt: '2026-11-27T09:00:00.000Z',
    canGracefulStop: true,
    runId: unixRun.id,
    processIdentity: 'linux:boot:2',
  });

  await assert.rejects(
    () => manager.stop(winInst.id, false),
    (err: unknown) => err instanceof InstanceOperationConflictError
      && err.messageKey === 'server.instance.orphanStopRequiresForce'
      && err.statusCode === 409,
  );
  assert.deepEqual(signals, []);

  await manager.stop(winInst.id, true);
  assert.deepEqual(signals, [[71001, 'SIGKILL']]);
  assert.equal(manager.getOrphanProcess(winInst.id), null);

  await manager.stop(unixInst.id, false);
  assert.deepEqual(signals, [[71001, 'SIGKILL'], [71002, 'SIGTERM']]);
  assert.equal(manager.getOrphanProcess(unixInst.id), null);

  const closedWinRun = getDb()
    .prepare('SELECT ended_at, end_reason FROM instance_runs WHERE id = ?')
    .get(winRun.id) as { ended_at: string | null; end_reason: string | null };
  assert.equal(closedWinRun.end_reason, 'stopped');
  assert.ok(closedWinRun.ended_at !== null);

  // Starting works again once the detached process has exited.
  await manager.start(getInstanceRow(winInst.id)! as InstanceRow);
  assert.equal(spawned.length, 1);

  // If an orphan ignores SIGTERM past stop grace, stop rejects with InstanceStopPendingError (202).
  alivePids.add(71003);
  manager.registerOrphanProcess(unixInst.id, {
    pid: 71003,
    startedAt: '2026-11-27T09:00:00.000Z',
    canGracefulStop: true,
    runId: unixRun.id,
    processIdentity: 'linux:boot:3',
  });
  await assert.rejects(
    () => manager.stop(unixInst.id, false),
    (err: unknown) => err instanceof InstanceStopPendingError
      && err.messageKey === 'server.instance.orphanStopPending',
  );
});

test('real verified orphan blocks start, restart, delete, adopt, and backup until force stopped', async (t) => {
  prepareTempDataRoot(t);
  const { processManager, InstanceOperationConflictError } = await import('./process-manager.js');
  const { initDb, getDb } = await import('../db.js');
  const { adoptManagedDirectory, createInstance, deleteInstance, getInstance, getInstanceRow } = await import('./instance-service.js');
  const { startBackupTask } = await import('./backup-service.js');
  const { attachRunHistoryLifecycle, detachRunHistoryLifecycle, recoverOrphanInstanceProcesses } = await import('./run-history-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');

  initDb();
  attachRunHistoryLifecycle();
  t.after(() => {
    detachRunHistoryLifecycle();
    processManager.clearOrphanProcesses();
  });

  const info = createInstance({ name: 'real-orphan' });
  const dir = defaultInstanceDir(info.id);
  fs.writeFileSync(path.join(dir, 'server.jar'), 'stub-jar');

  const liveChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  t.after(() => {
    try { liveChild.kill('SIGKILL'); } catch { /* already exited */ }
  });
  assert.ok(liveChild.pid && liveChild.pid > 0);
  const pid = liveChild.pid;
  const startedAt = new Date().toISOString();
  const identity = await captureProcessIdentityAsync(pid);
  assert.ok(identity, 'expected platform process identity for live test subprocess');

  // Verify anti-PID-reuse guards against self-PID, pre-boot timestamp, and mismatched identity.
  assert.equal(await verifyTrackedProcessAlive({ pid: process.pid, startedAt, processIdentity: null }), false);
  assert.equal(await verifyTrackedProcessAlive({ pid, startedAt: '2000-01-01T00:00:00.000Z', processIdentity: identity }), false);
  assert.equal(await verifyTrackedProcessAlive({ pid, startedAt, processIdentity: `${identity}-mismatch` }), false);
  assert.equal(await verifyTrackedProcessAlive({ pid, startedAt, processIdentity: identity, cwd: dir }), true);

  getDb()
    .prepare('INSERT INTO instance_runs (instance_id, started_at, pid, process_identity) VALUES (?, ?, ?, ?)')
    .run(info.id, startedAt, pid, identity);
  const recovery = await recoverOrphanInstanceProcesses();
  assert.equal(recovery.orphans.length, 1);
  assert.equal(recovery.orphans[0]!.pid, pid);

  const fetched = getInstance(info.id);
  assert.equal(fetched?.orphanProcess?.pid, pid);
  assert.equal(fetched?.orphanProcess?.canGracefulStop, process.platform !== 'win32');

  const row = getInstanceRow(info.id)! as InstanceRow;
  for (const blocked of [
    () => processManager.start(row),
    () => processManager.restart(row),
    () => deleteInstance(info.id),
    () => startBackupTask(info.id),
  ]) {
    await assert.rejects(
      blocked,
      (err: unknown) => err instanceof InstanceOperationConflictError
        && err.messageKey === 'server.instance.orphanProcessRunning'
        && err.statusCode === 409,
    );
  }

  // Temporarily mark the instance as needing migration to verify adoptManagedDirectory also refuses while an orphan lives.
  getDb().prepare('UPDATE instances SET install_path = ? WHERE id = ?').run('/tmp/legacy-source', info.id);
  await assert.rejects(
    () => adoptManagedDirectory(info.id),
    (err: unknown) => err instanceof InstanceOperationConflictError
      && err.messageKey === 'server.instance.orphanProcessRunning',
  );
  getDb().prepare('UPDATE instances SET install_path = NULL WHERE id = ?').run(info.id);

  await processManager.stop(info.id, true);
  assert.equal(getInstance(info.id)?.orphanProcess, null);
  const closed = getDb()
    .prepare('SELECT ended_at, end_reason FROM instance_runs WHERE instance_id = ?')
    .get(info.id) as { ended_at: string | null; end_reason: string | null };
  assert.equal(closed.end_reason, 'stopped');
  assert.ok(closed.ended_at !== null);

  await deleteInstance(info.id);
  assert.equal(getInstance(info.id), null);
});
