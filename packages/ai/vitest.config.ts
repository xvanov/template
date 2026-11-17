import { defineConfig } from "vitest/config";

/**
 * Two projects, one `vitest run`:
 *   unit  `src/**\/*.test.ts`: no database, no network
 *   int   `src/**\/*.int.test.ts`: real Postgres in a throwaway schema (the
 *         spend cap's advisory lock is a property of the database, so it is
 *         tested against one), migrated once by packages/db/testing
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
          include: ["src/**/*.int.test.ts"],
          globalSetup: ["../db/testing/global-setup.ts"],
          setupFiles: ["../../vitest.setup.ts", "../db/testing/setup.ts"],
        },
      },
    ],
  },
});
