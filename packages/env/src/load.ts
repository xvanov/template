/**
 * Side-effect module: load the monorepo-root `.env` into `process.env`.
 *
 *   import "@repo/env/load";   // MUST be the first import in the entrypoint
 *
 * Why this exists: `import "dotenv/config"` reads `.env` from the *process cwd*,
 * and every entrypoint has a different cwd (apps/worker when started by npm,
 * /app in the container, packages/db when Prisma runs). Rather than each one
 * guessing a relative path, search upward for the first `.env` and load that.
 *
 * A missing file is not an error: in containers and CI the variables come from
 * the environment itself, and `@repo/env` will report anything actually absent.
 *
 * Deliberately a SEPARATE entrypoint from `@repo/env` so that Next.js — which
 * loads .env itself and must not bundle `dotenv` — never pulls this in.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { config } from "dotenv";

const MAX_LEVELS = 6;

function findEnvFile(): string | undefined {
  const starts = [process.cwd(), import.meta.dirname];
  for (const start of starts) {
    let dir = start;
    for (let i = 0; i <= MAX_LEVELS; i++) {
      const candidate = resolve(dir, ".env");
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

const envFile = findEnvFile();
if (envFile) {
  config({ path: envFile, quiet: true });
}

export const loadedEnvFile = envFile;
