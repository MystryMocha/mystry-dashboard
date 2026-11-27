/**
 * Rate limiter regression: unmatched routes share one bucket instead of keying by raw URL,
 * and bucket maps stay bounded in memory.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { createLoginFailureLimiter, createRateLimitHook } from './security-service.js';
import { createPasswordWorkerPool } from './password-hash.js';
import { PanelError } from '../utils/errors.js';

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

test('login failure limiter blocks rotating random usernames from one IP once ipMax is reached', async (t) => {
  const limiter = createLoginFailureLimiter({ name: 'test-login', max: 2, ipMax: 4, windowMs: 60_000 });
  const app = Fastify();
  app.post<{ Body: { username: string } }>('/login', async (req, reply) => {
    if (limiter.isBlocked(req, reply, req.body.username)) return reply;
    limiter.recordFailure(req, reply, req.body.username);
    return reply.code(401).send({ error: 'invalid' });
  });
  t.after(() => app.close());

  for (let i = 0; i < 4; i += 1) {
    const res = await app.inject({
      method: 'POST',
      url: '/login',
      remoteAddress: '198.51.100.77',
      payload: { username: `random-user-${i}` },
    });
    assert.equal(res.statusCode, 401);
  }
  const blocked = await app.inject({
    method: 'POST',
    url: '/login',
    remoteAddress: '198.51.100.77',
    payload: { username: 'brand-new-user' },
  });
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.headers['x-ratelimit-limit'], '4');
});

test('password worker pool verifies bcrypt hashes off the event loop and rejects excess concurrency with 429', async (t) => {
  const pool = createPasswordWorkerPool({ maxConcurrentVerifications: 1, idleTimeoutMs: 500 });
  t.after(() => pool.shutdown());

  const hash = await pool.hashPassword('correct-password-1234', 10);
  assert.equal(await pool.verifyPassword('correct-password-1234', hash), true);
  assert.equal(await pool.verifyPassword('wrong-password-1234', hash), false);

  // Start one real bcrypt check and immediately fire a second one; the concurrency cap of 1 must reject the second with 429.
  const first = pool.verifyPassword('wrong-password-1234', hash);
  await assert.rejects(
    () => pool.verifyPassword('wrong-password-1234', hash),
    (error: unknown) =>
      error instanceof PanelError
      && error.statusCode === 429
      && error.messageKey === 'server.common.tooManyRequests',
  );
  assert.equal(await first, false);
});
