#!/usr/bin/env node
/**
 * The one way to run the Tauri CLI here (`make desktop`, `make desktop-build`,
 * CI). It turns OPTIONAL environment variables into a `--config` overlay, so
 * nothing build-specific (an update server, a signing certificate) is ever
 * written into tauri.conf.json, and a plain build needs none of them:
 *
 *   DESKTOP_APP_URL                  server a fresh install opens (compiled in;
 *                                    default http://localhost:3200)
 *   DESKTOP_EMBED_ORIGINS            extra https origins the window may load,
 *                                    comma-separated (iframes: payments, video)
 *   DESKTOP_UPDATER_PUBKEY           updater public key (`tauri signer generate`)
 *   DESKTOP_UPDATER_ENDPOINT         where latest.json lives; with the key above
 *                                    it turns the updater ON and makes `build`
 *                                    sign update bundles, which then needs
 *   TAURI_SIGNING_PRIVATE_KEY        (+ _PASSWORD) read by the CLI itself
 *   DESKTOP_WINDOWS_CERT_THUMBPRINT  Authenticode cert in the Windows store
 *   DESKTOP_WINDOWS_TIMESTAMP_URL    default http://timestamp.digicert.com
 *   APPLE_*                          macOS signing + notarisation, read by the
 *                                    CLI itself (see README "Signing")
 */
import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const sub = args[0];
const env = process.env;

function fail(msg) {
  console.error(`[desktop] ${msg}`);
  process.exit(1);
}

function httpUrl(name, value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    fail(`${name} is not a URL: ${value}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    fail(`${name} must be http(s): ${value}`);
  }
  return u;
}

if (sub === "dev" || sub === "build") {
  const cargo = spawnSync("cargo", ["--version"], { stdio: "ignore" });
  if (cargo.error || cargo.status !== 0) {
    fail(
      "Rust is required for the desktop app (https://rustup.rs). " +
        "Nothing else in this repo needs it.",
    );
  }
  if (env.DESKTOP_APP_URL) httpUrl("DESKTOP_APP_URL", env.DESKTOP_APP_URL);

  const overlay = {};
  const pubkey = env.DESKTOP_UPDATER_PUBKEY?.trim();
  const endpoint = env.DESKTOP_UPDATER_ENDPOINT?.trim();
  if (pubkey || endpoint) {
    if (!pubkey || !endpoint) {
      fail(
        "set BOTH DESKTOP_UPDATER_PUBKEY and DESKTOP_UPDATER_ENDPOINT, or neither",
      );
    }
    if (httpUrl("DESKTOP_UPDATER_ENDPOINT", endpoint).protocol !== "https:") {
      fail("DESKTOP_UPDATER_ENDPOINT must be https");
    }
    overlay.plugins = { updater: { pubkey, endpoints: [endpoint] } };
    if (sub === "build") {
      if (!env.TAURI_SIGNING_PRIVATE_KEY) {
        fail(
          "the updater is configured, so the build must sign its update " +
            "bundles: set TAURI_SIGNING_PRIVATE_KEY (and _PASSWORD)",
        );
      }
      overlay.bundle = { createUpdaterArtifacts: true };
    }
  }
  const thumbprint = env.DESKTOP_WINDOWS_CERT_THUMBPRINT?.trim();
  if (sub === "build" && thumbprint) {
    overlay.bundle = {
      ...overlay.bundle,
      windows: {
        certificateThumbprint: thumbprint,
        digestAlgorithm: "sha256",
        timestampUrl:
          env.DESKTOP_WINDOWS_TIMESTAMP_URL || "http://timestamp.digicert.com",
      },
    };
  }
  if (Object.keys(overlay).length > 0) {
    args.splice(1, 0, "--config", JSON.stringify(overlay));
    console.log(
      `[desktop] config overlay: ${Object.keys(overlay.plugins ?? {})
        .concat(Object.keys(overlay.bundle ?? {}))
        .join(", ")}`,
    );
  }
}

const require = createRequire(import.meta.url);
let cli;
try {
  cli = require.resolve("@tauri-apps/cli/tauri.js");
} catch {
  fail("the Tauri CLI is not installed: run `npm install` at the repo root");
}
const r = spawnSync(process.execPath, [cli, ...args], {
  cwd: join(here, ".."),
  stdio: "inherit",
});
// `tauri icon` also writes Android, iOS and Windows Store icons; a desktop
// bundle uses none of them (tauri.conf.json bundle.icon lists what it does).
if (sub === "icon" && r.status === 0) {
  const dir = join(here, "..", "src-tauri", "icons");
  for (const f of readdirSync(dir)) {
    if (
      /^(android|ios|Square\d+x\d+Logo\.png|StoreLogo\.png|64x64\.png)$/.test(f)
    ) {
      rmSync(join(dir, f), { recursive: true });
    }
  }
}
process.exit(r.status ?? 1);
