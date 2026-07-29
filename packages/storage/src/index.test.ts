import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ALLOWED_CONTENT_TYPES, MAX_UPLOAD_BYTES, assertUploadAllowed, buildKey } from "./index";
import { localDriver } from "./local";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "storage-test-"));
  process.env.STORAGE_DRIVER = "local";
  process.env.STORAGE_LOCAL_DIR = dir;
  // env() memoises; force a fresh read for this temp directory.
  const { resetEnvCache } = await import("@repo/env");
  resetEnvCache();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("buildKey", () => {
  it("namespaces by tenant so a tenant's objects are one prefix", () => {
    const key = buildKey("org_123", "photo.JPG");
    expect(key.startsWith("org/org_123/")).toBe(true);
    expect(key.endsWith(".jpg")).toBe(true);
  });

  it("drops an extension it cannot vouch for rather than echoing it", () => {
    expect(buildKey("o", "evil.php.")).not.toContain("php");
    expect(buildKey("o", "no-extension")).toMatch(/[A-Za-z0-9_-]{16}$/);
  });

  it("never lets a filename steer the key out of its prefix", () => {
    expect(buildKey("o", "../../../etc/passwd")).toMatch(/^org\/o\//);
  });
});

describe("assertUploadAllowed", () => {
  it("accepts the allow-listed types", () => {
    for (const type of ALLOWED_CONTENT_TYPES) {
      expect(() => assertUploadAllowed(type, 1024)).not.toThrow();
    }
  });

  it("rejects types that would be stored XSS if served from our origin", () => {
    expect(() => assertUploadAllowed("text/html", 10)).toThrow(/Unsupported/);
    expect(() => assertUploadAllowed("image/svg+xml", 10)).toThrow(/Unsupported/);
  });

  it("rejects empty and oversized files", () => {
    expect(() => assertUploadAllowed("image/png", 0)).toThrow(/too large/i);
    expect(() => assertUploadAllowed("image/png", MAX_UPLOAD_BYTES + 1)).toThrow(/too large/i);
  });
});

describe("localDriver", () => {
  it("round-trips bytes and reports existence", async () => {
    const driver = localDriver();
    const body = new TextEncoder().encode("hello");
    const { key, sizeBytes } = await driver.put("org/o/2026-01/abc.txt", body, "text/plain");

    expect(sizeBytes).toBe(5);
    expect(await driver.exists(key)).toBe(true);
    expect(new TextDecoder().decode(await driver.get(key))).toBe("hello");
    expect(await readFile(join(dir, key), "utf8")).toBe("hello");

    await driver.delete(key);
    expect(await driver.exists(key)).toBe(false);
  });

  it("refuses a key that escapes the storage root", async () => {
    const driver = localDriver();
    await expect(driver.get("../../../etc/passwd")).rejects.toThrow(/outside storage root/);
    await expect(
      driver.put("../escape.txt", new Uint8Array([1]), "text/plain"),
    ).rejects.toThrow(/outside storage root/);
  });

  it("deleting something absent is not an error (idempotent cleanup)", async () => {
    await expect(localDriver().delete("org/o/nope.txt")).resolves.toBeUndefined();
  });
});
