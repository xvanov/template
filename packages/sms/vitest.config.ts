import { defineConfig } from "vitest/config";

/**
 * unit  `src/**\/*.test.ts`: keywords, signatures, the Twilio request (faked), wiring; no I/O
 * int   `src/**\/*.int.test.ts`: sendSms through the real guard, real Postgres
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
