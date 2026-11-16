import { defineConfig } from "vitest/config";

/**
 * Two projects, one `vitest run`:
 *   unit  `src/**\/*.test.ts`: no database, run anywhere (`npm run test:unit`)
 *   int   `**\/*.int.test.ts`: real Postgres in a throwaway schema, migrated
 *         ONCE per run by packages/db/testing/global-setup.ts
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
          include: ["src/**/*.int.test.ts", "test/**/*.int.test.ts"],
          globalSetup: ["../db/testing/global-setup.ts"],
          setupFiles: ["../../vitest.setup.ts", "../db/testing/setup.ts"],
        },
      },
    ],
  },
});
