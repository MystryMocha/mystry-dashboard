import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { once, EventEmitter, getEventListeners } from 'node:events';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import type { DeployCoreInput, PanelMessage, ServerMessageKey } from '@mystry/shared';
import { PanelError } from '../utils/errors.js';
import type { DownloadPlan } from './download-sources.js';

process.env.JWT_SECRET = randomBytes(32).toString('hex');
process.env.SETUP_TOKEN = randomBytes(32).toString('hex');
process.env.LAUNCHER_TOKEN = randomBytes(32).toString('hex');

/** A download plan with only one official URL. */
function planFor(url: string): DownloadPlan {
  return { candidates: [{ label: 'Fixture', url, mirror: false }] };
}

const sha1 = (data: string | Buffer) => createHash('sha1').update(data).digest('hex');
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** Asserts a translatable error with a matching message key (independent of the wording in any language). */
function hasMessageKey(error: unknown, key: ServerMessageKey): boolean {
  return error instanceof PanelError && error.messageKey === key;
}

test('the Paper cache key uses the resolved build, and the old latest key does not hit', async () => {
  const { buildResolvedCoreCacheBasename } = await import('./core-metadata.js');
  const resolved = buildResolvedCoreCacheBasename('paper', '1.21.1', { build: 42 });
  const legacy = 'paper-1.21.1-latest-.jar'.replace(/[^\w.-]+/g, '_');
  const current = resolved.replace(/[^\w.-]+/g, '_');
  assert.notEqual(current, legacy);
  assert.match(current, /paper-1\.21\.1-build-42\.jar/);
});

test('the Fabric cache key includes the resolved loader and installer', async () => {
  const { buildResolvedCoreCacheBasename } = await import('./core-metadata.js');
  const resolved = buildResolvedCoreCacheBasename('fabric', '1.21.1', {
    loader: '0.16.9',
    installer: '1.0.1',
  });
  assert.match(resolved, /loader-0\.16\.9-installer-1\.0\.1/);
});

test('Paper takes the latest stable build when none is specified, and errors when the specified build does not exist', async (t) => {
  const { resolvePaperDownload } = await import('./core-metadata.js');
  const download = (id: number) => ({ 'server:default': { url: `https://fixture.invalid/paper-${id}.jar`, name: `paper-${id}.jar` } });
  t.mock.method(globalThis, 'fetch', async () => Response.json([
    { id: 41, channel: 'STABLE', downloads: download(41) },
    { id: 42, channel: 'STABLE', downloads: download(42) },
    { id: 43, channel: 'BETA', downloads: download(43) },
  ]));
  assert.equal((await resolvePaperDownload('1.21.1')).build, 42);
  assert.equal((await resolvePaperDownload('1.21.1', 43)).build, 43);
  await assert.rejects(resolvePaperDownload('1.21.1', 99), (error) => {
    assert.ok(hasMessageKey(error, 'server.deploy.paperBuildNotFound'));
    assert.deepEqual((error as PanelError).params, { version: '1.21.1', build: 99 });
    return true;
  });
});

