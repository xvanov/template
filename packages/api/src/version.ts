/**
 * What build is running, for the health check: APP_VERSION (a deploy sets
 * it to the deployed git commit), else the root package.json `version`,
 * else "unknown".
 *
 * The package.json is a static import, so the bundler (Next) or tsx reads it
 * at build/load time: no filesystem lookup at runtime, and no dependence on
 * the process's cwd or on the file existing inside a standalone image.
 */
import rootPackage from "../../../package.json" with { type: "json" };
import { env } from "@repo/env";

export function resolveVersion(): string {
  return env().APP_VERSION ?? packageVersion(rootPackage) ?? "unknown";
}

export function packageVersion(pkg: { version?: unknown }): string | null {
  return typeof pkg.version === "string" && pkg.version ? pkg.version : null;
}
