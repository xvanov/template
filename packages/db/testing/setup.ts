/**
 * Per-worker setup for database-backed tests: point `@repo/db` at the
 * throwaway schema made by `global-setup.ts`. The client is lazy, so setting
 * the URL before any test touches `db` is early enough.
 */
import { afterAll, inject } from "vitest";

import { db } from "../src/index";

process.env.DATABASE_URL = inject("databaseUrl");

afterAll(async () => {
  await db.$disconnect();
});
