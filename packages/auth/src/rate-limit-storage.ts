/**
 * better-auth's rate limiter, backed by the same Redis counters as the rest of
 * the app (@repo/security), instead of its default per-process memory. With
 * memory, N web replicas each allow AUTH_RATE_LIMIT_MAX: N times the limit on
 * the password endpoints.
 *
 * `consume` is the atomic path better-auth uses when present (one Lua INCR +
 * EXPIRE). `get`/`set` are its legacy fallback, kept minimal.
 *
 * Fails CLOSED: if Redis is unreachable the error propagates and the auth
 * request fails. This limiter protects users' accounts from brute force, and
 * an app whose Redis is down is degraded anyway.
 */
import type { BetterAuthOptions } from "better-auth";
import { rateLimit, requestRedis } from "@repo/security";

type BetterAuthRateLimitStorage = NonNullable<
  NonNullable<BetterAuthOptions["rateLimit"]>["customStorage"]
>;

export function redisRateLimitStorage(
  fallbackWindowSeconds: number,
): BetterAuthRateLimitStorage {
  const key = (k: string) => `auth:${k}`;
  return {
    async consume(k, rule) {
      const r = await rateLimit({
        key: key(k),
        limit: rule.max,
        windowSeconds: rule.window,
      });
      return {
        allowed: r.allowed,
        retryAfter: r.allowed ? null : r.resetSeconds,
      };
    },
    async get(k) {
      const raw = await requestRedis().get(`ba:${key(k)}`);
      return raw ? JSON.parse(raw) : null;
    },
    async set(k, value) {
      await requestRedis().set(
        `ba:${key(k)}`,
        JSON.stringify(value),
        "EX",
        fallbackWindowSeconds,
      );
    },
  };
}
