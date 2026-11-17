import { afterEach, describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { db, Prisma } from "@repo/db";
import { resetEnvCache } from "@repo/env";

import {
  ConflictError,
  DomainRuleError,
  ForbiddenError,
  NotFoundError,
} from "./errors";
import { createTRPCRouter, publicProcedure } from "./trpc";

class Leaky extends Error {}

const router = createTRPCRouter({
  notFound: publicProcedure.query(() => {
    throw new NotFoundError("Item not found.");
  }),
  rule: publicProcedure.query(() => {
    throw new DomainRuleError("Pick a date in the future.");
  }),
  conflict: publicProcedure.query(() => {
    throw new ConflictError("That name is taken.");
  }),
  forbidden: publicProcedure.query(() => {
    throw new ForbiddenError("Admins only.");
  }),
  // Same name, declared elsewhere: still mapped (matching is by name).
  foreignNotFound: publicProcedure.query(() => {
    const e = new Error("Gone.");
    e.name = "NotFoundError";
    throw e;
  }),
  // A resolver that chose its own code keeps it, whatever the cause.
  deliberate: publicProcedure.query(() => {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Chosen on purpose.",
      cause: new NotFoundError("Item not found."),
    });
  }),
  duplicate: publicProcedure.query(() => {
    throw new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed on the fields: (`secret_column`)",
      { code: "P2002", clientVersion: "test" },
    );
  }),
  crash: publicProcedure.query(() => {
    throw new Leaky('relation "secret_table" does not exist at /srv/app.ts');
  }),
});

/** Through the real HTTP adapter, so the errorFormatter output is what we see. */
async function call(path: string) {
  const res = await fetchRequestHandler({
    endpoint: "/api/trpc",
    req: new Request(`http://localhost/api/trpc/${path}`),
    router,
    createContext: () => ({ db, session: null, headers: new Headers() }),
  });
  const body = (await res.json()) as {
    error: { json: { message: string; data: Record<string, unknown> } };
  };
  return { status: res.status, ...body.error.json };
}

function asProduction() {
  process.env.NODE_ENV = "production";
  resetEnvCache();
}

const original = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = original;
  resetEnvCache();
});

describe("domain errors → tRPC codes", () => {
  it.each([
    ["notFound", 404, "NOT_FOUND", "Item not found."],
    ["rule", 400, "BAD_REQUEST", "Pick a date in the future."],
    ["conflict", 409, "CONFLICT", "That name is taken."],
    ["forbidden", 403, "FORBIDDEN", "Admins only."],
    ["foreignNotFound", 404, "NOT_FOUND", "Gone."],
  ])("%s → %s %s with its message", async (path, status, code, message) => {
    asProduction(); // typed errors keep their message even in production
    const r = await call(path);
    expect(r).toMatchObject({ status, message, data: { code } });
  });

  it("a deliberately thrown TRPCError is not remapped from its cause", async () => {
    const r = await call("deliberate");
    expect(r).toMatchObject({
      status: 500,
      message: "Chosen on purpose.",
      data: { code: "INTERNAL_SERVER_ERROR" },
    });
  });

  it("a unique-constraint violation is a 409 with a generic message", async () => {
    asProduction();
    const r = await call("duplicate");
    expect(r).toMatchObject({
      status: 409,
      message: "That already exists.",
      data: { code: "CONFLICT" },
    });
    expect(JSON.stringify(r)).not.toMatch(/secret_column/);
  });

  it("an unknown error is an opaque 500 in production: no message, no stack", async () => {
    asProduction();
    const r = await call("crash");
    expect(r.status).toBe(500);
    expect(r.data.code).toBe("INTERNAL_SERVER_ERROR");
    expect(r.message).toBe("Something went wrong on our side.");
    expect(r.data).not.toHaveProperty("stack");
    expect(JSON.stringify(r)).not.toMatch(/secret_table|\/srv\//);
  });

  it("outside production the real message is shown, to help debugging", async () => {
    process.env.NODE_ENV = "development";
    resetEnvCache();
    const r = await call("crash");
    expect(r.status).toBe(500);
    expect(r.message).toMatch(/secret_table/);
  });
});
