import { defineConfig } from "vitest/config";

/**
 * Two projects, one `vitest run`:
 *   unit  `src/**\/*.test.ts`: chunker, fusion, query building — no I/O
 *   int   `test/**\/*.int.test.ts`: ingest + search against real Postgres
 *         with pgvector, in the throwaway schema (packages/db/testing)
 */
export default defineConfig({
  test: {
    environment: "node",
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: ["**/*.int.test.ts"],
          setupFiles: ["../../vitest.setup.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "int",
          include: ["test/**/*.int.test.ts"],
          globalSetup: ["../db/testing/global-setup.ts"],
          setupFiles: ["../../vitest.setup.ts", "../db/testing/setup.ts"],
        },
      },
    ],
  },
});
