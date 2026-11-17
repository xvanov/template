import { afterEach, describe, expect, it } from "vitest";
import { db } from "@repo/db";
import { resetEnvCache } from "@repo/env";

import { createCallerFactory } from "../trpc";
import { healthRouter } from "./health";

const caller = () =>
  createCallerFactory(healthRouter)({
    db,
    session: null,
    headers: new Headers(),
  });

afterEach(() => {
  delete process.env.APP_VERSION;
  resetEnvCache();
});

describe("health.live", () => {
  it("reports APP_VERSION when it is set", async () => {
    process.env.APP_VERSION = "abc1234";
    await expect(caller().live()).resolves.toEqual({
      ok: true,
      version: "abc1234",
    });
  });

  it("falls back to the root package.json version", async () => {
    const { version } = await caller().live();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
