#!/usr/bin/env node
/**
 * Claude bridge — lets an app running in a CONTAINER use the host's Claude
 * Code login for `cli/` models (packages/ai/src/providers/cli.ts).
 *
 *   POST /generate  { prompt, model, system?, effort?, jsonSchema?, timeoutMs? }
 *     → 200 with the `claude -p --output-format json` result, verbatim
 *     → 503 when the queue is full, 502 when the run failed or timed out
 *   GET  /health    → { ok: true }
 *
 * Plain Node, no dependencies, so it runs from a checkout without npm install.
 *
 * Safety, each one load-bearing:
 *  - X-Bridge-Key is compared in constant time against CLAUDE_BRIDGE_KEY
 *    (32+ chars). Without the key there is nothing to do but 401.
 *  - It binds to loopback, or to an address that is BOTH in Tailscale's ranges
 *    AND assigned to a `tailscale*` interface on this host (100.64.0.0/10 is
 *    shared carrier-grade NAT space, not proof of a tailnet). Anything else
 *    only with CLAUDE_BRIDGE_TRUST_HOST=<that exact address>. This endpoint
 *    spends the operator's Claude credit; it must never be on a LAN or public
 *    interface.
 *  - `claude` runs with no tools, no MCP servers, no user settings, no session
 *    history, a neutral system prompt, from an empty directory, with an
 *    allowlisted environment — the same as cli.ts. Keep the two in sync.
 *  - One `claude` at a time; at most CLAUDE_BRIDGE_MAX_QUEUE (default 4)
 *    waiting, beyond that 503. A request's timeout covers its queue wait. If
 *    the client hangs up, its run is dropped from the queue or killed.
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
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HOST = process.env.CLAUDE_BRIDGE_HOST || "127.0.0.1";
const PORT = Number(process.env.CLAUDE_BRIDGE_PORT || 3017);
const KEY = process.env.CLAUDE_BRIDGE_KEY || "";
const TRUST_HOST = process.env.CLAUDE_BRIDGE_TRUST_HOST || "";
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const MAX_TIMEOUT_MS =
  Number(process.env.CLAUDE_CLI_TIMEOUT_SECONDS || 300) * 1000;
const MAX_QUEUE = Number(process.env.CLAUDE_BRIDGE_MAX_QUEUE || 4);
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export const NEUTRAL_SYSTEM_PROMPT =
  "You are a text-generation endpoint. You have no tools. Reply with only the requested content.";

const CHILD_ENV_ALLOW =
  /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TMPDIR|TEMP|TMP|XDG_[A-Z_]+|CLAUDE_CONFIG_DIR|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/;

/** Identical to childEnv() in cli.ts: never the key, never ANTHROPIC_*. */
export function childEnv(source) {
  const out = {};
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined && CHILD_ENV_ALLOW.test(k)) out[k] = v;
  }
  return out;
}

function inTailscaleRange(host) {
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 100 && b >= 64 && b <= 127;
  }
  return isIP(host) === 6 && /^fd7a:115c:a1e0:/i.test(host);
}

/**
 * Loopback; or a Tailscale-range address that a `tailscale*` interface on
 * this host actually holds; or exactly the CLAUDE_BRIDGE_TRUST_HOST address.
 */
export function hostAllowed(
  host,
  interfaces = networkInterfaces(),
  trustHost = TRUST_HOST,
) {
  if (host === "localhost" || host === "::1") return true;
  if (isIP(host) === 4 && host.split(".")[0] === "127") return true;
  if (trustHost && host === trustHost) return true;
  if (!inTailscaleRange(host)) return false;
  return Object.entries(interfaces).some(
    ([name, addrs]) =>
      name.startsWith("tailscale") &&
      (addrs ?? []).some((a) => a.address === host),
  );
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
  args.push("--system-prompt", system || NEUTRAL_SYSTEM_PROMPT);
  if (jsonSchema) args.push("--json-schema", JSON.stringify(jsonSchema));
  return args;
}

let cwd;
/** Run one `claude`; killed on timeout or when `signal` aborts (client gone). */
function runClaude(args, prompt, timeoutMs, signal) {
  cwd ??= mkdtempSync(join(tmpdir(), "claude-bridge-"));
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, {
      cwd,
      env: childEnv(process.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const stop = (why) => {
      child.kill("SIGKILL");
      reject(new Error(why));
    };
    const timer = setTimeout(
      () => stop(`claude -p timed out after ${Math.round(timeoutMs / 1000)}s`),
      timeoutMs,
    );
    const onAbort = () => stop("client went away");
    signal.addEventListener("abort", onAbort, { once: true });
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      done();
      reject(new Error(`could not start ${CLAUDE_BIN}: ${e.message}`));
    });
    child.on("close", (code) => {
      done();
      if (out.trim()) resolve(out);
      else
        reject(
          new Error(`claude -p exited ${code}: ${err.trim().slice(0, 300)}`),
        );
    });
    child.stdin.end(prompt);
  });
}

/** Waiting jobs; one runs at a time. */
const queue = [];
let running = false;

function pump() {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = true;
  const remaining = job.deadline - Date.now();
  const work = job.signal.aborted
    ? Promise.reject(new Error("client went away"))
    : remaining <= 0
      ? Promise.reject(new Error("timed out waiting in the queue"))
      : runClaude(job.args, job.prompt, remaining, job.signal);
  work.then(job.resolve, job.reject).finally(() => {
    running = false;
    pump();
  });
}

/** Queue a run, or null when the queue is full. */
function enqueue(args, prompt, deadline, signal) {
  if (queue.length >= MAX_QUEUE) return null;
  return new Promise((resolve, reject) => {
    const job = { args, prompt, deadline, signal, resolve, reject };
    queue.push(job);
    // Gone before its turn: drop it, never run it.
    signal.addEventListener(
      "abort",
      () => {
        const i = queue.indexOf(job);
        if (i >= 0) {
          queue.splice(i, 1);
          reject(new Error("client went away"));
        }
      },
      { once: true },
    );
    pump();
  });
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

  const received = Date.now();
  // Client hung up before we answered: abort its queued or running job.
  const gone = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) gone.abort();
  });

  const chunks = [];
  let bytes = 0;
  req.on("data", (c) => {
    bytes += c.length;
    if (bytes > MAX_BODY_BYTES) {
      send(res, 413, { error: "body too large" });
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on("end", async () => {
    if (bytes > MAX_BODY_BYTES) return;
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return send(res, 400, { error: "body must be JSON" });
    }
    const problem = validate(body);
    if (problem) return send(res, 400, { error: problem });
    const timeoutMs = Math.min(
      body.timeoutMs ?? MAX_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    );
    const pending = enqueue(
      claudeArgs(body),
      body.prompt,
      received + timeoutMs,
      gone.signal,
    );
    if (!pending)
      return send(res, 503, { error: `queue full (${MAX_QUEUE} waiting)` });
    try {
      send(res, 200, await pending);
    } catch (err) {
      if (!res.writableEnded && !gone.signal.aborted)
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
      `[claude-bridge] refusing to bind ${HOST}: loopback or this host's Tailscale address only (or set CLAUDE_BRIDGE_TRUST_HOST=${HOST}) — this endpoint spends your Claude credit`,
    );
    process.exit(1);
  }
  server.listen(PORT, HOST, () =>
    console.log(`[claude-bridge] listening on ${HOST}:${PORT}`),
  );
}
