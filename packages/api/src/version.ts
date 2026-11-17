/**
 * What build is running, for the health check.
 *
 * Priority: APP_VERSION env var (scripts/deploy.sh sets it to the git commit)
 * → root package.json `version` → "unknown". Resolved once per process.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { env } from "@repo/env";

const MAX_LEVELS = 6;

function findRootPkgJson(): string | undefined {
  // Try both process.cwd() and import.meta.dirname as starting points —
  // import.meta.dirname is undefined when this module is bundled by Next.js.
  // Precedent: packages/env/src/load.ts does the same fallback.
  const starts: string[] = [process.cwd()];
  if (import.meta.dirname) starts.push(import.meta.dirname);

  for (const start of starts) {
    let dir = start;
    for (let i = 0; i <= MAX_LEVELS; i++) {
      const candidate = resolve(dir, "package.json");
      try {
        const raw = readFileSync(candidate, "utf-8");
        const pkg = JSON.parse(raw);
        if (pkg.workspaces) return candidate;
      } catch {
        // file missing or unparseable — keep walking
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

let _cachedVersion: string | undefined;

export function resolveVersion(): string {
  if (_cachedVersion !== undefined) return _cachedVersion;

  try {
    const fromEnv = env().APP_VERSION;
    if (fromEnv) {
      _cachedVersion = fromEnv;
      return fromEnv;
    }

    const rootPkg = findRootPkgJson();
    if (rootPkg) {
      try {
        const pkg = JSON.parse(readFileSync(rootPkg, "utf-8")) as {
          version?: unknown;
        };
        if (typeof pkg.version === "string" && pkg.version.length > 0) {
          _cachedVersion = pkg.version;
          return pkg.version;
        }
      } catch {
        // corrupt package.json — fall through
      }
    }
  } catch {
    // env() or fs may throw in extreme edge cases — fall through to "unknown"
  }

  _cachedVersion = "unknown";
  return "unknown";
}

/** Test-only: drop the memoised value so a test can re-resolve. */
export function resetVersionCache(): void {
  _cachedVersion = undefined;
}
