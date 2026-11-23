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

/** Initializes the database in a temp data directory; the database must be closed before the directory is deleted, or the files are still held on Windows. */
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

/** A fetch stub that returns fixed content by URL and records every request. */
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

test('only the official URL is kept when the checksum is unknown, and third-party mirrors are not used', async () => {
  const { createDownloadPlan } = await import('./download-sources.js');
  const official = { label: 'Mojang', url: 'https://official.invalid/a.jar', mirror: false };
  const mirror = { label: 'BMCLAPI', url: 'https://mirror.invalid/a.jar', mirror: true };
  assert.deepEqual(createDownloadPlan([mirror, official]).candidates, [official]);
  const expected = { algorithm: 'sha1', hex: 'a'.repeat(40) } as const;
  assert.deepEqual(createDownloadPlan([mirror, official], expected).candidates, [mirror, official]);
});

test('mirror URL mapping recognizes only known official repositories', async () => {
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

test('under the official source GitHub files use only github.com, and the China source falls back to github.com last', async () => {
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

test('the Forge list under the official source does not access BMCLAPI and can build download URLs for old versions', async (t) => {
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

test('the Forge list under the China source is sorted by build number, and versions with a branch suffix match the official form', async (t) => {
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

test('the NeoForge list under the China source filters out versions outside the official coordinate, and an empty result falls back to official', async (t) => {
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

test('NeoForge version numbers follow old or new rules by segment count and map to the real Minecraft version', async () => {
  const { neoForgeVersionToMc } = await import('./core-metadata.js');
  const cases: Array<[string, string]> = [
    ['20.2.3-beta', '1.20.2'],
    ['20.4.253', '1.20.4'],
    ['21.0.167', '1.21'],
    ['21.0.0-beta', '1.21'],
    ['21.1.265', '1.21.1'],
    ['21.11.48', '1.21.11'],
    ['26.1.0.19-beta', '26.1'],
    ['26.1.1.15-beta', '26.1.1'],
    ['26.1.2.126', '26.1.2'],
    ['26.2.0.0-beta', '26.2'],
    ['26.3.0.101', '26.3'],
    ['26.1.0.0-alpha.1+snapshot-1', '26.1-snapshot-1'],
    ['26.1.0.0-alpha.14+snapshot-11', '26.1-snapshot-11'],
    ['26.1.0.0-alpha.15+pre-3', '26.1-pre-3'],
    ['0.25w14craftmine.3-beta', '25w14craftmine'],
  ];
  for (const [neoVersion, mcVersion] of cases) {
    assert.equal(neoForgeVersionToMc(neoVersion), mcVersion, neoVersion);
  }
  for (const invalid of ['', '21', '21.1', 'latest', '1.21.1-21.1.5']) {
    assert.throws(() => neoForgeVersionToMc(invalid), PanelError, invalid);
  }
});

test('the NeoForge lists of both sources show real version numbers and list only releases', async (t) => {
  const { listCoreVersions } = await import('./core-metadata.js');
  const versions = [
    '26.1.0.0-alpha.1+snapshot-1',
    '26.1.0.0-alpha.15+pre-3',
    '0.25w14craftmine.3-beta',
    '21.0.167',
    '21.1.265',
    '21.11.48',
    '26.1.0.19-beta',
    '26.1.2.126',
    '26.2.0.93',
    '26.3.0.101',
  ];
  const xml = `<metadata>${versions.map((v) => `<version>${v}</version>`).join('')}</metadata>`;
  const expected = ['26.3', '26.2', '26.1.2', '26.1', '1.21.11', '1.21.1', '1.21'];
  const calls = mockFetch(t, {
    'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml': () => new Response(xml),
    'https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/maven-metadata.xml': () => new Response(xml),
  });
  assert.deepEqual(await listCoreVersions('neoforge', undefined, 'official'), expected);
  assert.ok(calls.every((url) => url.includes('maven.neoforged.net')));
  assert.deepEqual(await listCoreVersions('neoforge', undefined, 'china'), expected);
  assert.ok(calls.some((url) => url.includes('bmclapi2')));
});

test('the NeoForge build lists of both sources match by real version number, and snapshot builds are not mixed into releases', async (t) => {
  const { listNeoForgeLoaders } = await import('./core-metadata.js');
  const metadata = [
    '26.1.0.0-alpha.1+snapshot-1',
    '26.1.0.0-alpha.2+snapshot-1',
    '26.1.0.1-beta',
    '26.1.0.19-beta',
    '26.1.2.125',
    '26.3.0.100',
    '26.1.2.126',
    '26.3.0.101',
    '21.1.265',
  ];
  mockFetch(t, {
    'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml': () =>
      new Response(`<metadata>${metadata.map((v) => `<version>${v}</version>`).join('')}</metadata>`),
    'https://bmclapi2.bangbang93.com/neoforge/list/26.1': () => Response.json([
      { version: '26.1.0.1-beta' },
      { version: '26.1.0.19-beta' },
    ]),
    'https://bmclapi2.bangbang93.com/neoforge/list/26.1.2': () => Response.json([
      { version: '26.1.2.125' },
      { version: '26.1.2.126' },
    ]),
    'https://bmclapi2.bangbang93.com/neoforge/list/26.3': () => Response.json([
      { version: '26.3.0.100' },
      { version: '26.3.0.101' },
    ]),
    'https://bmclapi2.bangbang93.com/neoforge/list/26.1-snapshot-1': () => Response.json([
      { version: '26.1.0.0-alpha.1+snapshot-1' },
      { version: '26.1.0.0-alpha.2+snapshot-1' },
    ]),
    'https://bmclapi2.bangbang93.com/neoforge/list/1.21.1': () => Response.json([{ version: '21.1.265' }]),
  });
  const expected: Array<[string, string[]]> = [
    ['26.3', ['26.3.0.101', '26.3.0.100']],
    ['26.1.2', ['26.1.2.126', '26.1.2.125']],
    ['26.1', ['26.1.0.19-beta', '26.1.0.1-beta']],
    ['26.1-snapshot-1', ['26.1.0.0-alpha.2+snapshot-1', '26.1.0.0-alpha.1+snapshot-1']],
    ['1.21.1', ['21.1.265']],
  ];
  for (const source of ['official', 'china'] as const) {
    for (const [mcVersion, loaders] of expected) {
      assert.deepEqual(await listNeoForgeLoaders(mcVersion, undefined, source), loaders, `${source} ${mcVersion}`);
    }
  }
  // The wrong version number from before the fix no longer matches anything in the official list.
  assert.deepEqual(await listNeoForgeLoaders('1.26.3', undefined, 'official'), []);
});

test('NeoForge builds are sorted numerically, and the default item is still the latest build when BMCLAPI is out of order', async (t) => {
  const { listNeoForgeLoaders } = await import('./core-metadata.js');
  // Taken from BMCLAPI's real response order for 1.21: the last item is an old beta, not the latest build.
  const order = ['21.0.150', '21.0.0-beta', '21.0.139-beta', '21.0.14-beta', '21.0.167', '21.0.98-beta'];
  mockFetch(t, {
    'https://bmclapi2.bangbang93.com/neoforge/list/1.21': () => Response.json(order.map((version) => ({ version }))),
    'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml': () =>
      new Response(`<metadata>${order.map((v) => `<version>${v}</version>`).join('')}</metadata>`),
  });
  const expected = ['21.0.167', '21.0.150', '21.0.139-beta', '21.0.98-beta', '21.0.14-beta', '21.0.0-beta'];
  assert.deepEqual(await listNeoForgeLoaders('1.21', undefined, 'china'), expected);
  assert.deepEqual(await listNeoForgeLoaders('1.21', undefined, 'official'), expected);
});

test('metadata falls back to official when the mirror fails, and the error lists the reason for each source when all fail', async (t) => {
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

test('the original error is kept when the official source fails, without mentioning third-party sources', async (t) => {
  const { listCoreVersions } = await import('./core-metadata.js');
  mockFetch(t, {
    'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json': () => new Response('bad', { status: 502 }),
  });
  await assert.rejects(
    listCoreVersions('vanilla', undefined, 'official'),
    (error) => hasMessageKey(error, 'server.deploy.metadataHttpFailed'),
  );
});

test('the Vanilla download plan carries SHA-1, and the China source prefers the mirror', async (t) => {
  const { resolveVanillaDownload } = await import('./core-metadata.js');
  const detail = JSON.stringify({
    downloads: { server: { url: 'https://piston-data.mojang.com/v1/objects/abc/server.jar', sha1: 'a'.repeat(40) } },
  });
  const calls = mockFetch(t, {
    // A manifest on the mirror is never read, even if a community node altered it: when resolving the download plan the manifest comes only from Mojang.
    'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json': () => Response.json({
      versions: [{
        id: '1.21.1',
        type: 'release',
        url: 'https://piston-meta.mojang.com/v1/packages/evil/1.21.1.json',
        sha1: 'e'.repeat(40),
      }],
    }),
    'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json': () => Response.json({
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
  assert.deepEqual(calls, [
    'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json',
    'https://bmclapi2.bangbang93.com/v1/packages/abc/1.21.1.json',
  ]);
});

test('when a community node alters the version details its checksum is not trusted and the details from Mojang are used instead', async (t) => {
  const { resolveVanillaDownload } = await import('./core-metadata.js');
  const genuineUrl = 'https://piston-data.mojang.com/v1/objects/genuine/server.jar';
  const genuine = JSON.stringify({ downloads: { server: { url: genuineUrl, sha1: 'a'.repeat(40) } } });
  const tampered = JSON.stringify({
    downloads: { server: { url: 'https://piston-data.mojang.com/v1/objects/evil/server.jar', sha1: 'e'.repeat(40) } },
  });
  mockFetch(t, {
    'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json': () => Response.json({
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

test('when the China source cannot reach the Mojang manifest it explains that the manifest must come from official, without switching to a mirrored manifest', async (t) => {
  const { resolveVanillaDownload } = await import('./core-metadata.js');
  const calls = mockFetch(t, {
    'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json': () => Response.json({ versions: [] }),
  });
  await assert.rejects(resolveVanillaDownload('1.21.1', new AbortController().signal, 'china'), (error) => {
    assert.ok(hasMessageKey(error, 'server.deploy.vanillaManifestNeedsMojang'));
    assert.match((error as PanelError).message, /Mojang: the server couldn't be reached\./);
    return true;
  });
  assert.deepEqual(calls, ['https://launchermeta.mojang.com/mc/game/version_manifest_v2.json']);
});

test('a manifest without a details SHA-1 is rejected, and no version details are read from any source', async (t) => {
  const { resolveVanillaDownload } = await import('./core-metadata.js');
  const calls = mockFetch(t, {
    'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json': () => Response.json({
      versions: [{ id: '1.21.1', type: 'release', url: 'https://piston-meta.mojang.com/v1/packages/abc/1.21.1.json' }],
    }),
    'https://piston-meta.mojang.com/v1/packages/abc/1.21.1.json': () => Response.json({
      downloads: { server: { url: 'https://piston-data.mojang.com/v1/objects/abc/server.jar', sha1: 'a'.repeat(40) } },
    }),
  });
  await assert.rejects(
    resolveVanillaDownload('1.21.1', new AbortController().signal, 'china'),
    (error) => hasMessageKey(error, 'server.deploy.vanillaMetadataUntrusted'),
  );
  assert.deepEqual(calls, ['https://launchermeta.mojang.com/mc/game/version_manifest_v2.json']);
});

/** A stub for a Vanilla manifest plus version details: the details text is returned as is, and the SHA-1 in the manifest matches it. */
function vanillaRoutes(
  detailUrl: string,
  server: { url?: string; sha1?: string },
  manifestUrl = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json',
): Record<string, () => Response> {
  const detail = JSON.stringify({ downloads: { server } });
  return {
    [manifestUrl]: () => Response.json({
      versions: [{ id: '1.21.1', type: 'release', url: detailUrl, sha1: sha1(detail) }],
    }),
    [detailUrl]: () => new Response(detail),
    ...(mojangMirror(detailUrl) ? { [mojangMirror(detailUrl)!]: () => new Response(detail) } : {}),
  };
}

function mojangMirror(url: string): string | null {
  const parsed = new URL(url);
  return parsed.hostname.endsWith('.mojang.com') ? `https://bmclapi2.bangbang93.com${parsed.pathname}` : null;
}

test('a version details URL in the manifest that is not on Mojang is rejected and never requested', async (t) => {
  const { resolveVanillaDownload } = await import('./core-metadata.js');
  const server = { url: 'https://piston-data.mojang.com/v1/objects/abc/server.jar', sha1: 'a'.repeat(40) };
  for (const detailUrl of [
    'https://evil.invalid/v1/packages/abc/1.21.1.json',
    'http://piston-meta.mojang.com/v1/packages/abc/1.21.1.json',
    'https://piston-meta.mojang.com.evil.invalid/v1/packages/abc/1.21.1.json',
  ]) {
    const calls = mockFetch(t, vanillaRoutes(detailUrl, server));
    await assert.rejects(
      resolveVanillaDownload('1.21.1', new AbortController().signal, 'china'),
      (error) => hasMessageKey(error, 'server.deploy.vanillaMetadataUntrusted'),
      detailUrl,
    );
    assert.ok(!calls.includes(detailUrl), detailUrl);
    t.mock.restoreAll();
  }
});

test('a server URL in the version details that is not on Mojang is rejected, and no download plan is produced', async (t) => {
  const { resolveVanillaDownload } = await import('./core-metadata.js');
  const detailUrl = 'https://piston-meta.mojang.com/v1/packages/abc/1.21.1.json';
  for (const source of ['official', 'china'] as const) {
    for (const url of ['https://evil.invalid/server.jar', 'http://piston-data.mojang.com/v1/objects/abc/server.jar']) {
      mockFetch(t, vanillaRoutes(detailUrl, { url, sha1: 'a'.repeat(40) },
        source === 'official' ? 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json' : undefined));
      await assert.rejects(
        resolveVanillaDownload('1.21.1', new AbortController().signal, source),
        (error) => hasMessageKey(error, 'server.deploy.vanillaMetadataUntrusted'),
        `${source} ${url}`,
      );
      t.mock.restoreAll();
    }
  }
});

test('version details missing the server SHA-1 are rejected, without falling back to an unverified download', async (t) => {
  const { resolveVanillaDownload } = await import('./core-metadata.js');
  const detailUrl = 'https://piston-meta.mojang.com/v1/packages/abc/1.21.1.json';
  const url = 'https://piston-data.mojang.com/v1/objects/abc/server.jar';
  for (const server of [{ url }, { url, sha1: 'not-a-sha1' }]) {
    for (const source of ['official', 'china'] as const) {
      mockFetch(t, vanillaRoutes(detailUrl, server,
        source === 'official' ? 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json' : undefined));
      await assert.rejects(
        resolveVanillaDownload('1.21.1', new AbortController().signal, source),
        (error) => hasMessageKey(error, 'server.deploy.vanillaMetadataUntrusted'),
        `${source} ${JSON.stringify(server)}`,
      );
      t.mock.restoreAll();
    }
  }
});

test('version details from the official URL that do not match the manifest SHA-1 are rejected as well', async (t) => {
  const { resolveVanillaDownload } = await import('./core-metadata.js');
  const detailUrl = 'https://piston-meta.mojang.com/v1/packages/abc/1.21.1.json';
  const genuine = JSON.stringify({
    downloads: { server: { url: 'https://piston-data.mojang.com/v1/objects/abc/server.jar', sha1: 'a'.repeat(40) } },
  });
  const tampered = JSON.stringify({
    downloads: { server: { url: 'https://piston-data.mojang.com/v1/objects/evil/server.jar', sha1: 'e'.repeat(40) } },
  });
  const manifest = () => Response.json({
    versions: [{ id: '1.21.1', type: 'release', url: detailUrl, sha1: sha1(genuine) }],
  });
  mockFetch(t, {
    'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json': manifest,
    [detailUrl]: () => new Response(tampered),
  });
  await assert.rejects(
    resolveVanillaDownload('1.21.1', new AbortController().signal, 'official'),
    (error) => hasMessageKey(error, 'server.system.downloadChecksumMismatch'),
  );
  t.mock.restoreAll();

  // Under the China source neither the mirror nor official matches: both sources report a checksum failure, and neither copy is used.
  mockFetch(t, {
    'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json': manifest,
    'https://bmclapi2.bangbang93.com/v1/packages/abc/1.21.1.json': () => new Response(tampered),
    [detailUrl]: () => new Response(tampered),
  });
  await assert.rejects(resolveVanillaDownload('1.21.1', new AbortController().signal, 'china'), (error) => {
    assert.ok(hasMessageKey(error, 'server.system.metadataAllSourcesFailed'));
    const text = (error as PanelError).message;
    assert.match(text, /BMCLAPI: the file failed its checksum check/);
    assert.match(text, /Mojang: the file failed its checksum check/);
    return true;
  });
});

/** A response stub with a final URL: a constructed Response has no url, so this simulates the result after following redirects. */
function redirectedResponse(body: string, finalUrl: string): Response {
  const response = new Response(body);
  Object.defineProperty(response, 'url', { value: finalUrl });
  return response;
}

test('an https request redirected to http is rejected, for both metadata and file downloads', async (t) => {
  const { fetchText } = await import('./core-metadata.js');
  const { downloadToFile, downloadFromPlan } = await import('./core-download.js');
  const dir = tempDir(t);
  const content = '核心内容';
  mockFetch(t, {
    'https://meta.invalid/list.json': () => redirectedResponse('[]', 'http://plain.invalid/list.json'),
    'https://mirror.invalid/core.jar': () => redirectedResponse(content, 'http://plain.invalid/core.jar'),
    'https://official.invalid/core.jar': () => redirectedResponse(content, 'https://node.invalid/core.jar'),
  });
  await assert.rejects(
    fetchText('https://meta.invalid/list.json'),
    (error) => hasMessageKey(error, 'server.system.downloadInsecureRedirect'),
  );
  const dest = path.join(dir, 'core.jar');
  await assert.rejects(
    downloadToFile('https://mirror.invalid/core.jar', dest),
    (error) => hasMessageKey(error, 'server.system.downloadInsecureRedirect'),
  );
  assert.deepEqual(fs.readdirSync(dir), [], '不落地任何文件');

  // Redirecting to an https community node works as usual; a rejected source has its own reason in the aggregated error.
  await downloadFromPlan(
    {
      candidates: [
        { label: 'Mirror', url: 'https://mirror.invalid/core.jar', mirror: true },
        { label: 'Official', url: 'https://official.invalid/core.jar', mirror: false },
      ],
      expected: { algorithm: 'sha256', hex: sha256(content) },
    },
    dest,
    { name: 'core.jar' },
  );
  assert.equal(fs.readFileSync(dest, 'utf8'), content);
  await assert.rejects(
    downloadFromPlan(
      {
        candidates: [
          { label: 'Mirror', url: 'https://mirror.invalid/core.jar', mirror: true },
          { label: 'Other', url: 'https://mirror.invalid/core.jar', mirror: true },
        ],
        expected: { algorithm: 'sha256', hex: sha256(content) },
      },
      path.join(dir, 'other.jar'),
      { name: 'core.jar' },
    ),
    (error) => {
      assert.ok(hasMessageKey(error, 'server.system.downloadAllSourcesFailed'));
      assert.match(
        renderPanelMessage((error as PanelError).toPanelMessage()),
        /Mirror: the server redirected to an address without HTTPS\. /,
      );
      return true;
    },
  );
});

test('the installer checksum comes only from the official Maven, and mirrors are not used when it cannot be fetched', async (t) => {
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

test('a mirror file with a mismatched checksum is discarded, and the file lands only after the next source succeeds', async (t) => {
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

test('when every source fails verification no file lands, and the error explains why and points to settings', async (t) => {
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
      assert.match(rendered, /Panel Settings page/);
      return true;
    },
  );
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('no further source is tried when the download is cancelled', async (t) => {
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

test('an unresponsive mirror is abandoned by the response time limit without using up the whole download timeout', async (t) => {
  const { downloadToFile } = await import('./core-download.js');
  const dir = tempDir(t);
  const server = createServer(() => {
    /* Never replies after receiving the request */
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

test('the download source is saved to the database, and the official source is used when unset or invalid', async (t) => {
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

test('an old database without the settings table gets it added automatically at startup', async (t) => {
  const { initDb, closeDb, getDb } = await tempDatabase(t);
  const { getDownloadSource } = await import('./download-sources.js');
  // Databases from before versioned migrations all report user_version 0, which is what sends them through the baseline.
  getDb().exec('DROP TABLE panel_settings; PRAGMA user_version = 0');
  closeDb();
  initDb();
  assert.equal(getDownloadSource(), 'official');
});

test('the prefetch list includes only files from known repositories that carry a checksum', async () => {
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

/** Writes a minimal installer jar containing only the manifest; the ZIP uses the stored method, so no compression library is needed. */
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

test('prefetch places verified dependencies where the installer looks for them, and failed files are left to the installer', async (t) => {
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
    'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json': () => Response.json({
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

test('an old-format installer or a corrupted manifest does not affect the deploy', async (t) => {
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
