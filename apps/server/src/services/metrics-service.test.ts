import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { MetricsService, cpuUsage, readProcesses } from './metrics-service.js';

test('CPU is normalized by whole-machine capacity and a counter going backwards is rejected', () => {
  assert.equal(cpuUsage(1000, 1000, 8), 12.5);
  assert.equal(cpuUsage(16000, 1000, 8), 100);
  assert.equal(cpuUsage(-1, 1000, 8), null);
  assert.equal(cpuUsage(0, 0, 8), null);
});

test('concurrent requests share a sample, the short-term cache does not query again, and a missing disk is not disguised as zero space', async () => {
  const service = new MetricsService(`${os.tmpdir()}/mystry-nonexistent-metrics-${process.pid}`, () => []);
  const first = service.get();
  assert.equal(first, service.get());
  const result = await first;
  assert.equal(result, await service.get());
  assert.equal(result.cpuPercent, null);
  assert.equal(result.disk, null);
  assert.ok(result.memory.totalBytes > 0);
  assert.deepEqual(result.instances, {});
});

test('real collection on this platform queries only the target process and returns cumulative CPU and resident memory', { skip: !['win32', 'linux'].includes(process.platform) }, async () => {
  const rows = await readProcesses([{ id: 'test-only', pid: process.pid }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.pid, process.pid);
  assert.ok(rows[0]!.memoryBytes > 0);
  assert.ok(rows[0]!.cpuMs >= 0);
  assert.ok(rows[0]!.identity);
});

test('the real monitoring route rejects unauthenticated requests and returns a resource snapshot after authentication', async () => {
  // Authentication checks the token version, so the route tests use an empty database in a temp data directory, never reading or writing user instances or using real secrets.
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-metrics-route-test-'));
  process.env.JWT_SECRET = randomBytes(32).toString('hex');
  process.env.SETUP_TOKEN = randomBytes(32).toString('hex');
  process.env.LAUNCHER_TOKEN = randomBytes(32).toString('hex');
  process.env.MYSTRY_DATA_DIR = dataRoot;
  const { systemRoutes } = await import('../routes/system.js');
  const { registerAuthHooks } = await import('../routes/auth.js');
  const { initDb, closeDb } = await import('../db.js');
  const { setupAdmin } = await import('./auth-service.js');
  initDb();
  const user = setupAdmin('metrics-test', 'metrics-test-password');
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET });
  registerAuthHooks(app);
  await app.register(systemRoutes);
  try {
    assert.equal((await app.inject('/api/system/metrics')).statusCode, 401);
    const token = app.jwt.sign({ id: user.id, username: user.username, tv: user.tokenVersion });
    const response = await app.inject({ url: '/api/system/metrics', headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.statusCode, 200);
    const data = response.json();
    assert.ok(data.memory.totalBytes > 0);
    assert.ok(data.disk.totalBytes > 0);
    assert.deepEqual(data.instances, {});
    assert.ok(Number.isFinite(Date.parse(data.sampledAt)));
  } finally {
    await app.close();
    closeDb();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
