/**
 * cli/ — a headless `claude -p` on the operator's Claude Code login. No API
 * key: useful for internal tools and dev boxes where the operator already
 * pays for Claude Code. Entirely optional; with `claude` absent nothing else
 * breaks — a cli/ call fails with an LlmProviderError naming CLAUDE_BIN.
 *
 * Isolation, each flag earned:
 *  - cwd is an EMPTY temp dir of its own: no repo CLAUDE.md is discovered, and
 *    not the temp root itself, which Claude Code would index at startup.
 *  - --setting-sources project: the operator's own hooks, plugins and output
 *    styles cannot rewrite the prompt or the reply.
 *  - --no-session-persistence: a thousand calls do not land in session history.
 *  - --tools "" + --strict-mcp-config: no tools, no MCP servers spawned.
 *  - --max-turns 3: structured output uses one internal turn; slack for one more.
 *  - --system-prompt ALWAYS: without one, Claude Code sends its whole built-in
 *    agent prompt (~3.7K input tokens for "pong"). A neutral one is used when
 *    the caller gives none. Organisation-managed policy (managed settings set
 *    by a Claude for Work admin) may still apply — it is outside our control.
 *  - an ALLOWLISTED environment (childEnv): the child never sees DATABASE_URL,
 *    auth secrets or SMTP credentials, and never ANTHROPIC_* — an
 *    ANTHROPIC_API_KEY in the app's env would otherwise silently switch the
 *    CLI from the subscription login to that (paid) key.
 *  - one call at a time (a queue); the timeout covers the queue wait too, so
 *    a caller never waits longer than it asked.
 *
 * Cost comes from the CLI itself (`total_cost_usd`, API-equivalent dollars) —
 * it draws on the subscription's credit pool, and it is recorded like any call.
 *
 * BRIDGE: an app inside Docker has no `claude` and no login. Set
 * CLAUDE_BRIDGE_URL + CLAUDE_BRIDGE_KEY and the same request is POSTed to
 * scripts/claude-bridge/server.mjs on the host, which runs the same command
 * and returns the CLI's JSON verbatim — so parsing below is shared.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { env } from "@repo/env";

import { LlmConfigError, LlmProviderError } from "../errors";
import type { Effort } from "../models";
import type { TokenUsage } from "../pricing";
import type { ProviderRequest, ProviderResult } from "./types";

/** Used when the caller gives no system prompt. Kept identical in the bridge. */
export const NEUTRAL_SYSTEM_PROMPT =
  "You are a text-generation endpoint. You have no tools. Reply with only the requested content.";

/** Variables `claude` may see. Kept identical in scripts/claude-bridge/server.mjs. */
const CHILD_ENV_ALLOW =
  /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TMPDIR|TEMP|TMP|XDG_[A-Z_]+|CLAUDE_CONFIG_DIR|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/;

/**
 * The child's environment: an allowlist, never the app's whole env. Pure —
 * the caller passes the source (the process env) in.
 */
export function childEnv(
  source: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined && CHILD_ENV_ALLOW.test(k)) out[k] = v;
  }
  return out;
}

/** The argv for one call. Kept identical to scripts/claude-bridge/server.mjs. */
export function cliArgs(opts: {
  model: string;
  system?: string;
  effort?: Effort;
  jsonSchema?: Record<string, unknown>;
}): string[] {
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
    opts.model,
  ];
  if (opts.effort) args.push("--effort", opts.effort);
  args.push("--system-prompt", opts.system || NEUTRAL_SYSTEM_PROMPT);
  if (opts.jsonSchema)
    args.push("--json-schema", JSON.stringify(opts.jsonSchema));
  return args;
}

interface CliJson {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  structured_output?: unknown;
  stop_reason?: string;
  total_cost_usd?: unknown;
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  modelUsage?: Record<string, unknown>;
}

/**
 * Parse `claude -p --output-format json` stdout. Pure.
 * Throws LlmProviderError on an error result or unparseable output.
 */
