import { defineConfig } from "vitest/config";

/**
 * unit  `src/**\/*.test.ts`: the gate logic, pure, no I/O
 * int   `src/**\/*.int.test.ts`: the guard against real Postgres (the log row
 *       is the product), in a throwaway schema; counters use the in-memory store
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
