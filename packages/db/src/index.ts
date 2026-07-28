/**
 * The Prisma client singleton.
 *
 * Constructed LAZILY, on first property access. That matters for more than
 * startup time: `next build` walks the module graph, so an eagerly-constructed
 * client would make a *build* require a valid DATABASE_URL — and an image that
 * needs production secrets to compile cannot be built once and run in several
 * environments.
 *
 * The instance is stashed on `globalThis` so Next.js hot-reload does not open a
 * new connection pool on every edit (the classic dev "too many connections").
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "@repo/env";

import { PrismaClient } from "../generated/client";

const globalForDb = globalThis as unknown as { __db?: PrismaClient };

function createClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: env().DATABASE_URL });
  const client = new PrismaClient({
    adapter,
    log: env().NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
  if (env().NODE_ENV !== "production") globalForDb.__db = client;
  return client;
}

function instance(): PrismaClient {
  return (globalForDb.__db ??= createClient());
}

export const db: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    const client = instance();
    return Reflect.get(client, prop, receiver === undefined ? client : client);
  },
  has(_target, prop) {
    return prop in instance();
  },
});

export * from "../generated/client";
export type { PrismaClient };
