/**
 * Bypass prevention for push, like packages/email's wiring test for mail: the
 * guard is only a chokepoint if nothing else can reach ntfy. Reads source
 * files only; milliseconds.
 */
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");
const SKIP = new Set([
  "node_modules",
  "generated",
  ".next",
  ".expo",
  ".turbo",
  "dist",
  ".git",
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    if (SKIP.has(d.name)) return [];
    const path = resolve(dir, d.name);
    if (d.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|mjs|cjs)$/.test(d.name) ? [path] : [];
  });
}

const files = ["apps", "packages"]
  .flatMap((d) => sourceFiles(resolve(ROOT, d)))
  .map((f) => ({ path: relative(ROOT, f), text: readFileSync(f, "utf8") }));

describe("no way around the outbound guard for push", () => {
  it("only notify's guarded entry point (and the transport's own test) imports the ntfy transport", () => {
    const importers = files
      .filter((f) => /from\s+["'][^"']*\/ntfy["']/.test(f.text))
      .map((f) => f.path)
      .sort();
    expect(importers).toEqual([
      "packages/notify/src/index.ts",
      "packages/notify/src/ntfy.test.ts",
    ]);
  });

  it("only the transport reads the ntfy server URL or token", () => {
    const readers = files
      .filter((f) =>
        /\.NTFY_(URL|TOKEN)\b|\[["']NTFY_(URL|TOKEN)["']\]/.test(f.text),
      )
      .map((f) => f.path)
      .filter((p) => !p.endsWith(".test.ts"));
    expect(readers).toEqual(["packages/notify/src/ntfy.ts"]);
  });

  it("the package exports nothing but the guarded entry point", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"),
    );
    expect(pkg.exports).toEqual({ ".": "./src/index.ts" });
  });

  it("the transport's raw functions are not re-exported", () => {
    const index = readFileSync(
      resolve(import.meta.dirname, "index.ts"),
      "utf8",
    );
    expect(index).not.toMatch(/export\s*\{[^}]*transmitPush/);
    expect(index).not.toMatch(/export\s*\*\s*from\s*["']\.\/ntfy["']/);
  });
});
