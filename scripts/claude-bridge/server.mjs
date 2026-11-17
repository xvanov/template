#!/usr/bin/env node
/**
 * Claude bridge — lets an app running in a CONTAINER use the host's Claude
 * Code login for `cli/` models (packages/ai/src/providers/cli.ts).
 *
 *   POST /generate  { prompt, model, system?, effort?, jsonSchema? }
 *     → 200 with the `claude -p --output-format json` result, verbatim
 *   GET  /health    → { ok: true }
 *
 * Plain Node, no dependencies, so it runs from a checkout without npm install.
 *
 * Safety, each one load-bearing:
 *  - X-Bridge-Key is compared in constant time against CLAUDE_BRIDGE_KEY
 *    (32+ chars). Without the key there is nothing to do but 401.
 *  - It binds to loopback or a Tailscale address ONLY (CLAUDE_BRIDGE_HOST,
 *    default 127.0.0.1). This endpoint spends the operator's Claude credit; it
 *    must never be on a LAN or public interface. A container reaches it via
 *    the host's tailnet IP (or run the app with host networking).
 *  - `claude` runs with no tools, no MCP servers, no user settings, no session
 *    history, from an empty directory — the same argv as cli.ts. Keep in sync.
 *  - One `claude` at a time (a queue), each with a hard timeout.
 *  - `model` must look like a model id: it cannot smuggle a flag into argv.
 *
 * Run:   CLAUDE_BRIDGE_KEY=$(openssl rand -hex 32) node scripts/claude-bridge/server.mjs
 * Unit:  ops/systemd/claude-bridge.service
 */
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HOST = process.env.CLAUDE_BRIDGE_HOST || "127.0.0.1";
const PORT = Number(process.env.CLAUDE_BRIDGE_PORT || 3017);
const KEY = process.env.CLAUDE_BRIDGE_KEY || "";
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const TIMEOUT_MS = Number(process.env.CLAUDE_CLI_TIMEOUT_SECONDS || 300) * 1000;
const MAX_BODY = 2 * 1024 * 1024;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** Loopback, or Tailscale's ranges (100.64.0.0/10, fd7a:115c:a1e0::/48). */
export function hostAllowed(host) {
  if (host === "localhost" || host === "::1") return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 127 || (a === 100 && b >= 64 && b <= 127);
  }
  return isIP(host) === 6 && /^fd7a:115c:a1e0:/i.test(host);
}

export function keyOk(header, key = KEY) {
  if (typeof header !== "string" || !key) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Identical to cliArgs() in packages/ai/src/providers/cli.ts. */
export function claudeArgs({ model, system, effort, jsonSchema }) {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--setting-sources",
    "project",
    "--no-session-persistence",
    "--tools",
    "",
    "--strict-mcp-config",
    "--max-turns",
    "3",
    "--model",
    model,
  ];
  if (effort) args.push("--effort", effort);
  if (system) args.push("--system-prompt", system);
  if (jsonSchema) args.push("--json-schema", JSON.stringify(jsonSchema));
  return args;
}

let cwd;
function runClaude(args, prompt) {
  cwd ??= mkdtempSync(join(tmpdir(), "claude-bridge-"));
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`claude -p timed out after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`could not start ${CLAUDE_BIN}: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (out.trim()) resolve(out);
      else
        reject(
          new Error(`claude -p exited ${code}: ${err.trim().slice(0, 300)}`),
        );
    });
    child.stdin.end(prompt);
  });
}

let chain = Promise.resolve();
function enqueue(fn) {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "content-type": type });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function validate(body) {
  const { prompt, model, system, effort, jsonSchema } = body ?? {};
  if (typeof prompt !== "string" || !prompt) return "prompt required";
  if (typeof model !== "string" || !/^[a-z0-9][a-z0-9.\-[\]]*$/i.test(model))
    return "model must be a model id";
  if (system !== undefined && typeof system !== "string")
    return "system must be a string";
  if (effort !== undefined && !EFFORTS.has(effort)) return "bad effort";
  if (
    jsonSchema !== undefined &&
    (typeof jsonSchema !== "object" || jsonSchema === null)
  )
    return "jsonSchema must be an object";
  return null;
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health")
    return send(res, 200, { ok: true });
  if (req.method !== "POST" || req.url !== "/generate")
    return send(res, 404, { error: "not found" });
  if (!keyOk(req.headers["x-bridge-key"]))
    return send(res, 401, { error: "unauthorized" });

  let raw = "";
  req.on("data", (c) => {
    raw += c;
    if (raw.length > MAX_BODY) req.destroy();
  });
  req.on("end", async () => {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return send(res, 400, { error: "body must be JSON" });
    }
    const problem = validate(body);
    if (problem) return send(res, 400, { error: problem });
    try {
      const out = await enqueue(() => runClaude(claudeArgs(body), body.prompt));
      send(res, 200, out);
    } catch (err) {
      send(res, 502, { error: String(err?.message ?? err).slice(0, 500) });
    }
  });
});

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (KEY.length < 32) {
    console.error(
      "[claude-bridge] CLAUDE_BRIDGE_KEY must be at least 32 chars (openssl rand -hex 32)",
    );
    process.exit(1);
  }
  if (!hostAllowed(HOST)) {
    console.error(
      `[claude-bridge] refusing to bind ${HOST}: loopback or a Tailscale address only — this spends your Claude credit`,
    );
    process.exit(1);
  }
  server.listen(PORT, HOST, () =>
    console.log(`[claude-bridge] listening on ${HOST}:${PORT}`),
  );
}
