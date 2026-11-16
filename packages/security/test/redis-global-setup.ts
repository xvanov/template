/**
 * Vitest globalSetup for tests that need a REAL Redis (the counter script is
 * Redis-side Lua; a mock would agree with any script).
 *
 * Uses TEST_REDIS_URL, else REDIS_URL from the root .env, else the
 * .env.example default. Redis down = the run FAILS with instructions; it never
 * skips, because a skipped test looks exactly like a passing one. Tests must
 * use a unique key prefix and delete their keys: this is the dev Redis.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse } from "dotenv";
import IORedis from "ioredis";
import type { TestProject } from "vitest/node";

const ROOT_ENV = resolve(import.meta.dirname, "../../../.env");

function url(): string {
  if (process.env.TEST_REDIS_URL) return process.env.TEST_REDIS_URL;
  if (existsSync(ROOT_ENV)) {
    const fromFile = parse(readFileSync(ROOT_ENV)).REDIS_URL;
    if (fromFile) return fromFile;
  }
  return "redis://localhost:6389";
}

export default async function setup(project: TestProject) {
  const target = url();
  const probe = new IORedis(target, {
    lazyConnect: true,
    connectTimeout: 2000,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  try {
    await probe.connect();
    await probe.ping();
  } catch (err) {
    throw new Error(
      [
        "",
        `Redis integration tests need Redis, and it is not reachable at ${target}`,
        `  (${err instanceof Error ? err.message : String(err)})`,
        "",
        "  Start it:  make up        (docker compose: redis on :6389)",
        "  Or point TEST_REDIS_URL at a disposable Redis.",
        "",
      ].join("\n"),
    );
  } finally {
    probe.disconnect();
  }
  project.provide("redisUrl", target);
}

declare module "vitest" {
  export interface ProvidedContext {
    redisUrl: string;
  }
}
