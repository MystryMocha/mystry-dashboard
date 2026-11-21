/**
 * 一键安装 Java 回归（D-034）：接口认证与参数校验、平台不支持、同一主版本重复点击复用任务、
 * 安装后登记为 panel 来源且重新扫描不丢、已装好时不重复下载、摘要不符 / 下载失败 / 压缩包结构不对时
 * 不留下目录。不联网、不真跑 java：下载和 java -version 都换成替身。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { JavaRuntimeListResult, TaskInfo } from '@mystry/shared';

process.env.JWT_SECRET = 'a'.repeat(64);
process.env.SETUP_TOKEN = 'b'.repeat(64);
process.env.LAUNCHER_TOKEN = 'c'.repeat(64);
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-java-install-test-'));
process.env.MYSTRY_DATA_DIR = dataRoot;

/** 手写只含「存储」方式条目的最小 ZIP。 */
function storedZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [entryName, text] of Object.entries(files)) {
    const name = Buffer.from(entryName, 'utf8');
    const body = Buffer.from(text, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** 官方 JRE 包的样子：一个顶层目录，里面 bin/java(.exe)。两种文件名都放，测试在哪个系统上都能跑。 */
function fakeJre(top: string): Buffer {
  return storedZip({ [`${top}/bin/java`]: 'fake', [`${top}/bin/java.exe`]: 'fake', [`${top}/release`]: 'JAVA_VERSION="x"' });
}

const TEST_PLATFORM = 'test:x64';

test('一键安装 Java：接口、复用任务、登记与失败清理', async (t) => {
  const { buildApp } = await import('../index.js');
  const { getTask } = await import('./task-service.js');
  const { TEMURIN_RELEASES, setJavaInstallForTests } = await import('./java-install-service.js');
  const { panelJavaRoot, resolveJavaRuntimeCommand, setJavaVersionRunnerForTests } = await import('./java-runtime-service.js');
  const app = await buildApp({ skipDataLock: true });

  // 只有数据目录里的「java」能通过验证；机器上真装的 Java 一律当成不是 Java，不会被执行。
  setJavaVersionRunnerForTests(async (javaPath) => {
    if (!path.resolve(javaPath).startsWith(path.resolve(dataRoot))) throw new Error('not in test data dir');
    if (fs.readFileSync(javaPath, 'utf8') === 'broken') throw new Error('broken java');
    const version = javaPath.includes('jdk8u') ? '1.8.0_512' : '21.0.13';
    return { stdout: '', stderr: `openjdk version "${version}" 2026-10-21` };
  });

  const good21 = fakeJre('jdk-21.0.13+9-jre');
  const good8 = fakeJre('jdk8u512-b09-jre');
  TEMURIN_RELEASES[21].assets[TEST_PLATFORM] = { archive: 'fake-21.zip', sha256: sha256(good21) };
  TEMURIN_RELEASES[8].assets[TEST_PLATFORM] = { archive: 'fake-8.zip', sha256: sha256(good8) };

  let downloads = 0;
  let serve: (major: number) => Buffer | Error = (major) => (major === 21 ? good21 : good8);
  let gate: Promise<void> = Promise.resolve();
  setJavaInstallForTests({
    platformKey: () => TEST_PLATFORM,
    acquire: async (major, _asset, destination, onProgress, signal) => {
      downloads += 1;
      // 和真下载器一样响应取消。
      await Promise.race([gate, new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      })]);
      const body = serve(major);
      if (body instanceof Error) throw body;
      onProgress(1);
      fs.writeFileSync(destination, body);
    },
  });

  t.after(async () => {
    setJavaInstallForTests(null);
    setJavaVersionRunnerForTests(null);
    delete TEMURIN_RELEASES[21].assets[TEST_PLATFORM];
    delete TEMURIN_RELEASES[8].assets[TEST_PLATFORM];
    await app.close();
    const { closeDb } = await import('../db.js');
    closeDb();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { 'x-setup-token': 'b'.repeat(64) },
    payload: { username: 'admin12', password: 'password1234' },
  });
  assert.equal(setup.statusCode, 200);
  const authorization = { authorization: `Bearer ${setup.json<{ token: string }>().token}` };
  const install = (payload: unknown) =>
    app.inject({ method: 'POST', url: '/api/system/java-runtimes/install', headers: authorization, payload: payload as object });
  const waitForTask = async (id: string): Promise<TaskInfo> => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const task = getTask(id);
      if (task && (task.status === 'completed' || task.status === 'failed')) return task;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`任务 ${id} 未在预期时间内结束`);
  };
  const leftovers = () => (fs.existsSync(panelJavaRoot()) ? fs.readdirSync(panelJavaRoot()) : []);

  // 未登录不能装；只接受钉死的主版本。
  const anonymous = await app.inject({ method: 'POST', url: '/api/system/java-runtimes/install', payload: { major: 21 } });
  assert.equal(anonymous.statusCode, 401);
  for (const bad of [{ major: 11 }, { major: 'latest' }, { major: 21, path: 'C:/evil/java.exe' }, {}]) {
    const response = await install(bad);
    assert.equal(response.statusCode, 400, JSON.stringify(bad));
    assert.equal(response.json<{ code: string }>().code, 'server.jvm.javaInstall.unsupportedMajor');
  }

  // 这台「电脑」只有 8 和 21 的安装包。
  const listed = await app.inject({ method: 'GET', url: '/api/system/java-runtimes', headers: authorization });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.json<JavaRuntimeListResult>().installable, [8, 21]);
  const unsupported = await install({ major: 17 });
  assert.equal(unsupported.statusCode, 409);
  assert.equal(unsupported.json<{ code: string }>().code, 'server.jvm.javaInstall.platformUnsupported');

  // 下载卡住时重复点击：拿到同一个任务，不会并发写同一个目录。
  let release!: () => void;
  gate = new Promise((resolve) => { release = resolve; });
  const first = await install({ major: 21 });
  assert.equal(first.statusCode, 200, first.body);
  const second = await install({ major: 21 });
  assert.equal(second.json<TaskInfo>().id, first.json<TaskInfo>().id);
  release();
  const done = await waitForTask(first.json<TaskInfo>().id);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(downloads, 1);
  const runtimeId = done.result?.javaRuntimeId;
  assert.ok(runtimeId);
  assert.deepEqual(leftovers(), ['temurin-jdk-21.0.13_9'], '临时目录必须清掉');

  // 登记为面板安装；强制重新扫描后仍可用，实例启动前复验也能通过。
  const afterScan = await app.inject({ method: 'GET', url: '/api/system/java-runtimes?refresh=1', headers: authorization });
  const runtime = afterScan.json<JavaRuntimeListResult>().runtimes.find((item) => item.id === runtimeId);
  assert.ok(runtime);
  assert.equal(runtime.source, 'panel');
  assert.equal(runtime.majorVersion, 21);
  assert.equal(runtime.available, true);
  const command = await resolveJavaRuntimeCommand(runtimeId);
  assert.equal(fs.realpathSync(command), fs.realpathSync(runtime.path));

  // 已经装好：不重复下载，返回同一个运行时。
  const again = await waitForTask((await install({ major: 21 })).json<TaskInfo>().id);
  assert.equal(again.status, 'completed', again.error);
  assert.equal(again.result?.javaRuntimeId, runtimeId);
  assert.equal(downloads, 1);

  // 下载中取消：任务记成「你取消了这个任务」，临时目录清掉；别的任务和已结束的任务不能取消。
  const cancelUrl = (id: string) => `/api/system/java-runtimes/install/${encodeURIComponent(id)}/cancel`;
  const anonymousCancel = await app.inject({ method: 'POST', url: cancelUrl(done.id) });
  assert.equal(anonymousCancel.statusCode, 401);
  for (const id of [done.id, 'not-a-task']) {
    const refused = await app.inject({ method: 'POST', url: cancelUrl(id), headers: authorization });
    assert.equal(refused.statusCode, 409, id);
    assert.equal(refused.json<{ code: string }>().code, 'server.jvm.javaInstall.notCancellable');
  }
  gate = new Promise(() => {});
  const stuckId = (await install({ major: 8 })).json<TaskInfo>().id;
  for (let attempt = 0; attempt < 200 && getTask(stuckId)?.progress !== 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(getTask(stuckId)?.status, 'running');
  const cancel = await app.inject({ method: 'POST', url: cancelUrl(stuckId), headers: authorization });
  assert.equal(cancel.statusCode, 200, cancel.body);
  const cancelled = await waitForTask(stuckId);
  assert.equal(cancelled.status, 'failed');
  assert.equal(cancelled.messageI18n?.key, 'server.tasks.cancelled');
  assert.equal(cancelled.errorI18n?.key, 'server.tasks.cancelledByUser');
  assert.deepEqual(leftovers(), ['temurin-jdk-21.0.13_9'], '取消后临时目录必须清掉');
  const late = await app.inject({ method: 'POST', url: cancelUrl(stuckId), headers: authorization });
  assert.equal(late.statusCode, 409);
  gate = Promise.resolve();

  // 下载内容与钉死的摘要不符：丢弃，不留目录。
  serve = () => fakeJre('jdk8u512-b09-jre-tampered');
  const tampered = await waitForTask((await install({ major: 8 })).json<TaskInfo>().id);
  assert.equal(tampered.status, 'failed');
  assert.equal(tampered.errorI18n?.key, 'server.jvm.javaInstall.checksumMismatch');
  assert.deepEqual(leftovers(), ['temurin-jdk-21.0.13_9']);

  // 下载失败：提示可以换下载来源。
  serve = () => new Error('network down');
  const offline = await waitForTask((await install({ major: 8 })).json<TaskInfo>().id);
  assert.equal(offline.status, 'failed');
  assert.equal(offline.errorI18n?.key, 'server.jvm.javaInstall.downloadFailed');
  assert.deepEqual(leftovers(), ['temurin-jdk-21.0.13_9']);

  // 压缩包结构不对（两个顶层目录）：解压失败，不留目录。
  const twoTops = Buffer.concat([storedZip({ 'a/bin/java': 'x', 'b/bin/java': 'x' })]);
  TEMURIN_RELEASES[8].assets[TEST_PLATFORM] = { archive: 'fake-8.zip', sha256: sha256(twoTops) };
  serve = () => twoTops;
  const malformed = await waitForTask((await install({ major: 8 })).json<TaskInfo>().id);
  assert.equal(malformed.status, 'failed');
  assert.equal(malformed.errorI18n?.key, 'server.jvm.javaInstall.extractFailed');
  assert.deepEqual(leftovers(), ['temurin-jdk-21.0.13_9']);

  // 解压出来的 java 跑不起来：不登记，删掉目录。
  const broken = storedZip({ 'jdk8u512-b09-jre/bin/java': 'broken', 'jdk8u512-b09-jre/bin/java.exe': 'broken' });
  TEMURIN_RELEASES[8].assets[TEST_PLATFORM] = { archive: 'fake-8.zip', sha256: sha256(broken) };
  serve = () => broken;
  const unusable = await waitForTask((await install({ major: 8 })).json<TaskInfo>().id);
  assert.equal(unusable.status, 'failed');
  assert.equal(unusable.errorI18n?.key, 'server.jvm.javaInstall.verifyFailed');
  assert.deepEqual(leftovers(), ['temurin-jdk-21.0.13_9']);

  // 正常的 Java 8 能装上，和 21 并存。
  TEMURIN_RELEASES[8].assets[TEST_PLATFORM] = { archive: 'fake-8.zip', sha256: sha256(good8) };
  serve = (major) => (major === 21 ? good21 : good8);
  const java8 = await waitForTask((await install({ major: 8 })).json<TaskInfo>().id);
  assert.equal(java8.status, 'completed', java8.error);
  assert.deepEqual(leftovers().sort(), ['temurin-jdk-21.0.13_9', 'temurin-jdk8u512-b09']);
  const finalList = (await app.inject({ method: 'GET', url: '/api/system/java-runtimes', headers: authorization })).json<JavaRuntimeListResult>();
  assert.deepEqual(
    finalList.runtimes.filter((item) => item.source === 'panel' && item.available).map((item) => item.majorVersion).sort(),
    [21, 8].sort(),
  );
});
