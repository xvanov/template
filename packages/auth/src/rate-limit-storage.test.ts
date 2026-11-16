import { describe, expect, it, vi } from "vitest";
import { memoryStore, type CounterStore } from "@repo/security";

import { redisRateLimitStorage } from "./rate-limit-storage";

const down: CounterStore = {
  hit: () => Promise.reject(new Error("ECONNREFUSED")),
};
const kvDown = {
  get: () => Promise.reject(new Error("ECONNREFUSED")),
  set: () => Promise.reject(new Error("ECONNREFUSED")),
};
const rule = { window: 60, max: 2 };

describe("better-auth rate-limit storage", () => {
  it("counts in the shared store while it is up", async () => {
    const storage = redisRateLimitStorage({
      fallbackWindowSeconds: 60,
      primary: memoryStore(),
    });
    const results = [];
    for (let i = 0; i < 3; i++)
      results.push((await storage.consume!("ip:1", rule)).allowed);
    expect(results).toEqual([true, true, false]);
  });

  it("Redis down: still limits (in memory), never throws, warns at most once a minute", async () => {
    let t = 0;
    const warn = vi.fn();
    const storage = redisRateLimitStorage({
      fallbackWindowSeconds: 60,
      primary: down,
      kv: kvDown,
      now: () => t,
      warn,
    });

    const results = [];
    for (let i = 0; i < 3; i++)
      results.push(await storage.consume!("ip:1", rule));
    expect(results.map((r) => r.allowed)).toEqual([true, true, false]);
    expect(results[2]!.retryAfter).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledTimes(1);

    // The legacy get/set path degrades the same way.
    await storage.set("ip:2", { key: "ip:2", count: 1, lastRequest: 0 });
    expect(await storage.get("ip:2")).toMatchObject({ count: 1 });
    expect(warn).toHaveBeenCalledTimes(1);

    t = 61_000;
    await storage.consume!("ip:3", rule);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
