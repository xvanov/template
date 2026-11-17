import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  // tsconfig says jsx: "preserve" (Next compiles JSX itself); tests that import
  // a .tsx module need it compiled here instead.
  oxc: { jsx: { runtime: "automatic" } },
  // Mirror tsconfig's "@/*" path alias.
  resolve: { alias: { "@": path.join(import.meta.dirname, "src") } },
  test: {
    environment: "node",
    setupFiles: ["../../vitest.setup.ts"],
    // `e2e/` belongs to Playwright. Without this exclusion vitest collects the
    // spec files, fails to resolve @playwright/test's runner, and reports a
    // failure that has nothing to do with the code.
    exclude: ["**/node_modules/**", "e2e/**"],
  },
});
