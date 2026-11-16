/**
 * Bypass prevention: the outbound guard is only a chokepoint if there is no
 * way around it. These checks read source files (no I/O beyond the disk), so
 * they cost milliseconds and run with every unit test.
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
const THE_TRANSPORT = "packages/email/src/transport.ts";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    if (SKIP.has(d.name)) return [];
    const path = resolve(dir, d.name);
    if (d.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|mjs|cjs)$/.test(d.name) ? [path] : [];
  });
}

const files = ["apps", "packages"].flatMap((d) =>
  sourceFiles(resolve(ROOT, d)),
);

describe("no way around the outbound guard", () => {
  it("only the email transport imports a mail library", () => {
    const offenders = files
      .filter((f) =>
        /from\s+["'](nodemailer|@sendgrid\/|resend|postmark|mailgun|twilio)/.test(
          readFileSync(f, "utf8"),
        ),
      )
      .map((f) => relative(ROOT, f))
      .filter((f) => f !== THE_TRANSPORT);
    expect(offenders).toEqual([]);
  });

  it("only @repo/email's guarded entry point imports the transport", () => {
    const importers = files
      .filter((f) =>
        /from\s+["'][^"']*\/transport["']/.test(readFileSync(f, "utf8")),
      )
      .map((f) => relative(ROOT, f));
    expect(importers).toEqual(["packages/email/src/index.ts"]);
  });

  it("the package exports nothing but the guarded entry point", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"),
    );
    expect(pkg.exports).toEqual({ ".": "./src/index.ts" });
  });

  it("no other workspace depends on a mail library directly", () => {
    const manifests = ["apps", "packages"].flatMap((d) =>
      readdirSync(resolve(ROOT, d)).map((p) =>
        resolve(ROOT, d, p, "package.json"),
      ),
    );
    const offenders = manifests.filter((m) => {
      if (m.endsWith("packages/email/package.json")) return false;
      try {
        const pkg = JSON.parse(readFileSync(m, "utf8"));
        return "nodemailer" in { ...pkg.dependencies, ...pkg.devDependencies };
      } catch {
        return false;
      }
    });
    expect(offenders.map((m) => relative(ROOT, m))).toEqual([]);
  });
});
