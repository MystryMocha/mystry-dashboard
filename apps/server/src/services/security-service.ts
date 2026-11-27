import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { panelErrorBody } from '../utils/errors.js';
import { clientKey } from '../utils/request-origin.js';

const DEFAULT_MAX_BUCKETS = 10_000;
const UNMATCHED_ROUTE_KEY = '<unmatched>';

type RateLimitOptions = {
  max: number;
  windowMs: number;
  name: string;
  maxBuckets?: number;
};

type Bucket = {
  count: number;
  resetAt: number;
};

type BoundedBuckets = {
  cleanup: (now: number, force?: boolean) => void;
  getActive: (key: string, now: number) => Bucket | undefined;
  set: (key: string, bucket: Bucket, now: number) => void;
  delete: (key: string) => void;
};

function createBoundedBuckets(windowMs: number, maxBuckets = DEFAULT_MAX_BUCKETS): BoundedBuckets {
  const limit = Math.max(1, Math.floor(maxBuckets));
  const buckets = new Map<string, Bucket>();
  let lastCleanup = 0;

  function cleanup(now: number, force = false): void {
    if (!force && now - lastCleanup <= windowMs) return;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
    lastCleanup = now;
  }

  return {
    cleanup,
    getActive(key, now) {
      const bucket = buckets.get(key);
      if (!bucket || bucket.resetAt > now) return bucket;
      buckets.delete(key);
      return undefined;
    },
    set(key, bucket, now) {
      if (!buckets.has(key) && buckets.size >= limit) {
        cleanup(now, true);
        while (buckets.size >= limit) {
          const oldestKey = buckets.keys().next().value;
          if (oldestKey === undefined) break;
          buckets.delete(oldestKey);
        }
      }
      // Refresh insertion order so eviction always removes the least recently updated bucket first.
      buckets.delete(key);
      buckets.set(key, bucket);
    },
    delete(key) {
      buckets.delete(key);
    },
  };
}

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
  const buckets = createBoundedBuckets(options.windowMs, options.maxBuckets);

  return async function rateLimitHook(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const now = Date.now();
    buckets.cleanup(now);

    // Collapse 404 / unmatched paths into one bucket per client so random URLs cannot bypass rate limiting or grow memory without bound.
    const route = request.routeOptions.url || UNMATCHED_ROUTE_KEY;
    const key = `${options.name}:${clientKey(request)}:${route}`;
    const bucket = buckets.getActive(key, now) ?? { count: 0, resetAt: now + options.windowMs };

    bucket.count += 1;
    buckets.set(key, bucket, now);

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
  const buckets = createBoundedBuckets(options.windowMs, options.maxBuckets);

  function getKey(request: FastifyRequest, username: string): string {
    // Username case must not be a way around the failure count; actual authentication keeps its original case semantics.
    return [options.name, clientKey(request), username.trim().toLowerCase()].join(':');
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
      buckets.cleanup(now);
      const bucket = buckets.getActive(getKey(request, username), now);
      if (!bucket) return false;
      setHeaders(reply, bucket, now);
      if (bucket.count < options.max) return false;
      reply.code(429).send(panelErrorBody('server.common.tooManyRequests'));
      return true;
    },
    recordFailure(request, reply, username) {
      const now = Date.now();
      buckets.cleanup(now);
      const key = getKey(request, username);
      const bucket = buckets.getActive(key, now) ?? { count: 0, resetAt: now + options.windowMs };
      bucket.count += 1;
      buckets.set(key, bucket, now);
      setHeaders(reply, bucket, now);
    },
    reset(request, username) {
      buckets.delete(getKey(request, username));
    },
  };
}
