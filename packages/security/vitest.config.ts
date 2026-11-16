import { defineConfig } from "vitest/config";

/**
 * unit  `src/**\/*.test.ts`: pure, no I/O
 * int   `test/**\/*.int.test.ts`: the counter script against REAL Redis
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
          setupFiles: ["../../vitest.setup.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "int",
          include: ["test/**/*.int.test.ts"],
          globalSetup: ["./test/redis-global-setup.ts"],
          setupFiles: ["../../vitest.setup.ts", "./test/redis-setup.ts"],
        },
      },
    ],
  },
});
