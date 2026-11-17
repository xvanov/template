import { defineConfig } from "vitest/config";

/**
 * Unit tests only: the loop against a scripted fake model, no I/O. Runs,
 * traces, proposals and isolation are tested against real Postgres through
 * the API, in packages/api/test/agent.int.test.ts.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["../../vitest.setup.ts"],
  },
});
