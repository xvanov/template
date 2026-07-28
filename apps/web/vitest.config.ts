import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["../../vitest.setup.ts"],
    // `e2e/` belongs to Playwright. Without this exclusion vitest collects the
    // spec files, fails to resolve @playwright/test's runner, and reports a
    // failure that has nothing to do with the code.
    exclude: ["**/node_modules/**", "e2e/**"],
  },
});
