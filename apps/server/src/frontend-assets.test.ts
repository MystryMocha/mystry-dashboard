import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import Fastify from 'fastify';
import { registerFrontendAssets } from './frontend-assets.js';

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

test('带 hash 的资源长期缓存，并按 Accept-Encoding 发送预压缩副本', async (t) => {
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

  // 不支持压缩的客户端回落原文件，缓存策略不变。
  const plain = await app.inject({ method: 'GET', url: '/assets/entry-abc123.js' });
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.body, source);
  assert.equal(plain.headers['cache-control'], 'public, max-age=31536000, immutable');
});

test('入口页与 SPA 回落页每次重新校验，避免升级后引用旧资源', async (t) => {
  const { app } = await createAssetsApp(t);
  for (const url of ['/', '/index.html', '/instances/demo/console']) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 200, url);
    assert.match(response.body, /面板/, url);
    assert.equal(response.headers['cache-control'], 'no-cache', url);
  }
});

test('构建产物更新后仍以 JavaScript MIME 提供新增模块资源', async (t) => {
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
