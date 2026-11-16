/**
 * better-auth's rate limiter, backed by the same Redis counters as the rest of
 * the app (@repo/security), instead of its default per-process memory. With
 * memory, N web replicas each allow AUTH_RATE_LIMIT_MAX: N times the limit on
 * the password endpoints.
 *
 * `consume` is the atomic path better-auth uses when present (one Lua INCR +
 * EXPIRE). `get`/`set` are its legacy fallback, kept minimal.
 *
 * Redis down → FALL BACK to an in-process memory limiter, with a warning at
 * most once a minute. better-auth consults this on EVERY /api/auth/* request,
 * session checks included, so failing closed would take the whole app down
 * with Redis. Per-process limits during an outage are still limits.
 */
import type { BetterAuthOptions } from "better-auth";
import {
  memoryStore,
  rateLimit,
  redisStore,
  requestRedis,
  type CounterStore,
} from "@repo/security";

type BetterAuthRateLimitStorage = NonNullable<
  NonNullable<BetterAuthOptions["rateLimit"]>["customStorage"]
>;
type Stored = Awaited<ReturnType<BetterAuthRateLimitStorage["get"]>>;

export interface StorageOptions {
  /** TTL for the legacy get/set path. */
  fallbackWindowSeconds: number;
  /** The shared store. Default: Redis. */
  primary?: CounterStore;
  /** Legacy get/set backend. Default: Redis strings. */
  kv?: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, ttlSeconds: number): Promise<unknown>;
  };
  now?: () => number;
  warn?: (message: string, err: unknown) => void;
}

const WARN_EVERY_MS = 60_000;

export function redisRateLimitStorage(
  opts: StorageOptions,
): BetterAuthRateLimitStorage {
  const now = opts.now ?? Date.now;
  const primary = opts.primary ?? redisStore;
  const fallback = memoryStore(now);
  const kv = opts.kv ?? {
    get: (k) => requestRedis().get(k),
    set: (k, v, ttl) => requestRedis().set(k, v, "EX", ttl),
  };
  const localKv = new Map<string, { value: Stored; expiresAt: number }>();
  const warn = opts.warn ?? ((m, err) => console.warn(m, err));
  let lastWarned = -Infinity;
  const degraded = (err: unknown) => {
    if (now() - lastWarned < WARN_EVERY_MS) return;
    lastWarned = now();
    warn(
      "[auth] rate limiter: Redis unreachable, using a per-process memory limiter until it is back:",
      err,
    );
  };

  return {
    async consume(k, rule) {
      const args = {
        key: `auth:${k}`,
        limit: rule.max,
        windowSeconds: rule.window,
      };
      let r;
      try {
        r = await rateLimit({ ...args, store: primary });
      } catch (err) {
        degraded(err);
        r = await rateLimit({ ...args, store: fallback });
      }
      return {
        allowed: r.allowed,
        retryAfter: r.allowed ? null : r.resetSeconds,
      };
    },
    async get(k) {
      try {
        const raw = await kv.get(`ba:auth:${k}`);
        return raw ? (JSON.parse(raw) as Stored) : null;
      } catch (err) {
        degraded(err);
        const hit = localKv.get(k);
        return hit && hit.expiresAt > now() ? hit.value : null;
      }
    },
    async set(k, value) {
      try {
        await kv.set(
          `ba:auth:${k}`,
          JSON.stringify(value),
          opts.fallbackWindowSeconds,
        );
      } catch (err) {
        degraded(err);
        localKv.set(k, {
          value,
          expiresAt: now() + opts.fallbackWindowSeconds * 1000,
        });
      }
    },
  };
}
