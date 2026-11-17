import { afterEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "@repo/env";

import { packageVersion, resolveVersion } from "./version";

afterEach(() => {
  delete process.env.APP_VERSION;
  resetEnvCache();
});

describe("resolveVersion", () => {
  it("prefers APP_VERSION", () => {
    process.env.APP_VERSION = "abc1234";
    expect(resolveVersion()).toBe("abc1234");
  });

  it("falls back to the root package.json version", () => {
    expect(resolveVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("treats a missing or blank package version as absent", () => {
    expect(packageVersion({})).toBeNull();
    expect(packageVersion({ version: "" })).toBeNull();
    expect(packageVersion({ version: "1.2.3" })).toBe("1.2.3");
  });
});
