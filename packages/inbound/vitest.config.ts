import { defineConfig } from "vitest/config";

/**
 * unit  `src/**\/*.test.ts`: text helpers; no I/O
 * int   `test/**\/*.int.test.ts`: routing, dedupe, processing, STOP, org
 *       isolation against real Postgres (providers faked, storage on disk)
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
