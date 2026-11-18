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
const MAIL_TRANSPORT = "packages/email/src/transport.ts";
const SMS_TRANSPORT = "packages/sms/src/transport.ts"; // @module:sms
const MOBILE_PUSH_TRANSPORT = "packages/push-mobile/src/transport.ts"; // @module:push-mobile

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
  it("the ESLint boundary rule is wired into the root and web configs", () => {
    // The rule itself lives in eslint.boundaries.mjs and fails `make lint`;
    // this only stops someone quietly unhooking it.
    const root = readFileSync(resolve(ROOT, "eslint.config.mjs"), "utf8");
    const web = readFileSync(
      resolve(ROOT, "apps/web/eslint.config.mjs"),
      "utf8",
    );
    expect(root).toContain('mail: "packages/email/src/transport.ts"');
    expect(root).toContain('push: "packages/notify/src/ntfy.ts"');
    // @module:sms
    expect(root).toContain('sms: "packages/sms/src/transport.ts"');
    // @end
    // @module:push-mobile
    expect(root).toContain(
      'mobilePush: "packages/push-mobile/src/transport.ts"',
    );
    // @end
    expect(root).toContain("...outboundBoundary(");
    expect(web).toContain("...outboundBoundary(");
  });

  it("only the email transport imports a mail library", () => {
    const offenders = files
      .filter((f) =>
        /from\s+["'](nodemailer|@sendgrid\/|resend|postmark|mailgun|@aws-sdk\/client-ses)/.test(
          readFileSync(f, "utf8"),
        ),
      )
      .map((f) => relative(ROOT, f))
      .filter((f) => f !== MAIL_TRANSPORT);
    expect(offenders).toEqual([]);
  });

  it("nothing imports an SMS SDK (packages/sms/src/transport.ts is a fetch client)", () => {
    const offenders = files
      .filter((f) =>
        /from\s+["'](twilio|vonage|@vonage\/|messagebird|plivo|telnyx)/.test(
          readFileSync(f, "utf8"),
        ),
      )
      .map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  // @module:sms
  it("only the sms transport names the Twilio API host", () => {
    const offenders = files
      .filter((f) => /api\.twilio\.com/i.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f))
      .filter((f) => f !== SMS_TRANSPORT);
    expect(offenders).toEqual([]);
  });
  // @end

  // @module:push-mobile
  it("only the mobile push transport (and its tests) names the Expo push host", () => {
    const offenders = files
      .filter((f) => /exp\.host/i.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f))
      .filter(
        (f) =>
          f !== MOBILE_PUSH_TRANSPORT &&
          f !== "packages/push-mobile/src/index.test.ts",
      );
    expect(offenders).toEqual([]);
  });
  // @end

  it("only each channel's guarded entry point (and its tests) imports its transport", () => {
    const importers = files
      .filter((f) =>
        /from\s+["'][^"']*\/transport["']/.test(readFileSync(f, "utf8")),
      )
      .map((f) => relative(ROOT, f));
    // ...and the transports' own tests, which fake the SDKs.
    expect(importers.sort()).toEqual([
      "packages/email/src/index.ts",
      "packages/email/src/transport.test.ts",
      "packages/push-mobile/src/index.test.ts", // @module:push-mobile
      "packages/push-mobile/src/index.ts", // @module:push-mobile
      "packages/sms/src/index.test.ts", // @module:sms
      "packages/sms/src/index.ts", // @module:sms
    ]);
  });

  it("the channel packages export nothing but the guarded entry point", () => {
    for (const pkgDir of [
      "packages/email",
      "packages/sms", // @module:sms
      "packages/push-mobile", // @module:push-mobile
    ]) {
      const pkg = JSON.parse(
        readFileSync(resolve(ROOT, pkgDir, "package.json"), "utf8"),
      );
      expect(pkg.exports, pkgDir).toEqual({ ".": "./src/index.ts" });
    }
  });

  it("no other workspace depends on a mail or SMS library directly", () => {
    const manifests = ["apps", "packages"].flatMap((d) =>
      readdirSync(resolve(ROOT, d)).map((p) =>
        resolve(ROOT, d, p, "package.json"),
      ),
    );
    const offenders = manifests.filter((m) => {
      try {
        const pkg = JSON.parse(readFileSync(m, "utf8"));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (m.endsWith("packages/email/package.json")) return "twilio" in deps;
        if (m.endsWith("packages/sms/package.json"))
          return "nodemailer" in deps || "resend" in deps || "twilio" in deps;
        return (
          "nodemailer" in deps ||
          "resend" in deps ||
          "twilio" in deps ||
          "expo-server-sdk" in deps
        );
      } catch {
        return false;
      }
    });
    expect(offenders.map((m) => relative(ROOT, m))).toEqual([]);
  });
});
