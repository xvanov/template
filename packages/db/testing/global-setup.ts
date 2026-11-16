/**
 * Vitest globalSetup for tests that need a REAL Postgres.
 *
 * Tenant isolation is a property of SQL `where` clauses, so it is tested
 * against the real database, not a mock that would agree with any query.
 *
 * Once per `vitest run`: create a throwaway schema `vt_<unix>_<random>` in the
 * database named by TEST_DATABASE_URL (else DATABASE_URL in the root .env),
 * apply every migration into it, run the tests, drop it. `public` (your dev
 * data) is never read or written.
 *
 * Migrations are applied as raw SQL over one connection (~40 ms) rather than
 * via `prisma migrate deploy` (~700 ms: a CLI process plus its engine). Like
 * Prisma, each migration.sql is ONE query, in order, so a later migration can
 * use an enum value an earlier one added (`ALTER TYPE ... ADD VALUE` cannot be
 * used in the transaction that added it). That works because Prisma's
 * generated migrations use unqualified names, which resolve through
 * `search_path` = the new schema first, then `public`. Rules that follow:
 *   - Do not hand-write `"public".` into a migration: it would escape the
 *     throwaway schema and touch dev data.
 *   - Extensions (pgvector, citext...) are per-DATABASE and usually live in
 *     `public`; `public` is on the path so their types and functions resolve.
 *     Install them in the dev/CI database once (`CREATE EXTENSION IF NOT
 *     EXISTS` in a migration is a no-op if already there). An extension that is
 *     NOT yet installed would be created inside the throwaway schema and
 *     dropped with it, so the next run reinstalls it: correct, just slower.
 *   - `CREATE INDEX CONCURRENTLY` cannot run inside a multi-statement query;
 *     give it a migration.sql of its own.
 *
 * Postgres down = the run FAILS with instructions. It never skips: a skipped
 * isolation test looks exactly like a passing one.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse } from "dotenv";
import pg from "pg";
import type { TestProject } from "vitest/node";

const DB_PACKAGE = resolve(import.meta.dirname, "..");
const MIGRATIONS = resolve(DB_PACKAGE, "prisma/migrations");
const ROOT_ENV = resolve(DB_PACKAGE, "../../.env");
/** Schemas left behind by a killed run are swept once they are this old. */
const STALE_AFTER_SECONDS = 3600;

function baseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  if (existsSync(ROOT_ENV)) {
    const fromFile = parse(readFileSync(ROOT_ENV)).DATABASE_URL;
    if (fromFile) return fromFile;
  }
  return "postgresql://postgres:postgres@localhost:5442/app"; // .env.example
}

/** Each migration's SQL, in apply order (names are timestamp-prefixed). */
function migrations(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(resolve(MIGRATIONS, name, "migration.sql"), "utf8"),
    }));
}

export default async function setup(project: TestProject) {
  const base = new URL(baseUrl());
  base.searchParams.delete("schema");

  const now = Math.floor(Date.now() / 1000);
  const schema = `vt_${now}_${randomBytes(4).toString("hex")}`;

  const admin = new pg.Client({
    connectionString: base.toString(),
    connectionTimeoutMillis: 3000,
  });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      [
        "",
        `Integration tests (*.int.test.ts) need Postgres, and it is not reachable at ${redact(base)}`,
        `  (${err instanceof Error ? err.message : String(err)})`,
        "",
        "  Start it:  make up        (docker compose: postgres on :5442)",
        "  Or point TEST_DATABASE_URL at a disposable database.",
        "",
      ].join("\n"),
    );
  }

  let current = "setup";
  try {
    await sweepStaleSchemas(admin, now);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}", public`);
    for (const m of migrations()) {
      current = `migration ${m.name}`;
      await admin.query(m.sql);
    }
    await admin.query("RESET search_path");
  } catch (err) {
    // Leave nothing behind, and do not hold the process open.
    await admin
      .query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      .catch(() => {});
    await admin.end().catch(() => {});
    throw new Error(
      `Test schema ${current} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const url = new URL(base);
  url.searchParams.set("schema", schema);
  project.provide("databaseUrl", url.toString());

  return async () => {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  };
}

/** A run killed mid-flight cannot drop its schema; the next run does it. */
async function sweepStaleSchemas(admin: pg.Client, now: number) {
  const { rows } = await admin.query<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace WHERE nspname ~ '^vt_[0-9]+_[0-9a-f]+$'`,
  );
  for (const { nspname } of rows) {
    const created = Number(nspname.split("_")[1]);
    if (now - created > STALE_AFTER_SECONDS) {
      await admin.query(`DROP SCHEMA IF EXISTS "${nspname}" CASCADE`);
    }
  }
}

function redact(url: URL): string {
  const copy = new URL(url);
  if (copy.password) copy.password = "***";
  return copy.toString();
}

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}
