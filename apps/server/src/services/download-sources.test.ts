import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { renderPanelMessage, type ServerMessageKey } from '@mystry/shared';
import { PanelError } from '../utils/errors.js';

process.env.JWT_SECRET = randomBytes(32).toString('hex');
process.env.SETUP_TOKEN = randomBytes(32).toString('hex');
process.env.LAUNCHER_TOKEN = randomBytes(32).toString('hex');

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const sha1 = (data: string | Buffer) => createHash('sha1').update(data).digest('hex');

function hasMessageKey(error: unknown, key: ServerMessageKey): boolean {
  return error instanceof PanelError && error.messageKey === key;
}

function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-sources-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 在临时数据目录里初始化数据库；必须先关库再删目录，否则 Windows 上文件仍被占用。 */
async function tempDatabase(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-sources-db-'));
  const originalDataDir = process.env.MYSTRY_DATA_DIR;
  process.env.MYSTRY_DATA_DIR = dir;
  const db = await import('../db.js');
  db.initDb();
  t.after(() => {
    db.closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.MYSTRY_DATA_DIR;
    else process.env.MYSTRY_DATA_DIR = originalDataDir;
  });
  return { dir, ...db };
}

/** 按地址返回固定内容的 fetch 替身，记录每一次请求。 */
function mockFetch(t: TestContext, routes: Record<string, () => Response | Promise<Response>>): string[] {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    const value = String(url);
    calls.push(value);
    const route = routes[value];
    if (!route) throw new TypeError('fetch failed');
    return route();
  });
  return calls;
}

test('校验值未知时只保留官方地址，第三方镜像不会被使用', async () => {
  const { createDownloadPlan } = await import('./download-sources.js');
  const official = { label: 'Mojang', url: 'https://official.invalid/a.jar', mirror: false };
  const mirror = { label: 'BMCLAPI', url: 'https://mirror.invalid/a.jar', mirror: true };
  assert.deepEqual(createDownloadPlan([mirror, official]).candidates, [official]);
  const expected = { algorithm: 'sha1', hex: 'a'.repeat(40) } as const;
  assert.deepEqual(createDownloadPlan([mirror, official], expected).candidates, [mirror, official]);
});

test('镜像地址映射只认已知的官方仓库', async () => {
  const { mavenMirrorUrl, mojangMirrorUrl } = await import('./download-sources.js');
  assert.equal(
    mavenMirrorUrl('https://libraries.minecraft.net/com/mojang/logging/1.1.1/logging-1.1.1.jar'),
    'https://bmclapi2.bangbang93.com/maven/com/mojang/logging/1.1.1/logging-1.1.1.jar',
  );
  assert.equal(
    mavenMirrorUrl('https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.1/a.jar'),
    'https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/21.1.1/a.jar',
  );
  assert.equal(mavenMirrorUrl('https://maven.example.com/a.jar'), null);
  assert.equal(
    mojangMirrorUrl('https://piston-data.mojang.com/v1/objects/abc/server.jar'),
    'https://bmclapi2.bangbang93.com/v1/objects/abc/server.jar',
  );
  assert.equal(mojangMirrorUrl('https://piston-data.mojang.com.evil.invalid/a.jar'), null);
  assert.equal(mojangMirrorUrl('not a url'), null);
});

test('官方来源下 GitHub 文件只走 github.com，国内来源最后回到 github.com', async () => {
  const { githubReleaseCandidates } = await import('./download-sources.js');
  const official = githubReleaseCandidates('official', 'fatedier/frp', 'v1', 'a.zip');
  assert.deepEqual(official.map((c) => c.url), ['https://github.com/fatedier/frp/releases/download/v1/a.zip']);
  const china = githubReleaseCandidates('china', 'fatedier/frp', 'v1', 'a.zip');
  assert.equal(china[0]!.label, 'NJU Mirror');
  assert.equal(china.at(-1)!.url, official[0]!.url);
  assert.equal(china.at(-1)!.mirror, false);
  assert.ok(china.slice(0, -1).every((c) => c.mirror));
  const lan = githubReleaseCandidates('china', 'EasyTier/EasyTier', 'v1', 'a.zip');
  assert.ok(!lan.some((c) => c.label === 'NJU Mirror'), '南京大学镜像没有 EasyTier');
});

