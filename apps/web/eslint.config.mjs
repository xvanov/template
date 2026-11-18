import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

import { outboundBoundary } from "../../eslint.boundaries.mjs";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // No mail library or ntfy call in the web app: send through @repo/email /
  // @repo/notify (CLAUDE.md rule 8).
  ...outboundBoundary({ mail: "__none__", push: "__none__", sms: "__none__" }),
  // src/components/ui is vendored shadcn/ui: keep it close to upstream so
  // `shadcn add`/diff stay easy. The React Compiler rules (react-hooks v6+)
  // flag upstream patterns there; they stay on for all of OUR code.
  {
    files: ["src/components/ui/**"],
    rules: Object.fromEntries(
      [
        "static-components",
        "use-memo",
        "preserve-manual-memoization",
        "incompatible-library",
        "immutability",
        "globals",
        "refs",
        "set-state-in-effect",
        "set-state-in-render",
        "purity",
        "error-boundaries",
        "unsupported-syntax",
        "config",
        "gating",
      ].map((rule) => [`react-hooks/${rule}`, "off"]),
    ),
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
