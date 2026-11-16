/**
 * ESLint for the shared packages and the worker: import boundaries only (see
 * eslint.boundaries.mjs). Type-level correctness is `make typecheck`'s job.
 * apps/web and apps/mobile have their own configs; web includes the same
 * boundary rules.
 */
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

import { mailBoundary } from "./eslint.boundaries.mjs";

export default defineConfig([
  globalIgnores([
    "**/node_modules/**",
    "**/generated/**",
    "**/.next/**",
    "**/.expo/**",
    "**/dist/**",
    "**/.turbo/**",
  ]),
  {
    files: ["**/*.{ts,tsx,js,mjs,cjs,jsx}"],
    languageOptions: { parser: tseslint.parser },
    linterOptions: { reportUnusedDisableDirectives: "error" },
  },
  ...mailBoundary("packages/email/src/transport.ts"),
]);
