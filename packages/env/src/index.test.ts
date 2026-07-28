import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { env, googleEnabled, llmEnabled, resetEnvCache } from "./index";

const snapshot = { ...process.env };

function setBaseline() {
  process.env.DATABASE_URL = "postgresql://u:p@localhost:5442/app";
  process.env.REDIS_URL = "redis://localhost:6389";
  process.env.BETTER_AUTH_SECRET = "x".repeat(32);
}

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (
      /^(DATABASE_URL|REDIS_URL|BETTER_AUTH_|GOOGLE_|LLM_|S3_|STORAGE_)/.test(
        key,
      )
    ) {
      delete process.env[key];
    }
  }
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
});
