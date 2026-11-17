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

  it("defaults display formatting to en-US · USD · UTC and validates overrides", () => {
    setBaseline();
    expect(env()).toMatchObject({
      APP_LOCALE: "en-US",
      APP_CURRENCY: "USD",
      APP_TIMEZONE: "UTC",
    });

    resetEnvCache();
    process.env.APP_LOCALE = "de-DE";
    process.env.APP_CURRENCY = "EUR";
    process.env.APP_TIMEZONE = "Europe/Berlin";
    expect(env()).toMatchObject({
      APP_LOCALE: "de-DE",
      APP_CURRENCY: "EUR",
      APP_TIMEZONE: "Europe/Berlin",
    });

    resetEnvCache();
    process.env.APP_CURRENCY = "euro";
    process.env.APP_TIMEZONE = "Mars/Olympus";
    expect(() => env()).toThrow(/APP_CURRENCY[\s\S]*APP_TIMEZONE/);
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

  it("reads a blank OUTBOUND_SAFE_MODE= as unset (the default), never as false", () => {
    setBaseline();
    process.env.OUTBOUND_SAFE_MODE = "";
    process.env.SECRETS_ENCRYPTION_KEY = "";
    expect(env().OUTBOUND_SAFE_MODE).toBeUndefined();
    expect(env().SECRETS_ENCRYPTION_KEY).toBeUndefined();
  });

  it("reads OUTBOUND_SAFE_MODE=local as the literal, not as false", () => {
    setBaseline();
    process.env.OUTBOUND_SAFE_MODE = "local";
    expect(env().OUTBOUND_SAFE_MODE).toBe("local");
  });

  it("rejects an encryption key that is not 32 bytes", () => {
    setBaseline();
    process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(16).toString("base64");
    expect(() => env()).toThrow(/SECRETS_ENCRYPTION_KEY/);
  });

  it("reads booleans strictly: true/1/false/0, blank = default, anything else fails", () => {
    setBaseline();
    expect(env()).toMatchObject({
      REQUIRE_EMAIL_VERIFICATION: true,
      SMTP_SECURE: false,
    });
    for (const [raw, want] of [
      ["true", true],
      ["1", true],
      [" TRUE ", true],
      ["false", false],
      ["0", false],
      ["", true],
    ] as const) {
      resetEnvCache();
      process.env.REQUIRE_EMAIL_VERIFICATION = raw;
      expect(env().REQUIRE_EMAIL_VERIFICATION, raw).toBe(want);
    }
    // The loose parser this replaced read "yes" as false — switching email
    // verification OFF. A typo must fail loudly instead.
    for (const bad of ["yes", "on", "no", "ture"]) {
      resetEnvCache();
      process.env.REQUIRE_EMAIL_VERIFICATION = bad;
      expect(() => env(), bad).toThrow(
        `REQUIRE_EMAIL_VERIFICATION: must be "true"/"1" or "false"/"0" (got "${bad}")`,
      );
    }
    resetEnvCache();
    process.env.REQUIRE_EMAIL_VERIFICATION = "true";
    process.env.OUTBOUND_SAFE_MODE = "yes";
    expect(() => env()).toThrow(
      'OUTBOUND_SAFE_MODE: must be "local", "true"/"1" or "false"/"0" (got "yes")',
    );
  });

  it("treats a blank optional URL as unset, and still validates a real one", () => {
    setBaseline();
    process.env.BETTER_AUTH_URL = "";
    process.env.DEV_MAIL_INBOX_URL = "";
    process.env.S3_ENDPOINT = "";
    expect(env()).toMatchObject({
      BETTER_AUTH_URL: undefined,
      DEV_MAIL_INBOX_URL: undefined,
      S3_ENDPOINT: undefined,
    });
    resetEnvCache();
    process.env.S3_ENDPOINT = "not a url";
    expect(() => env()).toThrow(/S3_ENDPOINT/);
  });

  it("treats APP_VERSION as optional, blank = unset", () => {
    setBaseline();
    process.env.APP_VERSION = "";
    expect(env().APP_VERSION).toBeUndefined();
    resetEnvCache();
    process.env.APP_VERSION = "abc1234";
    expect(env().APP_VERSION).toBe("abc1234");
  });

  it("every schema variable is passed through turbo's strict env mode", () => {
    const turbo = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../../turbo.json"), "utf8"),
    ) as { globalEnv: string[] };
    const missing = serverEnvKeys.filter((k) => !turbo.globalEnv.includes(k));
    expect(missing).toEqual([]);
  });
});
