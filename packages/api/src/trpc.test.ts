import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@repo/db";
import { resetTestRateLimits } from "@repo/security";

import {
  createCallerFactory,
  createTRPCRouter,
  publicProcedure,
  rateLimited,
} from "./trpc";

const router = createTRPCRouter({
  ping: publicProcedure
    .use(rateLimited({ limit: 2, windowSeconds: 60 }))
    .query(() => "pong"),
});
const callerFrom = (ip: string) =>
  createCallerFactory(router)({
    db,
    session: null,
    headers: new Headers({ "x-forwarded-for": `${ip}, 10.0.0.1` }),
  });

beforeEach(() => resetTestRateLimits());

describe("rateLimited", () => {
  it("throttles one caller after the limit, without affecting another", async () => {
    const a = callerFrom("203.0.113.1");
    await a.ping();
    await a.ping();
    await expect(a.ping()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    await expect(callerFrom("203.0.113.2").ping()).resolves.toBe("pong");
  });
});
