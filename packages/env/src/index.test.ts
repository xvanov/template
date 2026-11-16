import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  env,
  googleEnabled,
  llmEnabled,
  resetEnvCache,
  serverEnvKeys,
} from "./index";

const snapshot = { ...process.env };

function setBaseline() {
  process.env.DATABASE_URL = "postgresql://u:p@localhost:5442/app";
  process.env.REDIS_URL = "redis://localhost:6389";
  process.env.BETTER_AUTH_SECRET = "x".repeat(32);
}

beforeEach(() => {
  // Derived from the schema, so a variable the runner happens to set (CI's
  // APP_URL, a stray AUTH_RATE_LIMIT_MAX) can never leak into an assertion.
  for (const key of serverEnvKeys) delete process.env[key];
  process.env.NODE_ENV = "test";
  resetEnvCache();
});

afterEach(() => {
  process.env = { ...snapshot };
  resetEnvCache();
});

describe("env", () => {
  it("names every missing variable in one message", () => {
    expect(() => env()).toThrow(
      /DATABASE_URL[\s\S]*REDIS_URL[\s\S]*BETTER_AUTH_SECRET/,
    );
  });

  it("rejects a secret too short to be worth having", () => {
    setBaseline();
    process.env.BETTER_AUTH_SECRET = "short";
    expect(() => env()).toThrow(/at least 32 chars/);
  });

  it("applies defaults for everything optional", () => {
    setBaseline();
    const e = env();
    expect(e.APP_URL).toBe("http://localhost:3200");
    expect(e.STORAGE_DRIVER).toBe("local");
    expect(e.NODE_ENV).toBe("test");
    expect(e.WORKER_CONCURRENCY).toBe(5);
    expect(e.TRUSTED_ORIGINS).toBeUndefined();
  });

  it("parses WORKER_CONCURRENCY as an int and bounds it to 1–50", () => {
    setBaseline();
    process.env.WORKER_CONCURRENCY = "12";
    expect(env().WORKER_CONCURRENCY).toBe(12);
    for (const bad of ["0", "51", "2.5", "lots"]) {
      resetEnvCache();
      process.env.WORKER_CONCURRENCY = bad;
      expect(() => env(), bad).toThrow(/WORKER_CONCURRENCY/);
    }
  });

  it("fails fast when the s3 driver is selected without credentials", () => {
    setBaseline();
    process.env.STORAGE_DRIVER = "s3";
    expect(() => env()).toThrow(
      /S3_BUCKET.*S3_ACCESS_KEY_ID.*S3_SECRET_ACCESS_KEY/,
    );
  });

  it("treats a partially configured Google app as not configured", () => {
    setBaseline();
    process.env.GOOGLE_CLIENT_ID = "id-only";
    expect(googleEnabled()).toBe(false);
  });

  it("treats an absent LLM key as the feature being off, not an error", () => {
    setBaseline();
    expect(llmEnabled()).toBe(false);
    expect(() => env()).not.toThrow();
  });

  it("every schema variable is passed through turbo's strict env mode", () => {
    const turbo = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../../turbo.json"), "utf8"),
    ) as { globalEnv: string[] };
    const missing = serverEnvKeys.filter((k) => !turbo.globalEnv.includes(k));
    expect(missing).toEqual([]);
  });
});