export function parseCliOutput(
  stdout: string,
  requested: string,
): Omit<ProviderResult, "servedBy"> & { servedModel: string } {
  let j: CliJson;
  try {
    j = JSON.parse(stdout) as CliJson;
  } catch {
    throw new LlmProviderError(
      `claude -p returned non-JSON output: ${stdout.trim().slice(0, 200)}`,
      "cli",
      false,
      { costUnknown: true },
    );
  }
  const u = j.usage ?? {};
  const usage: TokenUsage = {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
  const cost = Number(j.total_cost_usd);
  const costUsd =
    j.total_cost_usd != null && Number.isFinite(cost)
      ? Math.round(cost * 1e6) / 1e6
      : null;
  const servedModel = Object.keys(j.modelUsage ?? {})[0] ?? requested;

  if (
    j.subtype === "error_max_turns" ||
    j.subtype === "error_max_tokens" ||
    j.stop_reason === "max_tokens"
  ) {
    return {
      text: String(j.result ?? ""),
      usage,
      costUsd,
      stop: "max_tokens",
      servedModel,
    };
  }
  if (j.stop_reason === "refusal") {
    return {
      text: String(j.result ?? ""),
      usage,
      costUsd,
      stop: "refusal",
      refusal: { category: null, explanation: null },
      servedModel,
    };
  }
  if (j.is_error || j.subtype !== "success") {
    throw new LlmProviderError(
      `claude -p failed (${j.subtype ?? "unknown"}): ${String(j.result ?? "").slice(0, 300)}`,
      "cli",
      false,
    );
  }
  const text =
    j.structured_output !== undefined
      ? JSON.stringify(j.structured_output)
      : String(j.result ?? "");
  return { text, usage, costUsd, stop: "end", servedModel };
}

// ── local spawn ──────────────────────────────────────────────────────────

export type SpawnFn = typeof nodeSpawn;

let cwd: string | undefined;
function emptyCwd(): string {
  cwd ??= mkdtempSync(join(tmpdir(), "llm-cli-"));
  return cwd;
}

/** One `claude` at a time per process: predictable load on the operator's box. */
let chain: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

/**
 * Run `claude` with `args`, the prompt on stdin. `timeoutMs` is the caller's
 * whole budget INCLUDING time spent waiting in the queue: a run that reaches
 * the front with no time left is never started.
 */
export function runClaude(
  args: string[],
  prompt: string,
  timeoutMs: number,
  spawn: SpawnFn = nodeSpawn,
  bin: string = env().CLAUDE_BIN,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const timedOut = (started: boolean) =>
    new LlmProviderError(
      `claude -p timed out after ${Math.round(timeoutMs / 1000)}s${started ? "" : " waiting in the queue"}`,
      "cli",
      true,
      // Killed mid-run: it may have spent. Never started: it did not.
      { costUnknown: started },
    );
  return enqueue(
    () =>
      new Promise<string>((resolve, reject) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return reject(timedOut(false));
        const child = spawn(bin, args, {
          cwd: emptyCwd(),
          // Rule 3 is about app CONFIG; this only forwards an allowlist of the
          // process's own variables (PATH, HOME, locale…) to the child.
          // (Cast: some workspaces augment ProcessEnv with required keys.)
          env: childEnv(process.env) as NodeJS.ProcessEnv,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        let out = "";
        let err = "";
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(timedOut(true));
        }, remaining);
        child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
        child.stderr?.on("data", (d: Buffer) => (err += d.toString()));
        child.on("error", (e) => {
          clearTimeout(timer);
          reject(
            new LlmProviderError(
              `could not start ${bin} (set CLAUDE_BIN, or use the bridge): ${e.message}`,
              "cli",
              false,
              { cause: e, costUnknown: false },
            ),
          );
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          // A failed run still prints its JSON result; let the parser judge it.
          if (out.trim()) return resolve(out);
          reject(
            new LlmProviderError(
              `claude -p exited ${code}: ${err.trim().slice(0, 300)}`,
              "cli",
              false,
            ),
          );
        });
        // The prompt goes in on stdin: argv has length limits, prompts don't.
        child.stdin?.end(prompt);
      }),
  );
}

// ── bridge ───────────────────────────────────────────────────────────────

export type FetchFn = typeof fetch;

/** Slack for the HTTP round trip on top of the run's own timeout. */
const BRIDGE_SLACK_MS = 15_000;

export async function viaBridge(
  body: {
    prompt: string;
    model: string;
    system?: string;
    effort?: Effort;
    jsonSchema?: Record<string, unknown>;
  },
  timeoutMs: number,
  fetchFn: FetchFn = fetch,
): Promise<string> {
  const e = env();
  let res: Response;
  let text: string;
  try {
    res = await fetchFn(
      `${e.CLAUDE_BRIDGE_URL!.replace(/\/+$/, "")}/generate`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bridge-key": e.CLAUDE_BRIDGE_KEY!,
        },
        // The bridge counts its queue wait inside timeoutMs and kills `claude`
        // if we hang up, so giving up here does not leave it spending.
        body: JSON.stringify({ ...body, timeoutMs }),
        signal: AbortSignal.timeout(timeoutMs + BRIDGE_SLACK_MS),
      },
    );
    text = await res.text();
  } catch (err) {
    throw new LlmProviderError(
      `claude bridge unreachable or timed out: ${err instanceof Error ? err.message : String(err)}`,
      "cli",
      true,
      { cause: err, costUnknown: true },
    );
  }
  if (!res.ok) {
    // 502 = the run itself failed or timed out on the bridge (may have spent);
    // 4xx / 503 (queue full) = refused before running.
    throw new LlmProviderError(
      `claude bridge ${res.status}: ${text.slice(0, 300)}`,
      "cli",
      res.status >= 500,
      { costUnknown: res.status === 502 },
    );
  }
  return text;
}

export interface CliDeps {
  spawn?: SpawnFn;
  fetch?: FetchFn;
}

export async function callCli(
  req: ProviderRequest,
  deps: CliDeps = {},
): Promise<ProviderResult> {
  if (req.images?.length) {
    // The CLI and the bridge take text on stdin; there is no image channel.
    throw new LlmConfigError(
      "cli/ models cannot take images: route this tier to an anthropic/ or OpenAI-family vision model.",
    );
  }
  const e = env();
  const timeoutMs = req.timeoutMs ?? e.CLAUDE_CLI_TIMEOUT_SECONDS * 1000;
  const model = req.route.model;
  const stdout =
    e.CLAUDE_BRIDGE_URL && e.CLAUDE_BRIDGE_KEY
      ? await viaBridge(
          {
            prompt: req.prompt,
            model,
            ...(req.system ? { system: req.system } : {}),
            effort: req.effort,
            ...(req.jsonSchema ? { jsonSchema: req.jsonSchema } : {}),
          },
          timeoutMs,
          deps.fetch,
        )
      : await runClaude(
          cliArgs({
            model,
            ...(req.system ? { system: req.system } : {}),
            effort: req.effort,
            ...(req.jsonSchema ? { jsonSchema: req.jsonSchema } : {}),
          }),
          req.prompt,
          timeoutMs,
          deps.spawn,
        );
  const { servedModel, ...result } = parseCliOutput(stdout, model);
  return { ...result, servedBy: `cli/${servedModel}` };
}
