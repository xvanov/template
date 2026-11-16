/**
 * Fixed-window rate limiting, backed by Redis so every process (web replicas,
 * the worker) shares one count.
 *
 * The store is in-memory ONLY under NODE_ENV=test: an in-memory limiter in
 * production is per-process, so N replicas quietly allow N times the limit.
 *
 * Errors propagate; the caller picks the failure mode. The rule of thumb used
 * in this repo: a limit that protects OTHER PEOPLE (outbound message caps)
 * fails closed; a limit that protects our own capacity (API throttling) fails
 * open with a warning, so a Redis blip is not an outage.
 */
import { env } from "@repo/env";

import { requestRedis } from "./redis";

export interface RateLimitResult {
  allowed: boolean;
  /** Hits in the current window, including this one. */
  count: number;
  limit: number;
  /** Seconds until the window resets. */
  resetSeconds: number;
}

export interface CounterStore {
  /** Increment `key`; start a `windowSeconds` expiry on the first hit. */
  hit(
    key: string,
    windowSeconds: number,
  ): Promise<{ count: number; ttl: number }>;
}

/**
 * INCR and EXPIRE in one atomic script. As two separate commands (the
 * original), a crash between them leaves a key with no TTL: a permanent ban.
 */
const HIT_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return {c, redis.call('TTL', KEYS[1])}`;

export const redisStore: CounterStore = {
  async hit(key, windowSeconds) {
    const [count, ttl] = (await requestRedis().eval(
      HIT_SCRIPT,
      1,
      `rl:${key}`,
      windowSeconds,
    )) as [number, number];
    return { count, ttl };
  },
};

/** For tests. `now` is injectable so windows can be crossed without sleeping. */
export function memoryStore(now: () => number = Date.now): CounterStore & {
  clear(): void;
} {
  const entries = new Map<string, { count: number; expiresAt: number }>();
  return {
    clear: () => entries.clear(),
    async hit(key, windowSeconds) {
      const t = now();
      let entry = entries.get(key);
      if (!entry || entry.expiresAt <= t) {
        entry = { count: 0, expiresAt: t + windowSeconds * 1000 };
        entries.set(key, entry);
      }
      entry.count += 1;
      return {
        count: entry.count,
        ttl: Math.max(1, Math.ceil((entry.expiresAt - t) / 1000)),
      };
    },
  };
}

const testStore = memoryStore();

/** Clear the shared test store between tests. */
export function resetTestRateLimits(): void {
  testStore.clear();
}

function defaultStore(): CounterStore {
  return env().NODE_ENV === "test" ? testStore : redisStore;
}

export async function rateLimit(opts: {
  /** Who and what, e.g. `trpc:items.queueSummary:user:<id>`. */
  key: string;
  limit: number;
  windowSeconds: number;
  store?: CounterStore;
}): Promise<RateLimitResult> {
  const store = opts.store ?? defaultStore();
  const { count, ttl } = await store.hit(opts.key, opts.windowSeconds);
  return {
    allowed: count <= opts.limit,
    count,
    limit: opts.limit,
    resetSeconds: ttl > 0 ? ttl : opts.windowSeconds,
  };
}

/** A 429 with `Retry-After`, for route handlers. */
export function tooManyRequests(result: RateLimitResult): Response {
  return Response.json(
    { error: "Too many requests" },
    {
      status: 429,
      headers: { "Retry-After": String(result.resetSeconds) },
    },
  );
}
