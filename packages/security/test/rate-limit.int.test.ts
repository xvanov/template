/**
 * The counter script against real Redis: atomic INCR + EXPIRE, TTL set on the
 * first hit only, and keys that do not live forever.
 */
import { randomBytes } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { rateLimit, redisStore, requestRedis } from "../src/index";

const prefix = `vt-${randomBytes(4).toString("hex")}`;

afterAll(async () => {
  const keys = await requestRedis().keys(`rl:${prefix}:*`);
  if (keys.length) await requestRedis().del(...keys);
});

describe("redisStore", () => {
  it("counts hits and refuses past the limit", async () => {
    const key = `${prefix}:limit`;
    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(
        await rateLimit({
          key,
          limit: 2,
          windowSeconds: 60,
          store: redisStore,
        }),
      );
    }
    expect(results.map((r) => [r.count, r.allowed])).toEqual([
      [1, true],
      [2, true],
      [3, false],
    ]);
  });

  it("sets the window's TTL on the first hit and does not push it forward", async () => {
    const key = `${prefix}:ttl`;
    await redisStore.hit(key, 100);
    await requestRedis().expire(`rl:${key}`, 50); // simulate time passing
    const second = await redisStore.hit(key, 100);
    expect(second.count).toBe(2);
    expect(second.ttl).toBeLessThanOrEqual(50);
    expect(second.ttl).toBeGreaterThan(0);
  });

  it("is atomic under concurrency: N parallel hits produce counts 1..N", async () => {
    const key = `${prefix}:race`;
    const counts = await Promise.all(
      Array.from({ length: 20 }, () =>
        redisStore.hit(key, 60).then((r) => r.count),
      ),
    );
    expect(counts.sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    expect(await requestRedis().ttl(`rl:${key}`)).toBeGreaterThan(0);
  });
});
