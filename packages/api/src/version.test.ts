import { describe, it, expect, vi, beforeEach } from "vitest";
import { resetVersionCache, resolveVersion } from "./version";

vi.mock("@repo/env", () => ({
  env: vi.fn(),
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

import { env } from "@repo/env";
import { readFileSync } from "node:fs";

const mockedEnv = env as ReturnType<typeof vi.fn>;
const mockedReadFileSync = readFileSync as ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetVersionCache();
  vi.clearAllMocks();
});

describe("resolveVersion", () => {
  it("returns APP_VERSION when env var is set", () => {
    mockedEnv.mockReturnValue({ APP_VERSION: "2.0.0" });

    expect(resolveVersion()).toBe("2.0.0");
    // memoised — second call does not re-read env
    expect(resolveVersion()).toBe("2.0.0");
    expect(mockedEnv).toHaveBeenCalledTimes(1);
  });

  it("falls back to package.json version when APP_VERSION is absent", () => {
    mockedEnv.mockReturnValue({ APP_VERSION: undefined });
    // Simulate a root package.json with a version field
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        workspaces: ["apps/*", "packages/*"],
        version: "3.4.5",
      }),
    );

    expect(resolveVersion()).toBe("3.4.5");
  });

  it("returns 'unknown' when both APP_VERSION and package.json version are absent", () => {
    mockedEnv.mockReturnValue({ APP_VERSION: undefined });
    // Simulate a root package.json with no version field
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ workspaces: ["apps/*", "packages/*"] }),
    );

    expect(resolveVersion()).toBe("unknown");
  });
});
