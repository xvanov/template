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
  // The driver adapter ignores `?schema=` in the URL, so pass it explicitly.
  // Without this, tests aimed at a throwaway schema would hit `public`.
  const url = env().DATABASE_URL;
  const schema = schemaOf(url);
  const adapter = new PrismaPg(
    {
      connectionString: url,
      // Prisma's own queries are schema-qualified, but raw SQL
      // ($queryRaw, packages/rag) resolves names through search_path. Pin it
      // to the same schema, then `public`, where extensions such as pgvector
      // live (their types and operators must resolve too).
      ...(schema ? { options: `-c search_path=${searchPath(schema)}` } : {}),
    },
    schema ? { schema } : undefined,
  );
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

/**
 * `"<schema>",public` for the connection's startup `options`. Quoted, so a
 * mixed-case schema keeps its case; names that would need escaping there
 * (whitespace, quotes, backslashes, commas) are refused.
 */
export function searchPath(schema: string): string {
  if (!/^[^\s"\\,]+$/.test(schema)) {
    throw new Error(`Unsupported schema name in DATABASE_URL: ${schema}`);
  }
  return schema === "public" ? "public" : `"${schema}",public`;
}

function schemaOf(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get("schema") ?? undefined;
  } catch {
    return undefined;
  }
}

export * from "../generated/client";
export type { PrismaClient };
export {
  recordAudit,
  type AuditActorType,
  type AuditInput,
  type AuditWriter,
} from "./audit";
