import path from "node:path";

import { config as loadEnv } from "dotenv";
import { defineConfig } from "prisma/config";

// The .env lives at the monorepo root, but Prisma runs with cwd=packages/db.
loadEnv({ path: path.resolve(import.meta.dirname, "../../.env"), quiet: true });

/**
 * `prisma generate` does not connect to anything, but the config must still
 * resolve a URL — so an unset DATABASE_URL falls back to an obviously-bogus
 * placeholder instead of failing the install. Commands that DO connect
 * (`migrate`, `studio`) then fail loudly on the placeholder, which is the
 * behaviour you want.
 */
const url =
  process.env.DATABASE_URL ?? "postgresql://unset:unset@127.0.0.1:1/unset";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: { url },
});