test('Forge and NeoForge JVM args files round-trip through the Java argfile rules', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-user-jvm-args-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { writeUserJvmArgs } = await import('./core-installer.js');
  const { parseJvmArgFile } = await import('@mystry/shared');
  writeUserJvmArgs(dir, String.raw`-Xms1G -Xmx2G "-Dfolder=C:\Minecraft Server"`);
  assert.deepEqual(
    parseJvmArgFile(fs.readFileSync(path.join(dir, 'user_jvm_args.txt'), 'utf8')),
    ['-Xms1G', '-Xmx2G', String.raw`-Dfolder=C:\Minecraft Server`],
  );
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, '等待测试条件超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function tempDir(t: import('node:test').TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-core-depot-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function downloadFixture(t: import('node:test').TestContext) {
  const responses: ServerResponse[] = [];
  const server = createServer((_req, res) => {
    responses.push(res);
    res.writeHead(200, { 'Content-Length': 6 });
    res.write('abc');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}/core.jar`, responses };
}

test('cancel before the download starts: keeps the timeout reason, sends no request and creates no temp file', async (t) => {
  const dir = tempDir(t);
  const { downloadToFile } = await import('./core-download.js');
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('不应请求'); });
  const controller = new AbortController();
  const reason = new PanelError('server.tasks.timeout');
  controller.abort(reason);
  await assert.rejects(downloadToFile('http://unused.invalid', path.join(dir, 'core.jar'), undefined, controller.signal), (error) => error === reason);
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('cancel during a streaming download: closes the response, deletes the part and keeps an existing complete cache', async (t) => {
  const dir = tempDir(t);
  const { url, responses } = await downloadFixture(t);
  const { downloadToFile } = await import('./core-download.js');
  const dest = path.join(dir, 'core.jar');
  fs.writeFileSync(dest, '原有完整缓存');
  const controller = new AbortController();
  const reason = new PanelError('server.tasks.aborted');
  const result = assert.rejects(downloadToFile(url, dest, () => controller.abort(reason), controller.signal), (error) => error === reason);
  await result;
  await waitUntil(() => responses[0]?.destroyed === true);
  assert.equal(fs.readFileSync(dest, 'utf8'), '原有完整缓存');
  assert.deepEqual(fs.readdirSync(dir), ['core.jar']);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('cache concurrency: downloaded only once, and one waiter cancelling does not interrupt the others', async (t) => {
  const dir = tempDir(t);
  const { url, responses } = await downloadFixture(t);
  const { ensureCoreCache } = await import('./core-download.js');
  const dest = path.join(dir, 'core.jar');
  const first = new AbortController();
  const second = new AbortController();
  const progress1: number[] = [];
  const progress2: number[] = [];
  const p1 = assert.rejects(ensureCoreCache(planFor(url), dest, 'core.jar', (p) => progress1.push(p), first.signal), (error) => hasMessageKey(error, 'server.tasks.aborted'));
  const p2 = ensureCoreCache(planFor(url), dest, 'core.jar', (p) => progress2.push(p), second.signal);
  await waitUntil(() => progress1.length > 0 && progress2.length > 0);
  assert.equal(responses.length, 1);
  assert.equal(fs.existsSync(dest), false, '下载完成之前最终缓存不可见');
  first.abort(new PanelError('server.tasks.aborted'));
  await p1;
  const canceledProgressCount = progress1.length;
  assert.equal(responses[0]!.destroyed, false);
  responses[0]!.end('def');
  await p2;
  assert.equal(progress1.length, canceledProgressCount);
  assert.equal(progress2.at(-1), 1);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'abcdef');
  assert.deepEqual(fs.readdirSync(dir), ['core.jar']);
  await ensureCoreCache(planFor(url), dest, 'core.jar');
  assert.equal(responses.length, 1, '完整缓存复用不应重复请求');
  assert.equal(getEventListeners(first.signal, 'abort').length, 0);
  assert.equal(getEventListeners(second.signal, 'abort').length, 0);
});

test('all cache waiters cancel: the download is aborted, the part cleaned up, and it can be downloaded again later', async (t) => {
  const dir = tempDir(t);
  const { url, responses } = await downloadFixture(t);
  const { ensureCoreCache } = await import('./core-download.js');
  const dest = path.join(dir, 'core.jar');
  const controllers = [new AbortController(), new AbortController()];
  let progressSeen = false;
  const results = controllers.map((controller) => assert.rejects(
    ensureCoreCache(planFor(url), dest, 'core.jar', () => { progressSeen = true; }, controller.signal), (error) => hasMessageKey(error, 'server.tasks.aborted'),
  ));
  await waitUntil(() => progressSeen);
  controllers.forEach((controller) => controller.abort(new PanelError('server.tasks.aborted')));
  await Promise.all(results);
  await waitUntil(() => responses[0]?.destroyed === true && fs.readdirSync(dir).length === 0);
  const retry = ensureCoreCache(planFor(url), dest, 'core.jar');
  await waitUntil(() => responses.length === 2);
  responses[1]!.end('def');
  await retry;
  assert.equal(fs.readFileSync(dest, 'utf8'), 'abcdef');
  assert.deepEqual(fs.readdirSync(dir), ['core.jar']);
});

test('retry right after all waiters cancel: a new download starts without inheriting someone elses cancel reason', async (t) => {
  const dir = tempDir(t);
  const { url, responses } = await downloadFixture(t);
  const { ensureCoreCache } = await import('./core-download.js');
  const dest = path.join(dir, 'core.jar');
  const controller = new AbortController();
  let progressSeen = false;
  const canceled = assert.rejects(
    ensureCoreCache(planFor(url), dest, 'core.jar', () => { progressSeen = true; }, controller.signal), (error) => hasMessageKey(error, 'server.tasks.aborted'),
  );
  await waitUntil(() => progressSeen);
  controller.abort(new PanelError('server.tasks.aborted'));
  await canceled;
  // Retry without waiting for the old download to finish up: at this point it may not have been removed from the merge table yet.
  const retry = ensureCoreCache(planFor(url), dest, 'core.jar');
  await waitUntil(() => responses.length === 2);
  responses[1]!.end('def');
  await retry;
  assert.equal(fs.readFileSync(dest, 'utf8'), 'abcdef');
  await waitUntil(() => responses[0]!.destroyed && fs.readdirSync(dir).length === 1);
  assert.deepEqual(fs.readdirSync(dir), ['core.jar']);
});

test('a cache with a mismatched checksum is deleted and downloaded again, and a matching one is reused directly', async (t) => {
  const dir = tempDir(t);
  const { ensureCoreCache, verifyCoreCache } = await import('./core-download.js');
  const dest = path.join(dir, 'core.jar');
  const content = '官方核心内容';
  const plan: DownloadPlan = {
    candidates: [{ label: 'Fixture', url: 'https://fixture.invalid/core.jar', mirror: false }],
    expected: { algorithm: 'sha256', hex: sha256(content) },
  };
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(content));

  // A cache left by another source or an older panel: non-empty, but not matching this plan's checksum.
  fs.writeFileSync(dest, '被篡改的缓存');
  assert.equal(await verifyCoreCache(dest, plan.expected), false);
  assert.equal(fs.existsSync(dest), false, '不符的缓存被删除');
  fs.writeFileSync(dest, '被篡改的缓存');
  await ensureCoreCache(plan, dest, 'core.jar');
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(fs.readFileSync(dest, 'utf8'), content);
  assert.deepEqual(fs.readdirSync(dir), ['core.jar']);

  await ensureCoreCache(plan, dest, 'core.jar');
  assert.equal(fetchMock.mock.callCount(), 1, '相符的缓存不重复下载');
  assert.equal(await verifyCoreCache(dest, plan.expected), true);
  // When the plan has no checksum there is nothing to check against, and a non-empty cache is usable as before (for example when offline).
  assert.equal(await verifyCoreCache(dest, undefined), true);
});

test('when downloading with a checksum, the verified new file replaces the unverified existing file', async (t) => {
  const dir = tempDir(t);
  const { downloadToFile } = await import('./core-download.js');
  const dest = path.join(dir, 'core.jar');
  const content = '官方核心内容';
  fs.writeFileSync(dest, '来路不明的旧文件');
  t.mock.method(globalThis, 'fetch', async () => new Response(content));
  await downloadToFile('https://fixture.invalid/core.jar', dest, undefined, undefined, {
    expected: { algorithm: 'sha256', hex: sha256(content) },
  });
  assert.equal(fs.readFileSync(dest, 'utf8'), content);
  assert.deepEqual(fs.readdirSync(dir), ['core.jar']);
});

test('a cached Vanilla jar with a mismatched checksum is downloaded again on deploy', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-core-depot-'));
  const originalDataDir = process.env.MYSTRY_DATA_DIR;
  process.env.MYSTRY_DATA_DIR = dir;
  const { initDb, closeDb } = await import('../db.js');
  const { config } = await import('../config.js');
  const { deployCore } = await import('./core-depot.js');
  const { getTask, shutdownTasks, resetTaskRuntimeForTests } = await import('./task-service.js');
  initDb();
  resetTaskRuntimeForTests();
  t.after(async () => {
    await shutdownTasks();
    resetTaskRuntimeForTests();
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.MYSTRY_DATA_DIR;
    else process.env.MYSTRY_DATA_DIR = originalDataDir;
  });
  const jar = '官方服务端';
  const detail = JSON.stringify({
    downloads: { server: { url: 'https://piston-data.mojang.com/v1/objects/fixture/server.jar', sha1: sha1(jar) } },
  });
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    const value = String(url);
    calls.push(value);
    if (value.includes('version_manifest')) {
      return Response.json({
        versions: [{ id: '1.21.1', url: 'https://piston-meta.mojang.com/v1/packages/fixture/1.21.1.json', sha1: sha1(detail) }],
      });
    }
    if (value.endsWith('/1.21.1.json')) return new Response(detail);
    if (value.endsWith('/server.jar')) return new Response(jar);
    throw new TypeError('fetch failed');
  });
  fs.mkdirSync(config.cacheDir, { recursive: true });
  fs.writeFileSync(path.join(config.cacheDir, 'vanilla-1.21.1.jar'), '被篡改的缓存');

  const task = await deployCore({ name: '缓存核对', coreType: 'vanilla', mcVersion: '1.21.1', acceptEula: true });
  await waitUntil(() => ['completed', 'failed'].includes(getTask(task.id)!.status));
  const current = getTask(task.id)!;
  assert.equal(current.status, 'completed', current.error);
  assert.ok(calls.some((url) => url.endsWith('/server.jar')), '缓存不符时重新下载');
  const instanceId = current.result!.instanceId as string;
  assert.equal(fs.readFileSync(path.join(dir, 'instances', instanceId, 'server.jar'), 'utf8'), jar);
  assert.equal(fs.readFileSync(path.join(config.cacheDir, 'vanilla-1.21.1.jar'), 'utf8'), jar);
});

type FakeInstaller = EventEmitter & { stdout: PassThrough; stderr: PassThrough; pid?: number; kill: (signal?: string) => boolean };

function installerFixture(t: import('node:test').TestContext, onSpawn?: (child: FakeInstaller, cwd: string) => void) {
  const children: FakeInstaller[] = [];
  const kills: unknown[][] = [];
  const spawnMock = t.mock.method(childProcess, 'spawn', (...args: unknown[]) => {
    if (args[0] === 'taskkill') {
      kills.push(args);
      return new EventEmitter();
    }
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), pid: 87654321,
      kill: (signal?: string) => { kills.push([signal]); return true; },
    });
    children.push(child);
    onSpawn?.(child, (args[2] as { cwd: string }).cwd);
    return child;
  });
  // Named imports of built-in modules need a synchronous stub; no test sends a signal to a real PID.
  const killMock = t.mock.method(process, 'kill', (...args: unknown[]) => { kills.push(args); return true; });
  syncBuiltinESMExports();
  t.after(() => {
    spawnMock.mock.restore();
    killMock.mock.restore();
    syncBuiltinESMExports();
    children.forEach((child) => { child.stdout.destroy(); child.stderr.destroy(); });
  });
  return { children, kills, spawnMock };
}

test('installer exit: zero exit succeeds, non-zero and spawn errors fail, listeners are cleaned up and completion is not repeated', async (t) => {
  const { children } = installerFixture(t);
  const { runInstaller } = await import('./core-installer.js');
  for (const outcome of ['success', 'failure', 'signal', 'error'] as const) {
    const controller = new AbortController();
    const run = runInstaller('installer.jar', tempDir(t), 'java', controller.signal);
    const result = outcome === 'success' ? run : assert.rejects(run,
      outcome === 'failure'
        ? (error) => hasMessageKey(error, 'server.deploy.installerExitCode') && /exited with code 7.*\n.*安装失败/s.test((error as Error).message)
        : outcome === 'signal'
          ? (error) => hasMessageKey(error, 'server.deploy.installerExitUnknown')
          : /无法启动/);
    const child = children.at(-1)!;
    child.stderr.emit('data', Buffer.from('安装失败'));
    child.stdout.emit('error', new Error('EPIPE'));
    child.stderr.emit('error', new Error('EPIPE'));
    if (outcome === 'error') child.emit('error', new Error('无法启动'));
    child.emit('close', outcome === 'signal' ? null : outcome === 'success' ? 0 : 7);
    await result;
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
  assert.equal(children.length, 4, '非网络失败不得重试');
});

test('an installer network failure is retried at most once and the final diagnosis is kept', async (t) => {
  const { children } = installerFixture(t);
  const { runInstaller } = await import('./core-installer.js');
  const controller = new AbortController();
  const messages: PanelMessage[] = [];
  const result = assert.rejects(
    runInstaller('installer.jar', tempDir(t), 'java', controller.signal, (_p, message) => messages.push(message)),
    (error) => hasMessageKey(error, 'server.deploy.installerDownloadFailed')
      && /automatic retries: 1, DNS lookup failed/.test((error as Error).message),
  );
  children[0]!.stderr.emit('data', Buffer.from('UnknownHostException'));
  children[0]!.emit('close', 1);
  await waitUntil(() => children.length === 2);
  children[1]!.stderr.emit('data', Buffer.from('UnknownHostException'));
  children[1]!.emit('close', 1);
  await result;
  assert.equal(children.length, 2);
  assert.ok(messages.some((message) => message.key === 'server.deploy.progress.installerRetrying'));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('installer cancel: released only after exit; force kill as a fallback when close is missing; a zero exit cannot override the cancel', async (t) => {
  const { config } = await import('../config.js');
  const grace = config.installerKillGraceMs;
  config.installerKillGraceMs = 20;
  t.after(() => { config.installerKillGraceMs = grace; });
  const { children, kills } = installerFixture(t);
  const { runInstaller } = await import('./core-installer.js');
  for (const sendsClose of [true, false]) {
    const controller = new AbortController();
    const reason = new PanelError('server.tasks.timeout');
    let settled = false;
    const result = assert.rejects(runInstaller('installer.jar', tempDir(t), 'java', controller.signal).finally(() => { settled = true; }), (error) => error === reason);
    controller.abort(reason);
    await Promise.resolve();
    assert.equal(settled, false, '发出终止请求不等于子进程已经退出');
    if (sendsClose) children.at(-1)!.emit('close', 0);
    await result;
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
  assert.equal(children.length, 2, '取消不得启动重试');
  assert.equal(kills.length, 3, '两次取消加一次强杀兜底');
});

test('shutdown after a deploy has landed: all five cores still register and complete the task', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-core-depot-'));
  const originalDataDir = process.env.MYSTRY_DATA_DIR;
  process.env.MYSTRY_DATA_DIR = dir;
  const { initDb, closeDb } = await import('../db.js');
  const { deployCore } = await import('./core-depot.js');
  const { getInstanceRow } = await import('./instance-service.js');
  const { getTask, shutdownTasks, resetTaskRuntimeForTests } = await import('./task-service.js');
  initDb();
  t.after(async () => {
    await shutdownTasks();
    resetTaskRuntimeForTests();
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.MYSTRY_DATA_DIR;
    else process.env.MYSTRY_DATA_DIR = originalDataDir;
  });
  // Vanilla's details and jar must be on Mojang URLs and carry checksums; the stub provides them in the real format.
  const vanillaDetail = JSON.stringify({
    downloads: { server: { url: 'https://piston-data.mojang.com/v1/objects/fixture/server.jar', sha1: sha1('测试核心文件') } },
  });
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    const value = String(url);
    if (value.includes('version_manifest')) {
      return Response.json({
        versions: [{ id: '1.21.1', url: 'https://piston-meta.mojang.com/v1/packages/fixture/1.21.1.json', sha1: sha1(vanillaDetail) }],
      });
    }
    if (value.endsWith('/1.21.1.json')) return new Response(vanillaDetail);
    if (value.includes('fill.papermc.io')) return Response.json([{ id: 42, channel: 'STABLE', downloads: { 'server:default': { url: 'https://fixture.invalid/core.jar' } } }]);
    return new Response('测试核心文件');
  });
  installerFixture(t, (child, cwd) => {
    fs.writeFileSync(path.join(cwd, 'server.jar'), '安装器生成的服务端');
    queueMicrotask(() => child.emit('close', 0));
  });
  const rename = fs.renameSync;
  let promotedId = '';
  let closing: Promise<void> | undefined;
  t.mock.method(fs, 'renameSync', (source: fs.PathLike, dest: fs.PathLike) => {
    rename(source, dest);
    if (path.dirname(String(dest)) === path.join(dir, 'instances')) {
      promotedId = path.basename(String(dest));
      assert.equal(getInstanceRow(promotedId), null, '重命名时尚未注册');
      closing = shutdownTasks();
    }
  });
  for (const coreType of ['vanilla', 'paper', 'fabric', 'forge', 'neoforge'] as const) {
    resetTaskRuntimeForTests();
    promotedId = '';
    closing = undefined;
    const input: DeployCoreInput = { name: `顺序测试-${coreType}`, coreType, mcVersion: '1.21.1', loaderVersion: '1.0.0', installerVersion: '1.0.0', acceptEula: true };
    const task = await deployCore(input);
    await waitUntil(() => ['completed', 'failed'].includes(getTask(task.id)!.status));
    await closing;
    const current = getTask(task.id)!;
    assert.equal(current.status, 'completed', current.error);
    assert.equal(current.result?.instanceId, promotedId);
    const row = getInstanceRow(promotedId)!;
    assert.equal(row.name, input.name);
    assert.equal(row.core_type, coreType);
    assert.equal(row.jar_file, 'server.jar');
    assert.ok(row.ownership_marker);
    assert.equal(fs.readFileSync(path.join(dir, 'instances', promotedId, 'eula.txt'), 'utf8'), 'eula=true\n');
    assert.equal(fs.existsSync(path.join(dir, '.mystry-staging', task.id)), false);
  }
});

test('on a Forge deploy the cached installer is re-checked against the official checksum; the cache is still used when the checksum cannot be fetched offline', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-core-depot-'));
  const originalDataDir = process.env.MYSTRY_DATA_DIR;
  process.env.MYSTRY_DATA_DIR = dir;
  const { initDb, closeDb } = await import('../db.js');
  const { config } = await import('../config.js');
  const { deployCore } = await import('./core-depot.js');
  const { forgeInstallerUrl } = await import('./core-metadata.js');
  const { getTask, shutdownTasks, resetTaskRuntimeForTests } = await import('./task-service.js');
  initDb();
  t.after(async () => {
    await shutdownTasks();
    resetTaskRuntimeForTests();
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.MYSTRY_DATA_DIR;
    else process.env.MYSTRY_DATA_DIR = originalDataDir;
  });
  const installerUrl = forgeInstallerUrl('1.21.1', '1.0.0');
  const genuine = '官方安装器';
  let online = true;
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    const value = String(url);
    calls.push(value);
    if (!online) throw new TypeError('fetch failed');
    if (value === `${installerUrl}.sha256`) return new Response(`${sha256(genuine)}\n`);
    if (value === installerUrl) return new Response(genuine);
    throw new TypeError('fetch failed');
  });
  // Records the content the installer gets when it runs, to confirm which copy was executed.
  const ran: string[] = [];
  installerFixture(t, (child, cwd) => {
    const jar = fs.readdirSync(cwd).find((name) => name.endsWith('-installer.jar'))!;
    ran.push(fs.readFileSync(path.join(cwd, jar), 'utf8'));
    fs.writeFileSync(path.join(cwd, 'server.jar'), '安装器生成的服务端');
    queueMicrotask(() => child.emit('close', 0));
  });
  const cachePath = path.join(config.cacheDir, 'forge-1.21.1-1.0.0-installer.jar');
  fs.mkdirSync(config.cacheDir, { recursive: true });
  const deploy = async () => {
    resetTaskRuntimeForTests();
    const task = await deployCore({ name: '安装器缓存', coreType: 'forge', mcVersion: '1.21.1', loaderVersion: '1.0.0', acceptEula: true });
    await waitUntil(() => ['completed', 'failed'].includes(getTask(task.id)!.status));
    const current = getTask(task.id)!;
    assert.equal(current.status, 'completed', current.error);
  };

  fs.writeFileSync(cachePath, '被篡改的安装器');
  await deploy();
  assert.ok(calls.includes(installerUrl), '校验不符时重新下载');
  assert.deepEqual(ran, [genuine]);
  assert.equal(fs.readFileSync(cachePath, 'utf8'), genuine);

  // Offline: .sha256 cannot be fetched, the plan carries no checksum, the non-empty cache is used as before, and no download is attempted.
  online = false;
  calls.length = 0;
  fs.writeFileSync(cachePath, '离线时的缓存');
  await deploy();
  assert.deepEqual(calls, [`${installerUrl}.sha256`]);
  assert.deepEqual(ran, [genuine, '离线时的缓存']);
});

test('failure or cancel before a deploy lands: staging is cleaned up, no instance is registered and no final directory is left behind', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-core-depot-'));
  const originalDataDir = process.env.MYSTRY_DATA_DIR;
  process.env.MYSTRY_DATA_DIR = dir;
  const { initDb, closeDb, getDb } = await import('../db.js');
  const { deployCore } = await import('./core-depot.js');
  const { getTask, shutdownTasks, resetTaskRuntimeForTests } = await import('./task-service.js');
  initDb();
  t.after(async () => {
    await shutdownTasks();
    resetTaskRuntimeForTests();
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.MYSTRY_DATA_DIR;
    else process.env.MYSTRY_DATA_DIR = originalDataDir;
  });
  t.mock.method(globalThis, 'fetch', async () => new Response('测试核心文件'));
  let closing: Promise<void> | undefined;
  installerFixture(t, (child) => {
    queueMicrotask(() => {
      child.stderr.emit('data', Buffer.from('安装失败'));
      child.emit('close', 7);
    });
  });
  const copy = fs.copyFileSync;
  t.mock.method(fs, 'copyFileSync', (source: fs.PathLike, dest: fs.PathLike, mode?: number) => {
    copy(source, dest, mode);
    if (path.basename(String(dest)) === 'server.jar') closing = shutdownTasks();
  });
  for (const coreType of ['fabric', 'forge'] as const) {
    resetTaskRuntimeForTests();
    const task = await deployCore({ name: '失败清理', coreType, mcVersion: '1.21.1', loaderVersion: '1.0.0', installerVersion: '1.0.0' });
    await waitUntil(() => getTask(task.id)!.status === 'failed');
    await closing;
    assert.equal(
      getTask(task.id)!.errorI18n?.key,
      coreType === 'fabric' ? 'server.tasks.aborted' : 'server.deploy.installerExitCode',
    );
    assert.equal(getDb().prepare('SELECT count(*) AS count FROM instances').get()!.count, 0);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'instances')), []);
    assert.equal(fs.existsSync(path.join(dir, '.mystry-staging', task.id)), false);
  }
});