test('官方来源的 Forge 列表不访问 BMCLAPI，并能拼出旧版本的下载地址', async (t) => {
  const { forgeInstallerUrl, listCoreVersions, listForgeLoaders } = await import('./core-metadata.js');
  const calls = mockFetch(t, {
    'https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json': () => Response.json({
      '1.7.10': ['1.7.10-10.13.4.1566-1.7.10', '1.7.10-10.13.4.1614-1.7.10'],
      '1.20.1': ['1.20.1-47.4.27', '1.20.1-47.4.28'],
    }),
  });
  assert.deepEqual(await listCoreVersions('forge', undefined, 'official'), ['1.20.1', '1.7.10']);
  assert.deepEqual(await listForgeLoaders('1.20.1', undefined, 'official'), ['47.4.28', '47.4.27']);
  assert.deepEqual(await listForgeLoaders('9.9.9', undefined, 'official'), []);
  const [newest] = await listForgeLoaders('1.7.10', undefined, 'official');
  assert.equal(
    forgeInstallerUrl('1.7.10', newest!),
    'https://maven.minecraftforge.net/net/minecraftforge/forge/1.7.10-10.13.4.1614-1.7.10/forge-1.7.10-10.13.4.1614-1.7.10-installer.jar',
  );
  assert.ok(calls.every((url) => !url.includes('bmclapi')));
});

test('国内来源的 Forge 列表按构建号排序，带分支后缀的版本与官方写法一致', async (t) => {
  const { listForgeLoaders } = await import('./core-metadata.js');
  mockFetch(t, {
    'https://bmclapi2.bangbang93.com/forge/minecraft/1.20.1': () => Response.json([
      { version: '47.4.24', build: 47040024 },
      { version: '47.4.28', build: 47040028 },
      { version: '47.4.27', build: 47040027 },
    ]),
    'https://bmclapi2.bangbang93.com/forge/minecraft/1.7.10': () => Response.json([
      { version: '10.13.4.1614', build: 1614, branch: '1.7.10' },
    ]),
  });
  assert.deepEqual(await listForgeLoaders('1.20.1', undefined, 'china'), ['47.4.28', '47.4.27', '47.4.24']);
  assert.deepEqual(await listForgeLoaders('1.7.10', undefined, 'china'), ['10.13.4.1614-1.7.10']);
});

test('国内来源的 NeoForge 列表过滤掉官方坐标之外的版本，空结果回到官方', async (t) => {
  const { listNeoForgeLoaders } = await import('./core-metadata.js');
  const calls = mockFetch(t, {
    'https://bmclapi2.bangbang93.com/neoforge/list/1.20.1': () => Response.json([{ version: '47.1.5' }]),
    'https://bmclapi2.bangbang93.com/neoforge/list/1.21.1': () => Response.json([
      { version: '21.1.1' },
      { version: '21.1.2' },
    ]),
    'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml': () =>
      new Response('<metadata><version>21.1.1</version></metadata>'),
  });
  assert.deepEqual(await listNeoForgeLoaders('1.21.1', undefined, 'china'), ['21.1.2', '21.1.1']);
  assert.deepEqual(await listNeoForgeLoaders('1.20.1', undefined, 'china'), []);
  assert.ok(calls.some((url) => url.includes('maven.neoforged.net')));
});

