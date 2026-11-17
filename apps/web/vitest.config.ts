import path from "node:path";

import { defineConfig } from "vitest/config";

/**
 * Two projects, one `vitest run`:
 *   unit  `src/**\/*.test.ts`: no database
 *   int   `**\/*.int.test.ts`: real Postgres in a throwaway schema (the same
 *         harness as packages/api — see packages/db/testing/global-setup.ts)
 */
export default defineConfig({
  // tsconfig says jsx: "preserve" (Next compiles JSX itself); tests that import
  // a .tsx module need it compiled here instead.
  oxc: { jsx: { runtime: "automatic" } },
  // Mirror tsconfig's "@/*" path alias.
  resolve: { alias: { "@": path.join(import.meta.dirname, "src") } },
  test: {
    environment: "node",
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
          // `e2e/` belongs to Playwright. Without this exclusion vitest
          // collects the spec files, fails to resolve @playwright/test's
          // runner, and reports a failure that has nothing to do with the code.
          exclude: ["**/node_modules/**", "e2e/**", "**/*.int.test.ts"],
          setupFiles: ["../../vitest.setup.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "int",
          include: ["src/**/*.int.test.ts"],
          globalSetup: ["../../packages/db/testing/global-setup.ts"],
          setupFiles: [
            "../../vitest.setup.ts",
            "../../packages/db/testing/setup.ts",
          ],
        },
      },
    ],
  },
});
