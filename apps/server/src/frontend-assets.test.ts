import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import Fastify from 'fastify';
import { inlineScriptHashes, registerFrontendAssets } from './frontend-assets.js';

async function createAssetsApp(t: test.TestContext) {
  const webDist = await mkdtemp(path.join(os.tmpdir(), 'mystry-static-assets-'));
  t.after(async () => {
    await rm(webDist, { recursive: true, force: true });
  });
  await mkdir(path.join(webDist, 'assets'));
  await writeFile(path.join(webDist, 'index.html'), '<!doctype html><title>面板</title>');
  const app = Fastify();
  await registerFrontendAssets(app, webDist);
  await app.ready();
  t.after(async () => {
    await app.close();
  });
  return { app, webDist };
}

test('hashed assets are cached long-term and precompressed copies are sent by Accept-Encoding', async (t) => {
  const { app, webDist } = await createAssetsApp(t);
  const source = 'export const value = "预压缩";'.repeat(20);
  await writeFile(path.join(webDist, 'assets', 'entry-abc123.js'), source);
  await writeFile(path.join(webDist, 'assets', 'entry-abc123.js.br'), brotliCompressSync(source));

  const compressed = await app.inject({
    method: 'GET',
    url: '/assets/entry-abc123.js',
    headers: { 'accept-encoding': 'br, gzip' },
  });
  assert.equal(compressed.statusCode, 200);
  assert.equal(compressed.headers['content-encoding'], 'br');
  assert.match(compressed.headers['content-type'] ?? '', /^application\/javascript\b/);
  assert.match(String(compressed.headers.vary ?? ''), /accept-encoding/i);
  assert.equal(compressed.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(brotliDecompressSync(compressed.rawPayload).toString('utf8'), source);

  // Clients without compression support fall back to the original file; the cache policy is unchanged.
  const plain = await app.inject({ method: 'GET', url: '/assets/entry-abc123.js' });
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.body, source);
  assert.equal(plain.headers['cache-control'], 'public, max-age=31536000, immutable');
});

test('the entry page and SPA fallback are revalidated every time so upgrades do not reference old assets', async (t) => {
  const { app } = await createAssetsApp(t);
  for (const url of ['/', '/index.html', '/instances/demo/console']) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 200, url);
    assert.match(response.body, /面板/, url);
    assert.equal(response.headers['cache-control'], 'no-cache', url);
  }
});

test('new module assets are still served with a JavaScript MIME type after the build output updates', async (t) => {
  const webDist = await mkdtemp(path.join(os.tmpdir(), 'mystry-static-assets-'));
  t.after(async () => {
    await rm(webDist, { recursive: true, force: true });
  });

  await mkdir(path.join(webDist, 'assets'));
  await writeFile(path.join(webDist, 'index.html'), '<!doctype html><title>面板</title>');

  const app = Fastify();
  await registerFrontendAssets(app, webDist);
  await app.ready();
  t.after(async () => {
    await app.close();
  });

  await writeFile(path.join(webDist, 'assets', 'updated-entry.js'), 'export const ready = true;');

  const response = await app.inject({ method: 'GET', url: '/assets/updated-entry.js' });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'] ?? '', /^application\/javascript\b/);
  assert.equal(response.body, 'export const ready = true;');
});

const INLINE_SCRIPT_TEXT = "\n  document.documentElement.dataset.appearance = 'dark';\n  // 面板\n";
const INDEX_WITH_INLINE_SCRIPT = [
  '<!doctype html><html><head><title>面板</title>',
  `<script>${INLINE_SCRIPT_TEXT}</script>`,
  '<script type="module" crossorigin src="/assets/entry-abc123.js"></script>',
  '</head><body><div id="root"></div></body></html>',
].join('\n');

function sha256Source(text: string): string {
  return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
}

function directive(policy: string, name: string): string[] {
  const found = policy.split(';').map((part) => part.trim()).find((part) => part.split(' ')[0] === name);
  return found ? found.split(' ').slice(1) : [];
}

async function createAppWithIndex(t: test.TestContext, indexHtml: string) {
  const webDist = await mkdtemp(path.join(os.tmpdir(), 'mystry-static-csp-'));
  t.after(async () => {
    await rm(webDist, { recursive: true, force: true });
  });
  await mkdir(path.join(webDist, 'assets'));
  await writeFile(path.join(webDist, 'index.html'), indexHtml);
  const app = Fastify();
  await registerFrontendAssets(app, webDist);
  await app.ready();
  t.after(async () => {
    await app.close();
  });
  return { app, webDist };
}

test('the inline script hash is the SHA-256 of its text and the external module script is not hashed', () => {
  assert.deepEqual(inlineScriptHashes(INDEX_WITH_INLINE_SCRIPT), [sha256Source(INLINE_SCRIPT_TEXT)]);
});

test('inline script hashes ignore the line ending style the way the browser does', () => {
  const crlf = INDEX_WITH_INLINE_SCRIPT.replace(/\n/g, '\r\n');
  assert.deepEqual(inlineScriptHashes(crlf), inlineScriptHashes(INDEX_WITH_INLINE_SCRIPT));
  assert.deepEqual(inlineScriptHashes(INDEX_WITH_INLINE_SCRIPT.replace(/\n/g, '\r')), inlineScriptHashes(INDEX_WITH_INLINE_SCRIPT));
});

test('a page without inline scripts yields no hashes, and every distinct inline script gets its own hash', () => {
  assert.deepEqual(inlineScriptHashes('<title>面板</title><script src="/a.js"></script><script type="module" src="/b.js"></script>'), []);
  assert.deepEqual(inlineScriptHashes('<script>a()</script><script>a()</script><script>b()</script>'), [sha256Source('a()'), sha256Source('b()')]);
});

