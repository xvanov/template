import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fault injection: when armed, the next FileHandle.sync() throws, simulating a
// disk error after some bytes were already written.
const fault = vi.hoisted(() => ({ failNextSync: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  const open: typeof fs.open = async (...args) => {
    const handle = await fs.open(...args);
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      if (fault.failNextSync) {
        fault.failNextSync = false;
        throw new Error("injected EIO");
      }
      return sync();
    };
    return handle;
  };
  return { ...fs, default: { ...fs, open }, open };
});

import {
  ALLOWED_CONTENT_TYPES,
  MAX_AUDIO_BYTES,
  MAX_UPLOAD_BYTES,
  assertAudioAllowed,
  assertUploadAllowed,
  buildKey,
  normalizeAudioType,
} from "./index";
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
    expect(() => assertUploadAllowed("image/svg+xml", 10)).toThrow(
      /Unsupported/,
    );
  });

  it("rejects empty and oversized files", () => {
    expect(() => assertUploadAllowed("image/png", 0)).toThrow(/too large/i);
    expect(() =>
      assertUploadAllowed("image/png", MAX_UPLOAD_BYTES + 1),
    ).toThrow(/too large/i);
  });
});

describe("localDriver", () => {
  it("round-trips bytes and reports existence", async () => {
    const driver = localDriver();
    const body = new TextEncoder().encode("hello");
    const { key, sizeBytes } = await driver.put(
      "org/o/2026-01/abc.txt",
      body,
      "text/plain",
    );

    expect(sizeBytes).toBe(5);
    expect(await driver.exists(key)).toBe(true);
    expect(new TextDecoder().decode(await driver.get(key))).toBe("hello");
    expect(await readFile(join(dir, key), "utf8")).toBe("hello");

    await driver.delete(key);
    expect(await driver.exists(key)).toBe(false);
  });

  it("a failed overwrite leaves the old object intact and no temp file", async () => {
    const driver = localDriver();
    const key = "org/o/2026-01/atomic.txt";
    await driver.put(key, new TextEncoder().encode("original"), "text/plain");

    fault.failNextSync = true;
    await expect(
      driver.put(key, new TextEncoder().encode("replacement"), "text/plain"),
    ).rejects.toThrow(/injected EIO/);

    expect(new TextDecoder().decode(await driver.get(key))).toBe("original");
    expect(await readdir(dirname(join(dir, key)))).toEqual(["atomic.txt"]);
  });

  it("refuses a key that escapes the storage root", async () => {
    const driver = localDriver();
    await expect(driver.get("../../../etc/passwd")).rejects.toThrow(
      /outside storage root/,
    );
    await expect(
      driver.put("../escape.txt", new Uint8Array([1]), "text/plain"),
    ).rejects.toThrow(/outside storage root/);
  });

  it("deleting something absent is not an error (idempotent cleanup)", async () => {
    await expect(
      localDriver().delete("org/o/nope.txt"),
    ).resolves.toBeUndefined();
  });
});

describe("audio for transcription", () => {
  it("normalises the aliases phones send, and drops parameters", () => {
    expect(normalizeAudioType("audio/x-m4a")).toBe("audio/mp4");
    expect(normalizeAudioType("Audio/M4A")).toBe("audio/mp4");
    expect(normalizeAudioType("audio/webm;codecs=opus")).toBe("audio/webm");
    expect(normalizeAudioType("audio/mp3")).toBe("audio/mpeg");
  });

  it("accepts speech formats under the size cap, nothing else", () => {
    expect(() => assertAudioAllowed("audio/x-m4a", 1000)).not.toThrow();
    expect(() => assertAudioAllowed("video/mp4", 1000)).toThrow(
      "Unsupported audio type",
    );
    expect(() => assertAudioAllowed("text/html", 1000)).toThrow();
    expect(() => assertAudioAllowed("audio/mp4", MAX_AUDIO_BYTES + 1)).toThrow(
      "too large",
    );
    expect(() => assertAudioAllowed("audio/mp4", 0)).toThrow();
  });
});
