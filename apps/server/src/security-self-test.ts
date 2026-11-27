import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';

function makeStoredZip(name: string, content: Buffer): Buffer {
  const nameBuffer = Buffer.from(name, 'utf8');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBuffer.length, 26);
  const localRecord = Buffer.concat([local, nameBuffer, content]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(nameBuffer.length, 28);
  const centralRecord = Buffer.concat([central, nameBuffer]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralRecord.length, 12);
  eocd.writeUInt32LE(localRecord.length, 16);
  return Buffer.concat([localRecord, centralRecord, eocd]);
}

async function main(): Promise<void> {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-security-self-test-'));
  process.env.MYSTRY_DATA_DIR = dataRoot;
  process.env.JWT_SECRET = 'a'.repeat(64);
  process.env.SETUP_TOKEN = 'b'.repeat(64);
  process.env.LAUNCHER_TOKEN = 'c'.repeat(64);
  process.env.MYSTRY_PROCESS_FINGERPRINT = 'security-self-test';
  process.env.MAX_CONCURRENT_UPLOADS = '1';
  process.env.MAX_UPLOAD_BYTES = '256';
  process.env.MAX_CONCURRENT_FILE_DOWNLOADS = '1';
  process.env.MAX_COMMAND_BYTES = '4';

  // Write an old database without the Java runtime fields first, to verify the startup compatibility migration.
  const legacyDb = new DatabaseSync(path.join(dataRoot, 'panel.db'));
  legacyDb.exec(`
    CREATE TABLE instances (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      core_type TEXT NOT NULL DEFAULT 'custom',
      mc_version TEXT,
      jar_file TEXT NOT NULL DEFAULT 'server.jar',
      java_path TEXT NOT NULL DEFAULT 'java',
      jvm_args TEXT NOT NULL DEFAULT '-Xms1G -Xmx2G',
      accept_eula INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  legacyDb.close();

  const { assertDistinctSecrets, config } = await import('./config.js');
  const { getDb } = await import('./db.js');
  const { buildApp, releasePanelDataLock } = await import('./index.js');
  const { consumeConsoleTicket, issueConsoleTicket } = await import('./services/console-ticket-service.js');
  const { safeExtract } = await import('./services/zip-service.js');
  const {
    removeUploadTemp,
    streamToUploadTemp,
    UploadTooLargeError,
  } = await import('./services/upload-service.js');
  const { getMinecraftChildEnv } = await import('./utils/child-env.js');
  const {
    resolveJavaRuntimeCommand,
    verifyJavaExecutable,
  } = await import('./services/java-runtime-service.js');
  const { acquireFileDownloadSlot } = await import('./services/file-service.js');
  const { ProcessManager, registerStdinSafetyHandlers } = await import('./services/process-manager.js');
  const {
    createInstance,
    deleteInstance,
    getInstanceRow,
  } = await import('./services/instance-service.js');
  const {
    createTask,
    getTask,
    recoverInterruptedTasks,
    updateTask,
  } = await import('./services/task-service.js');
  const { parseJvmArgs, serializeJvmArgFile } = await import('@mystry/shared');
  const {
    isRetryableInstallerFailure,
    summarizeInstallerDownloadFailure,
  } = await import('./services/core-installer.js');
  const { defaultInstanceDir, readOwnershipMarker, resolveSafePath } = await import('./utils/path.js');

  let launcherShutdownStarted = false;
  const app = await buildApp({
    prepareShutdown: () => ({
      runningInstances: 0,
      runningTasks: 0,
      queuedTasks: 0,
      alreadyShuttingDown: false,
    }),
    startShutdown: () => {
      launcherShutdownStarted = true;
    },
  });
  const testRoot = fs.mkdtempSync(path.join(config.uploadDir, '.security-self-test-'));
  try {
    const instanceColumns = getDb().prepare('PRAGMA table_info(instances)').all() as Array<{ name: string }>;
    const runtimeColumns = getDb().prepare('PRAGMA table_info(java_runtimes)').all() as Array<{ name: string }>;
    assert.equal(instanceColumns.some((column) => column.name === 'java_runtime_id'), true);
    assert.equal(runtimeColumns.some((column) => column.name === 'available'), true);
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json<{ processFingerprint: string }>().processFingerprint, 'security-self-test');
    assert.throws(
      () => resolveSafePath(testRoot, '../outside'),
      (error: unknown) => (error as { messageKey?: string }).messageKey === 'server.files.path.outside',
    );
    assert.equal(getMinecraftChildEnv().JWT_SECRET, undefined);
    const mockedJavaPath = process.platform === 'win32'
      ? 'C:/runtime/bin/java.exe'
      : '/runtime/bin/java';
    const verifiedJava = await verifyJavaExecutable(
      mockedJavaPath,
      async (_command, _args, options) => {
        assert.equal(options.env.JWT_SECRET, undefined);
        assert.equal(options.env.SETUP_TOKEN, undefined);
        assert.equal(options.env.LAUNCHER_TOKEN, undefined);
        return { stdout: '', stderr: 'openjdk version "21.0.3"' };
      },
    );
    assert.deepEqual(verifiedJava, { version: '21.0.3', majorVersion: 21 });
    const installerNetworkFailure = [
      'Failed to establish connection to https://maven.minecraftforge.net/example.jar',
      'java.net.SocketTimeoutException: Read timed out',
      'These libraries failed to download. Try again.',
      '',
      'org.example:library:1.0',
      'There was an error during installation',
    ].join('\n');
    assert.equal(isRetryableInstallerFailure(installerNetworkFailure), true);
    assert.equal(isRetryableInstallerFailure('Installer configuration is invalid'), false);
    const installerFailureSummary = summarizeInstallerDownloadFailure(installerNetworkFailure, 2);
    assert.equal(installerFailureSummary.key, 'server.deploy.installerDownloadFailed');
    assert.match(
      (await import('@mystry/shared')).renderPanelMessage(installerFailureSummary),
      /automatic retries: 1, read timed out for maven\.minecraftforge\.net.*org\.example:library:1\.0/,
    );
    assert.throws(
      () => assertDistinctSecrets([
        ['JWT_SECRET', 'a'.repeat(64)],
        ['SETUP_TOKEN', 'A'.repeat(64)],
      ]),
      /必须使用不同的随机值/,
    );

    const unavailableRuntimeId = 'unavailable-runtime';
    getDb()
      .prepare(
        `INSERT INTO java_runtimes
         (id, path, version, major_version, source, verified_at, available)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        unavailableRuntimeId,
        path.join(dataRoot, 'missing-java.exe'),
        '17.0.0',
        17,
        'scan',
        new Date().toISOString(),
      );
    assert.throws(
      () => createInstance({
        name: '不可用 Java 运行时',
        coreType: 'custom',
        javaRuntimeId: unavailableRuntimeId,
      }),
      { messageKey: 'server.instance.javaRuntimeInvalid' },
    );
    await assert.rejects(
      () => resolveJavaRuntimeCommand(unavailableRuntimeId),
      { messageKey: 'server.instance.javaRuntimeUnavailable' },
    );

    const interruptedInstance = createInstance({ name: '中断任务实例', coreType: 'custom' });
    const interruptedTask = createTask('deploy');
    updateTask(interruptedTask.id, {
      status: 'running',
      result: { instanceId: interruptedInstance.id },
    });
    const queuedTask = createTask('import');
    const recovery = recoverInterruptedTasks();
    assert.deepEqual(recovery, { interrupted: 2, cleanedStaging: 0, stagingCleanupFailures: 0 });
    assert.equal(getTask(interruptedTask.id)?.status, 'failed');
    assert.equal(getTask(queuedTask.id)?.status, 'failed');
    assert.notEqual(getInstanceRow(interruptedInstance.id), null);
    assert.equal(fs.existsSync(defaultInstanceDir(interruptedInstance.id)), true);

    const lockedInstance = createInstance({ name: '模拟文件锁实例', coreType: 'custom' });
    const lockedDirectory = defaultInstanceDir(lockedInstance.id);
    const originalRm = fs.promises.rm;
    fs.promises.rm = (async (target, options) => {
      if (path.resolve(String(target)) === path.resolve(lockedDirectory)) {
        throw new Error('模拟 Windows 文件锁');
      }
      return originalRm(target, options);
    }) as typeof fs.promises.rm;
    try {
      await assert.rejects(() => deleteInstance(lockedInstance.id), /模拟 Windows 文件锁/);
    } finally {
      fs.promises.rm = originalRm;
    }
    assert.notEqual(getInstanceRow(lockedInstance.id), null);
    assert.equal(fs.existsSync(lockedDirectory), true);
    await deleteInstance(lockedInstance.id);

    const parsedJvmArgs = parseJvmArgs(
      '-Xms1G -Xmx2G -Dconfig="C:\\Minecraft Server\\config.json" -Dlabel=\'Mystry Panel\'',
    );
    assert.deepEqual(parsedJvmArgs, [
      '-Xms1G',
      '-Xmx2G',
      '-Dconfig=C:\\Minecraft Server\\config.json',
      '-Dlabel=Mystry Panel',
    ]);
    assert.throws(
      () => parseJvmArgs('-Dconfig="not-closed'),
      (error: unknown) => (error as { messageKey?: unknown }).messageKey === 'server.jvm.issue.unclosedQuote',
    );
    assert.deepEqual(
      parseJvmArgs('-Dshare="\\\\server\\Minecraft Servers"'),
      ['-Dshare=\\\\server\\Minecraft Servers'],
    );
    assert.equal(
      serializeJvmArgFile(parsedJvmArgs),
      '"-Xms1G"\n"-Xmx2G"\n"-Dconfig=C:\\\\Minecraft Server\\\\config.json"\n"-Dlabel=Mystry Panel"',
    );

    const crashedInstance = createInstance({
      name: '崩溃状态实例',
      coreType: 'custom',
      jvmArgs: '-Xms1G -Xmx2G -Dconfig="C:\\Minecraft Server\\config.json"',
    });
    const crashedRow = getInstanceRow(crashedInstance.id)!;
    fs.writeFileSync(path.join(defaultInstanceDir(crashedInstance.id), 'server.jar'), 'jar', 'utf8');
    const fakeStdout = new PassThrough();
    const fakeStderr = new PassThrough();
    const fakeStdin = new PassThrough();
    const fakeChild = Object.assign(new EventEmitter(), {
      stdout: fakeStdout,
      stderr: fakeStderr,
      stdin: fakeStdin,
      kill: () => true,
    }) as unknown as ChildProcessWithoutNullStreams;
    let spawnedArgs: readonly string[] = [];
    const isolatedProcessManager = new ProcessManager((_command, args) => {
      spawnedArgs = [...args];
      return fakeChild;
    });
    await isolatedProcessManager.start(crashedRow);
    fakeStderr.write('模拟崩溃输出');
    fakeChild.emit('exit', 1, null);
    assert.equal(spawnedArgs.includes('-Dconfig=C:\\Minecraft Server\\config.json'), true);
    assert.equal(isolatedProcessManager.getStatus(crashedInstance.id), 'crashed');
    assert.match(isolatedProcessManager.getHistory(crashedInstance.id), /模拟崩溃输出/);
    assert.match(isolatedProcessManager.getHistory(crashedInstance.id), /\[Panel\] Process exited \(exit code 1, signal none\)/);
    assert.equal(isolatedProcessManager.getRunningCount(), 0);
    await deleteInstance(crashedInstance.id);

    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: { 'x-setup-token': 'b'.repeat(64) },
      payload: { username: 'admin12', password: 'password1234' },
    });
    assert.equal(setup.statusCode, 200);
    const accessToken = setup.json<{ token: string }>().token;
    const authorization = { authorization: `Bearer ${accessToken}` };

    const login = (password: string) => app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin12', password },
    });
    const changePasswordRequest = (headers: Record<string, string>, currentPassword: string, newPassword: string) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/password',
        headers,
        payload: { currentPassword, newPassword },
      });
    assert.equal((await changePasswordRequest({}, 'password1234', 'changed-password')).statusCode, 401);
    assert.equal((await changePasswordRequest(authorization, 'wrong-password', 'changed-password')).statusCode, 400);
    assert.equal((await changePasswordRequest(authorization, 'password1234', 'short')).statusCode, 400);
    assert.equal((await login('password1234')).statusCode, 200, '改密失败时旧密码必须仍然有效');
    const changedPassword = await changePasswordRequest(authorization, 'password1234', 'changed-password');
    assert.equal(changedPassword.statusCode, 200);
    // After the password change the old token is invalid immediately; later requests use the reissued token.
    const staleMe = await app.inject({ method: 'GET', url: '/api/auth/me', headers: authorization });
    assert.equal(staleMe.statusCode, 401, '改密后此前签发的令牌必须失效');
    authorization.authorization = `Bearer ${changedPassword.json<{ token: string }>().token}`;
    assert.equal((await app.inject({ method: 'GET', url: '/api/auth/me', headers: authorization })).statusCode, 200);
    assert.equal((await login('password1234')).statusCode, 401);
    assert.equal((await login('changed-password')).statusCode, 200);

    const resetPasswordRequest = (headers: Record<string, string>, password: string) => app.inject({
      method: 'POST',
      url: '/api/launcher/reset-password',
      headers,
      payload: { password },
    });
    assert.equal((await resetPasswordRequest({}, 'password1234')).statusCode, 401);
    assert.equal((await resetPasswordRequest({ 'x-launcher-token': 'd'.repeat(64) }, 'password1234')).statusCode, 401);
    const remoteReset = await app.inject({
      method: 'POST',
      url: '/api/launcher/reset-password',
      remoteAddress: '192.168.2.20',
      headers: { 'x-launcher-token': 'c'.repeat(64) },
      payload: { password: 'password1234' },
    });
    assert.equal(remoteReset.statusCode, 403);
    const reset = await resetPasswordRequest({ 'x-launcher-token': 'c'.repeat(64) }, 'password1234');
    assert.equal(reset.statusCode, 200);
    assert.deepEqual(reset.json(), { username: 'admin12' });
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/auth/me', headers: authorization })).statusCode,
      401,
      '重置密码后此前签发的令牌必须失效',
    );
    const loginAfterReset = await login('password1234');
    assert.equal(loginAfterReset.statusCode, 200);
    authorization.authorization = `Bearer ${loginAfterReset.json<{ token: string }>().token}`;

    const taskList = await app.inject({
      method: 'GET',
      url: '/api/tasks',
      headers: authorization,
    });
    assert.equal(taskList.statusCode, 200);
    assert.equal(Array.isArray(taskList.json<{ tasks: unknown[] }>().tasks), true);

    const existingSourceDir = path.join(config.existingServerImportDir, 'paper-existing');
    fs.mkdirSync(path.join(existingSourceDir, 'world'), { recursive: true });
    fs.writeFileSync(path.join(existingSourceDir, 'paper.jar'), 'existing-paper');
    fs.writeFileSync(path.join(existingSourceDir, 'world', 'level.dat'), 'world-data');
    const reservedSourceDir = path.join(config.existingServerImportDir, 'managed-copy');
    fs.mkdirSync(reservedSourceDir, { recursive: true });
    fs.writeFileSync(path.join(reservedSourceDir, 'server.jar'), 'managed');
    fs.writeFileSync(
      path.join(reservedSourceDir, '.mystry-instance.json'),
      `${JSON.stringify({ version: 1, instanceId: 'managed', marker: 'reserved' })}\n`,
    );

    const existingSources = await app.inject({
      method: 'GET',
      url: '/api/import/sources',
      headers: authorization,
    });
    assert.equal(existingSources.statusCode, 200);
    // The imports path is shown only to signed-in users: it is an absolute path and matches the handoff area the panel actually uses.
    const listedImportDir = existingSources.json<{ importDir: string }>().importDir;
    assert.ok(path.isAbsolute(listedImportDir));
    assert.equal(listedImportDir, path.resolve(config.existingServerImportDir));
    const sourceItems = existingSources.json<{
      sources: Array<{
        id: string;
        launchTarget: string | null;
        coreType: string;
        modifiedAt: string;
        ready: boolean;
        error?: string;
        errorI18n?: { key: string };
      }>;
    }>().sources;
    assert.deepEqual(
      sourceItems.find((source) => source.id === 'paper-existing'),
      {
        id: 'paper-existing',
        launchTarget: 'paper.jar',
        coreType: 'paper',
        modifiedAt: sourceItems.find((source) => source.id === 'paper-existing')!.modifiedAt,
        ready: true,
      },
    );
    assert.equal(sourceItems.find((source) => source.id === 'managed-copy')?.ready, false);
    assert.equal(
      sourceItems.find((source) => source.id === 'managed-copy')?.errorI18n?.key,
      'server.imports.existing.managedMarker',
    );

    const rejectedExistingTraversal = await app.inject({
      method: 'POST',
      url: '/api/import/existing',
      headers: authorization,
      payload: { name: '越界目录', sourceId: '../outside' },
    });
    assert.equal(rejectedExistingTraversal.statusCode, 400);

    const existingImport = await app.inject({
      method: 'POST',
      url: '/api/import/existing',
      headers: authorization,
      payload: {
        name: '接管的 Paper',
        sourceId: 'paper-existing',
        mcVersion: '1.20.1',
        jvmArgs: '-Xms512M -Xmx1G',
        acceptEula: true,
      },
    });
    assert.equal(existingImport.statusCode, 200);
    const existingTaskId = existingImport.json<{ id: string }>().id;
    let existingTask = getTask(existingTaskId);
    for (let attempt = 0; attempt < 200 && existingTask?.status !== 'completed' && existingTask?.status !== 'failed'; attempt += 1) {
      // The background copy task should finish quickly; the short polling only waits for the test fixture to reach a final state.
      await new Promise((resolve) => setTimeout(resolve, 10));
      existingTask = getTask(existingTaskId);
    }
    assert.equal(existingTask?.status, 'completed', existingTask?.error);
    const importedInstanceId = existingTask?.result?.instanceId;
    assert.equal(typeof importedInstanceId, 'string');
    const importedRow = getInstanceRow(importedInstanceId!);
    assert.equal(importedRow?.core_type, 'paper');
    assert.equal(importedRow?.mc_version, '1.20.1');
    assert.equal(importedRow?.jar_file, 'paper.jar');
    assert.equal(importedRow?.java_runtime_id, null);
    assert.equal(
      fs.readFileSync(path.join(defaultInstanceDir(importedInstanceId!), 'world', 'level.dat'), 'utf8'),
      'world-data',
    );
    assert.equal(fs.readFileSync(path.join(existingSourceDir, 'paper.jar'), 'utf8'), 'existing-paper');
    assert.equal(fs.readFileSync(path.join(defaultInstanceDir(importedInstanceId!), 'eula.txt'), 'utf8'), 'eula=true\n');

    const createWithLegacyField = await app.inject({
      method: 'POST',
      url: '/api/instances',
      headers: authorization,
      payload: { name: 'legacy-create', javaPath: 'java' },
    });
    assert.equal(createWithLegacyField.statusCode, 400);

    const deployWithLegacyField = await app.inject({
      method: 'POST',
      url: '/api/cores/deploy',
      headers: authorization,
      payload: {
        name: 'legacy-deploy',
        coreType: 'paper',
        mcVersion: '1.20.1',
        installPath: 'C:/legacy',
      },
    });
    assert.equal(deployWithLegacyField.statusCode, 400);

    const legacyCopyId = 'legacy-copy';
    const legacyCopyDir = defaultInstanceDir(legacyCopyId);
    const legacyExternalDir = path.join(dataRoot, 'legacy-external');
    fs.mkdirSync(legacyCopyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyCopyDir, 'server.jar'), 'copied');
    fs.mkdirSync(legacyExternalDir, { recursive: true });
    fs.writeFileSync(path.join(legacyExternalDir, 'do-not-touch'), 'sentinel');
    const legacyNow = new Date().toISOString();
    getDb().prepare(
      `INSERT INTO instances
       (id, name, core_type, mc_version, jar_file, java_path, jvm_args, accept_eula, install_path, ownership_marker, node_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      legacyCopyId,
      'legacy-copy',
      'custom',
      null,
      'server.jar',
      'java',
      '-Xms1G -Xmx2G',
      0,
      legacyExternalDir,
      null,
      'local',
      legacyNow,
      legacyNow,
    );
    const adoptedLegacy = await app.inject({
      method: 'POST',
      url: `/api/instances/${legacyCopyId}/adopt-managed-directory`,
      headers: authorization,
    });
    assert.equal(adoptedLegacy.statusCode, 200);
    assert.equal(readOwnershipMarker(legacyCopyId, legacyCopyDir) !== null, true);
    assert.equal(fs.readFileSync(path.join(legacyExternalDir, 'do-not-touch'), 'utf8'), 'sentinel');

    const invalidMarkerId = 'invalid-marker';
    const invalidMarkerDir = defaultInstanceDir(invalidMarkerId);
    const invalidExternalDir = path.join(dataRoot, 'invalid-external');
    fs.mkdirSync(invalidMarkerDir, { recursive: true });
    fs.writeFileSync(path.join(invalidMarkerDir, 'server.jar'), 'copied');
    fs.writeFileSync(
      path.join(invalidMarkerDir, '.mystry-instance.json'),
      `${JSON.stringify({ version: 1, instanceId: 'another-instance', marker: 'foreign' })}\n`,
    );
    const invalidNow = new Date().toISOString();
    getDb().prepare(
      `INSERT INTO instances
       (id, name, core_type, mc_version, jar_file, java_path, jvm_args, accept_eula, install_path, ownership_marker, node_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      invalidMarkerId,
      'invalid-marker',
      'custom',
      null,
      'server.jar',
      'java',
      '-Xms1G -Xmx2G',
      0,
      invalidExternalDir,
      null,
      'local',
      invalidNow,
      invalidNow,
    );
    const rejectedInvalidMarker = await app.inject({
      method: 'POST',
      url: `/api/instances/${invalidMarkerId}/adopt-managed-directory`,
      headers: authorization,
    });
    assert.equal(rejectedInvalidMarker.statusCode, 400);
    assert.equal(
      (getDb().prepare('SELECT install_path FROM instances WHERE id = ?').get(invalidMarkerId) as { install_path: string }).install_path,
      invalidExternalDir,
    );

    const shortLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'abcdef', password: 'abcdef' },
    });
    assert.equal(shortLogin.statusCode, 401);

    // A correct password must not consume the failure quota, so a normal admin is not locked out by signing in repeatedly.
    for (let attempt = 0; attempt <= config.authRateLimitMax; attempt += 1) {
      const successfulLogin = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin12', password: 'password1234' },
      });
      assert.equal(successfulLogin.statusCode, 200);
    }

    // After fewer failures than the threshold, a correct sign-in should work again and clear that user's failure records.
    for (let attempt = 0; attempt < config.authRateLimitMax - 1; attempt += 1) {
      const failedLogin = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin12', password: 'wrong-password' },
      });
      assert.equal(failedLogin.statusCode, 401);
    }
    const recoveredLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin12', password: 'password1234' },
    });
    assert.equal(recoveredLogin.statusCode, 200);

    for (let attempt = 0; attempt < config.authRateLimitMax; attempt += 1) {
      const failedLogin = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin12', password: 'wrong-password' },
      });
      assert.equal(failedLogin.statusCode, 401);
    }
    const blockedLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin12', password: 'wrong-password' },
    });
    assert.equal(blockedLogin.statusCode, 429);
    assert.equal(blockedLogin.headers['x-ratelimit-limit'], String(config.authRateLimitMax));

    const anotherUser = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'another-admin', password: 'wrong-password' },
    });
    assert.equal(anotherUser.statusCode, 401);

    // Rotating distinct usernames from a single IP must still be blocked by the per-IP failure ceiling.
    const rotatingIp = '198.51.100.42';
    for (let attempt = 0; attempt < config.authRateLimitMax * 3; attempt += 1) {
      const rotatingFailure = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: rotatingIp,
        payload: { username: `rotating-user-${attempt}`, password: 'wrong-password' },
      });
      assert.equal(rotatingFailure.statusCode, 401);
    }
    const rotatingBlocked = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: rotatingIp,
      payload: { username: 'rotating-user-final', password: 'wrong-password' },
    });
    assert.equal(rotatingBlocked.statusCode, 429);

    const ticket = issueConsoleTicket('user', 'instance');
    assert.equal(consumeConsoleTicket(ticket.ticket, 'instance')?.userId, 'user');
    assert.equal(consumeConsoleTicket(ticket.ticket, 'instance'), null);

    const {
      beginDownloadStream,
      completeDownloadStream,
      failDownloadStream,
      getDownloadTicketStatus,
      reserveDownloadTicket,
    } = await import('./services/download-ticket-service.js');
    const noRelease = () => {};
    const downloadTicket = reserveDownloadTicket('user', 'instance', 'logs/latest.log', noRelease);
    assert.equal(
      beginDownloadStream(downloadTicket.ticket, 'instance', 'logs/latest.log')?.userId,
      'user',
    );
    assert.equal(beginDownloadStream(downloadTicket.ticket, 'instance', 'logs/latest.log'), null);
    completeDownloadStream(downloadTicket.ticket);
    assert.equal(beginDownloadStream(downloadTicket.ticket, 'instance', 'logs/latest.log'), null);
    const mismatched = reserveDownloadTicket('user', 'instance', 'server.properties', noRelease);
    assert.equal(beginDownloadStream(mismatched.ticket, 'instance', 'eula.txt'), null);
    assert.equal(beginDownloadStream(mismatched.ticket, 'other-instance', 'server.properties'), null);
    // After the stream fails to open the ticket is void, and browser polling gets the failure reason
    const failing = reserveDownloadTicket('user', 'instance', 'ops.txt', noRelease);
    assert.ok(beginDownloadStream(failing.ticket, 'instance', 'ops.txt'));
    failDownloadStream(failing.ticket, { key: 'server.files.download.openFailed' });
    assert.equal(beginDownloadStream(failing.ticket, 'instance', 'ops.txt'), null);
    assert.deepEqual(getDownloadTicketStatus(failing.ticket, 'user'), {
      status: 'failed',
      error: "Couldn't open the file.",
      errorI18n: { key: 'server.files.download.openFailed' },
    });

    const uploaded = await streamToUploadTemp(Readable.from([Buffer.from('streamed')]), 'test');
    assert.equal(fs.readFileSync(uploaded, 'utf8'), 'streamed');
    removeUploadTemp(uploaded);

    await assert.rejects(
      () => streamToUploadTemp(Readable.from([Buffer.alloc(config.maxUploadBytes + 1)]), 'too-large'),
      (error: unknown) => error instanceof UploadTooLargeError,
    );

    const stdin = new PassThrough();
    const stdinState = { stdinAvailable: true, stdinBackpressured: false };
    registerStdinSafetyHandlers(stdin, stdinState);
    let uncaughtStdinError: unknown = null;
    const onUncaughtStdinError = (error: unknown) => {
      uncaughtStdinError = error;
    };
    process.once('uncaughtException', onUncaughtStdinError);
    try {
      const stdinClosed = new Promise<void>((resolve) => stdin.once('close', resolve));
      stdin.destroy(new Error('EPIPE'));
      await stdinClosed;
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      process.off('uncaughtException', onUncaughtStdinError);
    }
    assert.equal(uncaughtStdinError, null);
    assert.equal(stdinState.stdinAvailable, false);
    assert.equal(stdinState.stdinBackpressured, true);

    let releaseUpload!: () => void;
    const uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const slowUpload = streamToUploadTemp(
      Readable.from((async function* () {
        await uploadGate;
        yield Buffer.from('slow');
      })()),
      'capacity',
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const uploadInstance = await app.inject({
      method: 'POST',
      url: '/api/instances',
      headers: authorization,
      payload: { name: 'upload-capacity' },
    });
    assert.equal(uploadInstance.statusCode, 200);
    const uploadInstanceId = uploadInstance.json<{ id: string }>().id;
    fs.writeFileSync(path.join(defaultInstanceDir(uploadInstanceId), 'download.txt'), 'download');
    const boundary = 'mystry-security-test-boundary';
    const multipartPayload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.txt"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      Buffer.from('full'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const uploadWhileFull = await app.inject({
      method: 'POST',
      url: `/api/instances/${uploadInstanceId}/files/upload`,
      headers: {
        ...authorization,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipartPayload,
    });
    assert.equal(uploadWhileFull.statusCode, 429);
    await assert.rejects(
      () => streamToUploadTemp(Readable.from([Buffer.from('full')]), 'capacity'),
      (error: unknown) => error !== null
        && typeof error === 'object'
        && 'code' in error
        && error.code === 'UPLOAD_CAPACITY',
    );
    releaseUpload();
    removeUploadTemp(await slowUpload);

    const oversizedBoundary = 'mystry-security-test-oversized-boundary';
    const oversizedMultipartPayload = Buffer.concat([
      Buffer.from(`--${oversizedBoundary}\r\nContent-Disposition: form-data; name="file"; filename="too-large.txt"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      Buffer.alloc(config.maxUploadBytes + 1, 0x61),
      Buffer.from(`\r\n--${oversizedBoundary}--\r\n`),
    ]);
    const oversizedUpload = await app.inject({
      method: 'POST',
      url: `/api/instances/${uploadInstanceId}/files/upload`,
      headers: {
        ...authorization,
        'content-type': `multipart/form-data; boundary=${oversizedBoundary}`,
      },
      payload: oversizedMultipartPayload,
    });
    assert.equal(oversizedUpload.statusCode, 413);

    const releaseDownload = acquireFileDownloadSlot();
    try {
      const downloadWhileFull = await app.inject({
        method: 'GET',
        url: `/api/instances/${uploadInstanceId}/files/download?path=download.txt`,
        headers: authorization,
      });
      assert.equal(downloadWhileFull.statusCode, 429);
    } finally {
      releaseDownload();
    }

    const protectedInstance = await app.inject({
      method: 'POST',
      url: '/api/instances',
      headers: authorization,
      payload: { name: 'protected-files' },
    });
    assert.equal(protectedInstance.statusCode, 200);
    const protectedInstanceId = protectedInstance.json<{ id: string }>().id;
    const protectedRoot = defaultInstanceDir(protectedInstanceId);
    const markerPath = path.join(protectedRoot, '.mystry-instance.json');
    const markerBefore = fs.readFileSync(markerPath, 'utf8');
    const deleteRoot = await app.inject({
      method: 'DELETE',
      url: `/api/instances/${protectedInstanceId}/files?path=foo%2F..`,
      headers: authorization,
    });
    assert.equal(deleteRoot.statusCode, 400);
    assert.equal(fs.existsSync(protectedRoot), true);
    const writeMarker = await app.inject({
      method: 'PUT',
      url: `/api/instances/${protectedInstanceId}/files/content`,
      headers: authorization,
      payload: { path: 'nested/../.mystry-instance.json', content: 'tampered' },
    });
    assert.equal(writeMarker.statusCode, 400);
    assert.equal(fs.readFileSync(markerPath, 'utf8'), markerBefore);

    const commandLimit = await app.inject({
      method: 'POST',
      url: `/api/instances/${protectedInstanceId}/command`,
      headers: authorization,
      payload: { command: '12345' },
    });
    assert.equal(commandLimit.statusCode, 400);

    const zipPath = path.join(testRoot, 'safe.zip');
    fs.writeFileSync(zipPath, makeStoredZip('server.jar', Buffer.from('jar')));
    const extracted = path.join(testRoot, 'extracted');
    await safeExtract(zipPath, extracted);
    assert.equal(fs.readFileSync(path.join(extracted, 'server.jar'), 'utf8'), 'jar');

    const badZipPath = path.join(testRoot, 'bad.zip');
    fs.writeFileSync(badZipPath, makeStoredZip('../escape.txt', Buffer.from('nope')));
    const badExtracted = path.join(testRoot, 'bad-extracted');
    await assert.rejects(
      () => safeExtract(badZipPath, badExtracted),
      (error: unknown) => (error as { messageKey?: string }).messageKey === 'server.files.zip.unsafePath',
    );
    assert.equal(fs.existsSync(path.join(testRoot, 'escape.txt')), false);

    const missingLauncherToken = await app.inject({
      method: 'POST',
      url: '/api/launcher/shutdown',
    });
    assert.equal(missingLauncherToken.statusCode, 401);

    const remoteLauncherShutdown = await app.inject({
      method: 'POST',
      url: '/api/launcher/shutdown',
      remoteAddress: '192.0.2.10',
      headers: { 'x-launcher-token': 'c'.repeat(64) },
    });
    assert.equal(remoteLauncherShutdown.statusCode, 403);

    const launcherShutdown = await app.inject({
      method: 'POST',
      url: '/api/launcher/shutdown',
      headers: { 'x-launcher-token': 'c'.repeat(64) },
    });
    assert.equal(launcherShutdown.statusCode, 202);
    assert.equal(launcherShutdown.json<{ accepted: boolean }>().accepted, true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(launcherShutdownStarted, true);
  } finally {
    await app.close();
    getDb().close();
    // The lock database keeps an open handle on Windows; release it before deleting the data directory.
    releasePanelDataLock();
    fs.rmSync(testRoot, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
  console.log('安全止血自检通过');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