test('the real index.html of the web app yields the hash of its inline appearance and language script', async () => {
  const source = await readFile(fileURLToPath(new URL('../../web/index.html', import.meta.url)), 'utf8');
  const start = source.indexOf('<script>') + '<script>'.length;
  const text = source.slice(start, source.indexOf('</script>', start)).replace(/\r\n?/g, '\n');
  assert.ok(text.includes('mystry_appearance'), 'the first plain <script> of index.html is no longer the appearance script');
  assert.deepEqual(inlineScriptHashes(source), [sha256Source(text)]);
});

test('HTML responses carry a policy that allows the hashed inline script and nothing else for scripts', async (t) => {
  const { app } = await createAppWithIndex(t, INDEX_WITH_INLINE_SCRIPT);
  for (const url of ['/', '/index.html', '/instances/demo/console']) {
    const response = await app.inject({ method: 'GET', url, headers: { host: '192.168.1.20:3000' } });
    assert.equal(response.statusCode, 200, url);
    const policy = String(response.headers['content-security-policy']);
    assert.deepEqual(directive(policy, 'script-src'), ["'self'", sha256Source(INLINE_SCRIPT_TEXT)], url);
    assert.deepEqual(directive(policy, 'default-src'), ["'self'"], url);
    assert.deepEqual(directive(policy, 'object-src'), ["'none'"], url);
    assert.deepEqual(directive(policy, 'base-uri'), ["'none'"], url);
    assert.deepEqual(directive(policy, 'frame-ancestors'), ["'none'"], url);
    assert.deepEqual(directive(policy, 'form-action'), ["'self'"], url);
    assert.deepEqual(directive(policy, 'img-src'), ["'self'", 'data:'], url);
    assert.deepEqual(directive(policy, 'style-src'), ["'self'", "'unsafe-inline'"], url);
    // Scripts must never be allowed inline or through eval, whichever other directive relaxes style.
    assert.ok(!directive(policy, 'script-src').includes("'unsafe-inline'"), url);
    assert.ok(!directive(policy, 'script-src').includes("'unsafe-eval'"), url);
    assert.ok(!directive(policy, 'default-src').includes("'unsafe-inline'"), url);
  }
});

test('the policy names the page host for WebSockets, and a malformed Host header cannot add anything to it', async (t) => {
  const { app } = await createAppWithIndex(t, INDEX_WITH_INLINE_SCRIPT);
  const policyFor = async (host: string) => String(
    (await app.inject({ method: 'GET', url: '/', headers: { host } })).headers['content-security-policy'],
  );

  assert.deepEqual(directive(await policyFor('192.168.1.20:3000'), 'connect-src'), ["'self'", 'ws://192.168.1.20:3000', 'wss://192.168.1.20:3000']);
  assert.deepEqual(directive(await policyFor('panel.example.com'), 'connect-src'), ["'self'", 'ws://panel.example.com', 'wss://panel.example.com']);
  for (const host of ['*', 'a.example; script-src *', 'a b', '[::1]:3000', 'evil.example/', ':3000', 'a.example:99999999']) {
    const policy = await policyFor(host);
    assert.deepEqual(directive(policy, 'connect-src'), [], host);
    assert.deepEqual(directive(policy, 'script-src'), ["'self'", sha256Source(INLINE_SCRIPT_TEXT)], host);
    assert.ok(!policy.includes('*'), host);
  }
});

test('only HTML responses get the policy', async (t) => {
  const { app, webDist } = await createAppWithIndex(t, INDEX_WITH_INLINE_SCRIPT);
  await writeFile(path.join(webDist, 'assets', 'entry-abc123.js'), 'export const ready = true;');
  for (const url of ['/assets/entry-abc123.js', '/api/anything']) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.headers['content-security-policy'], undefined, url);
  }
});

test('the policy follows index.html when the frontend is rebuilt under a running panel', async (t) => {
  const { app, webDist } = await createAppWithIndex(t, INDEX_WITH_INLINE_SCRIPT);
  const before = await app.inject({ method: 'GET', url: '/' });
  assert.ok(String(before.headers['content-security-policy']).includes(sha256Source(INLINE_SCRIPT_TEXT)));

  await writeFile(path.join(webDist, 'index.html'), INDEX_WITH_INLINE_SCRIPT.replace('dark', 'light'));
  const after = await app.inject({ method: 'GET', url: '/' });
  assert.deepEqual(directive(String(after.headers['content-security-policy']), 'script-src'), [
    "'self'",
    sha256Source(INLINE_SCRIPT_TEXT.replace('dark', 'light')),
  ]);
});

test('without a build output nothing is registered and no policy can block the dev server page', async (t) => {
  const missing = path.join(os.tmpdir(), `mystry-static-missing-${process.pid}-${Date.now()}`);
  const app = Fastify();
  await assert.doesNotReject(registerFrontendAssets(app, missing));
  await app.ready();
  t.after(async () => {
    await app.close();
  });
  const response = await app.inject({ method: 'GET', url: '/' });
  assert.equal(response.statusCode, 404);
  assert.equal(response.headers['content-security-policy'], undefined);
});

test('a build output folder without a readable index.html does not break startup and sends no policy', async (t) => {
  const webDist = await mkdtemp(path.join(os.tmpdir(), 'mystry-static-empty-'));
  t.after(async () => {
    await rm(webDist, { recursive: true, force: true });
  });
  await writeFile(path.join(webDist, 'other.html'), '<!doctype html><title>x</title>');
  const app = Fastify();
  await assert.doesNotReject(registerFrontendAssets(app, webDist));
  await app.ready();
  t.after(async () => {
    await app.close();
  });
  const response = await app.inject({ method: 'GET', url: '/other.html' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-security-policy'], undefined);
});
