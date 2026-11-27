/**
 * Rate limiter regression: unmatched routes share one bucket instead of keying by raw URL,
 * and bucket maps stay bounded in memory.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { createRateLimitHook } from './security-service.js';

test('unmatched routes share a single rate-limit bucket instead of creating one per raw URL', async (t) => {
  const app = Fastify();
  app.addHook('onRequest', createRateLimitHook({ name: 'test-global', max: 3, windowMs: 60_000 }));
  app.get('/api/known', async () => ({ ok: true }));
  t.after(() => app.close());

  for (let i = 0; i < 3; i += 1) {
    const response = await app.inject({ method: 'POST', url: `/missing-${i}` });
    assert.equal(response.statusCode, 404);
  }
  const fourthMissing = await app.inject({ method: 'POST', url: '/missing-unique-path' });
  assert.equal(fourthMissing.statusCode, 429, 'distinct unmatched paths from one IP must share a single bucket');

  // Known routes keep their own bucket so 404 traffic on another route does not exhaust /api/known directly.
  const known = await app.inject({ method: 'GET', url: '/api/known' });
  assert.equal(known.statusCode, 200);
});

test('rate-limit bucket map enforces maxBuckets cap and evicts oldest entries under IP flood', async (t) => {
  const hook = createRateLimitHook({ name: 'bounded', max: 2, windowMs: 60_000, maxBuckets: 3 });
  const app = Fastify();
  app.addHook('onRequest', hook);
  app.get('/ping', async () => ({ ok: true }));
  t.after(() => app.close());

  for (let i = 0; i < 10; i += 1) {
    const res = await app.inject({ method: 'GET', url: '/ping', remoteAddress: `198.51.100.${i + 1}` });
    assert.equal(res.statusCode, 200);
  }
  // Most recent IP is still tracked and hits 429 on its 3rd request.
  const secondRecent = await app.inject({ method: 'GET', url: '/ping', remoteAddress: '198.51.100.10' });
  assert.equal(secondRecent.statusCode, 200);
  const thirdRecent = await app.inject({ method: 'GET', url: '/ping', remoteAddress: '198.51.100.10' });
  assert.equal(thirdRecent.statusCode, 429);

  // Earliest IP was evicted when the cap of 3 was exceeded, so its counter restarted from 1.
  const evictedIp = await app.inject({ method: 'GET', url: '/ping', remoteAddress: '198.51.100.1' });
  assert.equal(evictedIp.statusCode, 200);
  assert.equal(evictedIp.headers['x-ratelimit-remaining'], '1');
});
