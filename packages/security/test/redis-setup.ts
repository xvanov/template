/** Point the request-path Redis client at the real Redis found by globalSetup. */
import { afterAll, inject } from "vitest";

import { closeRequestRedis } from "../src/redis";

process.env.REDIS_URL = inject("redisUrl");

afterAll(async () => {
  await closeRequestRedis();
});