test('镜像失败时元数据回到官方，全部失败时错误列出每个来源的原因', async (t) => {
  const { listCoreVersions } = await import('./core-metadata.js');
  const routes: Record<string, () => Response> = {
    'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json': () => new Response('bad', { status: 503 }),
    'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json': () =>
      Response.json({ versions: [{ id: '1.21.1', type: 'release', url: 'https://piston-meta.mojang.com/x.json' }] }),
  };
  mockFetch(t, routes);
  assert.deepEqual(await listCoreVersions('vanilla', undefined, 'china'), ['1.21.1']);

  delete routes['https://launchermeta.mojang.com/mc/game/version_manifest_v2.json'];
  await assert.rejects(listCoreVersions('vanilla', undefined, 'china'), (error) => {
    assert.ok(hasMessageKey(error, 'server.system.metadataAllSourcesFailed'));
    const text = (error as PanelError).message;
    assert.match(text, /BMCLAPI: the server returned HTTP 503\./);
    assert.match(text, /Mojang: the server couldn't be reached\./);
    return true;
  });
});

test('官方来源失败时保留原有错误，不提第三方来源', async (t) => {
  const { listCoreVersions } = await import('./core-metadata.js');
  mockFetch(t, {
    'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json': () => new Response('bad', { status: 502 }),
  });
  await assert.rejects(
    listCoreVersions('vanilla', undefined, 'official'),
    (error) => hasMessageKey(error, 'server.deploy.metadataHttpFailed'),
  );
});

test('Vanilla 下载计划带上 SHA-1，国内来源优先镜像', async (t) => {
  const { resolveVanillaDownload } = await import('./core-metadata.js');
  const detail = JSON.stringify({
    downloads: { server: { url: 'https://piston-data.mojang.com/v1/objects/abc/server.jar', sha1: 'a'.repeat(40) } },
  });
  const calls = mockFetch(t, {
    'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json': () => Response.json({
      versions: [{
        id: '1.21.1',
        type: 'release',
        url: 'https://piston-meta.mojang.com/v1/packages/abc/1.21.1.json',
        sha1: sha1(detail),
      }],
    }),
    'https://bmclapi2.bangbang93.com/v1/packages/abc/1.21.1.json': () => new Response(detail),
  });
  const plan = await resolveVanillaDownload('1.21.1', new AbortController().signal, 'china');
  assert.deepEqual(plan.expected, { algorithm: 'sha1', hex: 'a'.repeat(40) });
  assert.deepEqual(plan.candidates.map((c) => c.url), [
    'https://bmclapi2.bangbang93.com/v1/objects/abc/server.jar',
    'https://piston-data.mojang.com/v1/objects/abc/server.jar',
  ]);
  assert.ok(calls.every((url) => url.includes('bmclapi')));
});

test('社区节点改动版本详情时不采信它的校验值，改用 Mojang 的详情', async (t) => {
  const { resolveVanillaDownload } = await import('./core-metadata.js');
  const genuineUrl = 'https://piston-data.mojang.com/v1/objects/genuine/server.jar';
  const genuine = JSON.stringify({ downloads: { server: { url: genuineUrl, sha1: 'a'.repeat(40) } } });
  const tampered = JSON.stringify({
    downloads: { server: { url: 'https://piston-data.mojang.com/v1/objects/evil/server.jar', sha1: 'e'.repeat(40) } },
  });
  mockFetch(t, {
    'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json': () => Response.json({
      versions: [{
        id: '1.21.1',
        type: 'release',
        url: 'https://piston-meta.mojang.com/v1/packages/abc/1.21.1.json',
        sha1: sha1(genuine),
      }],
    }),
    'https://bmclapi2.bangbang93.com/v1/packages/abc/1.21.1.json': () => new Response(tampered),
    'https://piston-meta.mojang.com/v1/packages/abc/1.21.1.json': () => new Response(genuine),
  });
  const plan = await resolveVanillaDownload('1.21.1', new AbortController().signal, 'china');
  assert.deepEqual(plan.expected, { algorithm: 'sha1', hex: 'a'.repeat(40) });
  assert.equal(plan.candidates.at(-1)!.url, genuineUrl);
});

test('清单没有详情 SHA-1 时不读镜像上的版本详情', async (t) => {
  const { resolveVanillaDownload } = await import('./core-metadata.js');
  const calls = mockFetch(t, {
    'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json': () => Response.json({
      versions: [{ id: '1.21.1', type: 'release', url: 'https://piston-meta.mojang.com/v1/packages/abc/1.21.1.json' }],
    }),
    'https://piston-meta.mojang.com/v1/packages/abc/1.21.1.json': () => Response.json({
      downloads: { server: { url: 'https://piston-data.mojang.com/v1/objects/abc/server.jar', sha1: 'a'.repeat(40) } },
    }),
  });
  await resolveVanillaDownload('1.21.1', new AbortController().signal, 'china');
  assert.ok(!calls.includes('https://bmclapi2.bangbang93.com/v1/packages/abc/1.21.1.json'));
});

test('安装器校验值只取自官方 Maven，取不到时不使用镜像', async (t) => {
  const { resolveInstallerDownload } = await import('./core-metadata.js');
  const official = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.1/neoforge-21.1.1-installer.jar';
  const hex = 'b'.repeat(64);
  const routes: Record<string, () => Response> = { [`${official}.sha256`]: () => new Response(`${hex}\n`) };
  const calls = mockFetch(t, routes);
  const plan = await resolveInstallerDownload('neoforge', '1.21.1', '21.1.1', undefined, 'china');
  assert.deepEqual(plan.expected, { algorithm: 'sha256', hex });
  assert.equal(plan.candidates.length, 2);
  assert.equal(plan.candidates[0]!.label, 'BMCLAPI');
  assert.ok(calls.every((url) => !url.includes('bmclapi')), '校验文件不能来自镜像');

  delete routes[`${official}.sha256`];
  const fallback = await resolveInstallerDownload('neoforge', '1.21.1', '21.1.1', undefined, 'china');
  assert.equal(fallback.expected, undefined);
  assert.deepEqual(fallback.candidates.map((c) => c.url), [official]);
});

test('校验值不符的镜像文件被丢弃，下一个来源成功后才落地', async (t) => {
  const { downloadFromPlan } = await import('./core-download.js');
  const dir = tempDir(t);
  const dest = path.join(dir, 'core.jar');
  const content = '官方内容';
  mockFetch(t, {
    'https://mirror.invalid/core.jar': () => new Response('被篡改的内容'),
    'https://official.invalid/core.jar': () => new Response(content),
  });
  const sources: string[] = [];
  await downloadFromPlan(
    {
      candidates: [
        { label: 'Mirror', url: 'https://mirror.invalid/core.jar', mirror: true },
        { label: 'Official', url: 'https://official.invalid/core.jar', mirror: false },
      ],
      expected: { algorithm: 'sha256', hex: sha256(content) },
    },
    dest,
    { name: 'core.jar', onProgress: (_ratio, source) => sources.push(source) },
  );
  assert.equal(fs.readFileSync(dest, 'utf8'), content);
  assert.deepEqual(fs.readdirSync(dir), ['core.jar'], '不留下临时文件');
});

test('所有来源校验都失败时不落地文件，错误说明原因并指向设置', async (t) => {
  const { downloadFromPlan } = await import('./core-download.js');
  const dir = tempDir(t);
  const dest = path.join(dir, 'core.jar');
  mockFetch(t, {
    'https://mirror.invalid/core.jar': () => new Response('错误内容'),
    'https://official.invalid/core.jar': () => new Response('bad', { status: 404 }),
  });
  await assert.rejects(
    downloadFromPlan(
      {
        candidates: [
          { label: 'Mirror', url: 'https://mirror.invalid/core.jar', mirror: true },
          { label: 'Official', url: 'https://official.invalid/core.jar', mirror: false },
        ],
        expected: { algorithm: 'sha256', hex: sha256('期望内容') },
      },
      dest,
      { name: 'core.jar' },
    ),
    (error) => {
      assert.ok(hasMessageKey(error, 'server.system.downloadAllSourcesFailed'));
      const rendered = renderPanelMessage((error as PanelError).toPanelMessage());
      assert.match(rendered, /core\.jar couldn't be downloaded from any source/);
      assert.match(rendered, /Mirror: the file failed its checksum check and was discarded\. /);
      assert.doesNotMatch(rendered, /\.\./);
      assert.match(rendered, /Official: the server returned HTTP 404/);
      assert.match(rendered, /This Machine page/);
      return true;
    },
  );
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('取消下载时不再尝试下一个来源', async (t) => {
  const { downloadFromPlan } = await import('./core-download.js');
  const dir = tempDir(t);
  const controller = new AbortController();
  const calls = mockFetch(t, {
    'https://mirror.invalid/core.jar': () => {
      controller.abort(new PanelError('server.tasks.aborted'));
      throw new TypeError('fetch failed');
    },
  });
  await assert.rejects(
    downloadFromPlan(
      {
        candidates: [
          { label: 'Mirror', url: 'https://mirror.invalid/core.jar', mirror: true },
          { label: 'Official', url: 'https://official.invalid/core.jar', mirror: false },
        ],
        expected: { algorithm: 'sha256', hex: sha256('x') },
      },
      path.join(dir, 'core.jar'),
      { name: 'core.jar', signal: controller.signal },
    ),
    (error) => hasMessageKey(error, 'server.tasks.aborted'),
  );
  assert.deepEqual(calls, ['https://mirror.invalid/core.jar']);
});

test('不响应的镜像按响应时限放弃，不耗尽整段下载超时', async (t) => {
  const { downloadToFile } = await import('./core-download.js');
  const dir = tempDir(t);
  const server = createServer(() => {
    /* 收到请求后一直不回复 */
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address() as { port: number };
  await assert.rejects(
    downloadToFile(`http://127.0.0.1:${port}/core.jar`, path.join(dir, 'core.jar'), undefined, undefined, {
      responseTimeoutMs: 50,
    }),
    (error) => hasMessageKey(error, 'server.deploy.downloadTimeout'),
  );
});

test('下载来源保存到数据库，未设置或值无效时用官方来源', async (t) => {
  const { getDb } = await tempDatabase(t);
  const { getDownloadSource, setDownloadSource } = await import('./download-sources.js');
  assert.equal(getDownloadSource(), 'official');
  setDownloadSource('china');
  assert.equal(getDownloadSource(), 'china');
  setDownloadSource('official');
  assert.equal(getDownloadSource(), 'official');
  getDb().prepare(`UPDATE panel_settings SET value = 'nowhere' WHERE key = 'download_source'`).run();
  assert.equal(getDownloadSource(), 'official');
});

test('旧数据库没有设置表时启动自动补上', async (t) => {
  const { initDb, closeDb, getDb } = await tempDatabase(t);
  const { getDownloadSource } = await import('./download-sources.js');
  getDb().exec('DROP TABLE panel_settings');
  closeDb();
  initDb();
  assert.equal(getDownloadSource(), 'official');
});

test('预取清单只收已知仓库且带校验值的文件', async () => {
  const { collectPrefetchTargets, resolveServerJarPath } = await import('./installer-prefetch.js');
  const artifact = (url: string, sha1: string | undefined, file = 'a/b.jar') => ({
    downloads: { artifact: { path: file, url, sha1 } },
  });
  const targets = collectPrefetchTargets([
    artifact('https://libraries.minecraft.net/a/b.jar', 'c'.repeat(40)),
    artifact('https://libraries.minecraft.net/a/b.jar', 'c'.repeat(40)),
    artifact('https://maven.example.com/x.jar', 'c'.repeat(40), 'x.jar'),
    artifact('https://maven.minecraftforge.net/y.jar', undefined, 'y.jar'),
    artifact('', 'c'.repeat(40), 'bundled.jar'),
    {},
  ]);
  assert.deepEqual(targets, [{
    relativePath: 'a/b.jar',
    url: 'https://bmclapi2.bangbang93.com/maven/a/b.jar',
    sha1: 'c'.repeat(40),
  }]);
  assert.equal(
    resolveServerJarPath('{LIBRARY_DIR}/net/minecraft/server/{MINECRAFT_VERSION}/server-{MINECRAFT_VERSION}.jar', '1.21.1'),
    'libraries/net/minecraft/server/1.21.1/server-1.21.1.jar',
  );
  assert.equal(resolveServerJarPath(undefined, '1.16.5'), './minecraft_server.1.16.5.jar');
});

/** 写一个只含清单的最小安装器 jar；ZIP 用存储方式，不需要压缩库。 */
function writeInstallerJar(file: string, entries: Record<string, string>): void {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(text);
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    local.push(header, nameBytes, data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(nameBytes.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, nameBytes);
    offset += header.length + nameBytes.length + data.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...local, centralBytes, end]));
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

test('预取把通过校验的依赖放到安装器要找的位置，失败的文件留给安装器', async (t) => {
  const { dir } = await tempDatabase(t);
  const { setDownloadSource } = await import('./download-sources.js');
  const { prefetchInstallerFiles } = await import('./installer-prefetch.js');
  setDownloadSource('china');

  const instanceDir = path.join(dir, 'staging');
  fs.mkdirSync(instanceDir);
  const installer = path.join(dir, 'installer.jar');
  const library = (file: string, sha: string) => ({
    downloads: { artifact: { path: file, url: `https://libraries.minecraft.net/${file}`, sha1: sha } },
  });
  writeInstallerJar(installer, {
    'install_profile.json': JSON.stringify({
      minecraft: '1.21.1',
      json: '/version.json',
      serverJarPath: '{LIBRARY_DIR}/net/minecraft/server/{MINECRAFT_VERSION}/server-{MINECRAFT_VERSION}.jar',
      libraries: [library('good/a.jar', sha1('依赖 A'))],
    }),
    'version.json': JSON.stringify({
      libraries: [library('bad/b.jar', sha1('期望内容')), library('escape/../../../c.jar', sha1('依赖 C'))],
    }),
  });
  const serverJar = '服务端内容';
  const versionDetail = JSON.stringify({
    downloads: { server: { url: 'https://piston-data.mojang.com/v1/objects/abc/server.jar', sha1: sha1(serverJar) } },
  });
  mockFetch(t, {
    'https://bmclapi2.bangbang93.com/maven/good/a.jar': () => new Response('依赖 A'),
    'https://bmclapi2.bangbang93.com/maven/bad/b.jar': () => new Response('被篡改的内容'),
    'https://bmclapi2.bangbang93.com/maven/escape/../../../c.jar': () => new Response('依赖 C'),
    'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json': () => Response.json({
      versions: [{
        id: '1.21.1',
        type: 'release',
        url: 'https://piston-meta.mojang.com/v1/packages/abc/1.21.1.json',
        sha1: sha1(versionDetail),
      }],
    }),
    'https://bmclapi2.bangbang93.com/v1/packages/abc/1.21.1.json': () => new Response(versionDetail),
    'https://bmclapi2.bangbang93.com/v1/objects/abc/server.jar': () => new Response(serverJar),
  });

  const progress: Array<[number, number]> = [];
  await prefetchInstallerFiles(installer, instanceDir, new AbortController().signal, (done, total) => {
    progress.push([done, total]);
  });

  assert.equal(fs.readFileSync(path.join(instanceDir, 'libraries/good/a.jar'), 'utf8'), '依赖 A');
  assert.equal(fs.existsSync(path.join(instanceDir, 'libraries/bad/b.jar')), false, '校验失败不落地');
  assert.equal(fs.existsSync(path.join(dir, 'c.jar')), false, '清单里的路径不能逃出实例目录');
  assert.equal(
    fs.readFileSync(path.join(instanceDir, 'libraries/net/minecraft/server/1.21.1/server-1.21.1.jar'), 'utf8'),
    serverJar,
  );
  assert.deepEqual(progress.at(-1), [3, 3]);
});

test('旧格式安装器或损坏的清单不影响部署', async (t) => {
  const { prefetchInstallerFiles } = await import('./installer-prefetch.js');
  const dir = tempDir(t);
  const legacy = path.join(dir, 'legacy.jar');
  writeInstallerJar(legacy, { 'install_profile.json': JSON.stringify({ install: { target: 'x' } }) });
  const broken = path.join(dir, 'broken.jar');
  fs.writeFileSync(broken, '不是 ZIP');
  const calls = mockFetch(t, {});
  const signal = new AbortController().signal;
  await prefetchInstallerFiles(legacy, dir, signal, () => assert.fail('不应有进度'));
  await prefetchInstallerFiles(broken, dir, signal, () => assert.fail('不应有进度'));
  assert.deepEqual(calls, []);
});
