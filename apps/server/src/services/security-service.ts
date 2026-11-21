import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { panelErrorBody } from '../utils/errors.js';
import { clientKey } from '../utils/request-origin.js';

type RateLimitOptions = {
  max: number;
  windowMs: number;
  name: string;
};

type Bucket = {
  count: number;
  resetAt: number;
};

export type LoginFailureLimiter = {
  isBlocked: (request: FastifyRequest, reply: FastifyReply, username: string) => boolean;
  recordFailure: (request: FastifyRequest, reply: FastifyReply, username: string) => void;
  reset: (request: FastifyRequest, username: string) => void;
};

/** Compares the token in the request header in constant time, so differences in comparison time do not leak the token. Always rejects when no token is configured. */
export function tokenMatches(value: string | string[] | undefined, expected: string | null): boolean {
  if (expected === null || typeof value !== 'string') return false;
  const expectedBytes = Buffer.from(expected, 'utf8');
  const actualBytes = Buffer.from(value, 'utf8');
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

/**
 * Lightweight in-memory rate limiter. The panel is a single-process service, and using a Fastify hook avoids a plugin coupled to the Fastify version.
 * Proxy trust is not enabled, so the request.ip verified by Fastify is used here and arbitrary X-Forwarded-For is not trusted;
 * requests arriving through the panel's built-in network all count as one origin and do not share a quota with this machine (clientKey).
 */
export function createRateLimitHook(options: RateLimitOptions) {
  const buckets = new Map<string, Bucket>();
  let lastCleanup = 0;

  return async function rateLimitHook(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const now = Date.now();
    if (now - lastCleanup > options.windowMs) {
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
      }
      lastCleanup = now;
    }

    const route = request.routeOptions.url || request.url.split('?')[0];
    const key = `${options.name}:${clientKey(request)}:${route}`;
    const current = buckets.get(key);
    const bucket = current && current.resetAt > now
      ? current
      : { count: 0, resetAt: now + options.windowMs };

    bucket.count += 1;
    buckets.set(key, bucket);

    reply.header('X-RateLimit-Limit', String(options.max));
    reply.header('X-RateLimit-Remaining', String(Math.max(0, options.max - bucket.count)));
    reply.header('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > options.max) {
      reply.header('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      reply.code(429).send(panelErrorBody('server.common.tooManyRequests'));
    }
  };
}
/**
 * Failed sign-in rate limiter: only password verification failures are counted; a successful sign-in clears the record, so normal admin activity is not locked out.
 */
export function createLoginFailureLimiter(options: RateLimitOptions): LoginFailureLimiter {
  const buckets = new Map<string, Bucket>();
  let lastCleanup = 0;

  function cleanup(now: number): void {
    if (now - lastCleanup <= options.windowMs) return;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
    lastCleanup = now;
  }

  function getKey(request: FastifyRequest, username: string): string {
    // Username case must not be a way around the failure count; actual authentication keeps its original case semantics.
    return [options.name, clientKey(request), username.trim().toLowerCase()].join(':');
  }

  function getActiveBucket(key: string, now: number): Bucket | undefined {
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt > now) return bucket;
    buckets.delete(key);
    return undefined;
  }

  function setHeaders(reply: FastifyReply, bucket: Bucket, now: number): void {
    reply.header('X-RateLimit-Limit', String(options.max));
    reply.header('X-RateLimit-Remaining', String(Math.max(0, options.max - bucket.count)));
    reply.header('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count >= options.max) {
      reply.header('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
    }
  }

  return {
    isBlocked(request, reply, username) {
      const now = Date.now();
      cleanup(now);
      const bucket = getActiveBucket(getKey(request, username), now);
      if (!bucket) return false;
      setHeaders(reply, bucket, now);
      if (bucket.count < options.max) return false;
      reply.code(429).send(panelErrorBody('server.common.tooManyRequests'));
      return true;
    },
    recordFailure(request, reply, username) {
      const now = Date.now();
      cleanup(now);
      const key = getKey(request, username);
      const bucket = getActiveBucket(key, now) ?? { count: 0, resetAt: now + options.windowMs };
      bucket.count += 1;
      buckets.set(key, bucket);
      setHeaders(reply, bucket, now);
    },
    reset(request, username) {
      buckets.delete(getKey(request, username));
    },
  };
}
