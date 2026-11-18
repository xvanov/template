/**
 * cli/ provider. Offline: `claude` is replaced by a tiny Node script that
 * echoes back what it was given, so the real spawn path, the env allowlist,
 * the queue, the timeout and the bridge server are exercised without a login
 * or a network.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  childEnv as bridgeChildEnv,
  claudeArgs,
  hostAllowed,
  keyOk,
  validate,
} from "../../../../scripts/claude-bridge/server.mjs";
import { LlmProviderError } from "../errors";
import { parseModel } from "../models";
import { setLlmEnv } from "../test-env";
import {
  callCli,
  childEnv,
  cliArgs,
  NEUTRAL_SYSTEM_PROMPT,
  parseCliOutput,
  runClaude,
} from "./cli";

// Captured from a real `claude -p --output-format json --json-schema …` run.
const REAL = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  stop_reason: "tool_use",
  total_cost_usd: 0.0008812000000000002,
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 4270,
    cache_read_input_tokens: 0,
    output_tokens: 54,
  },
  modelUsage: { "claude-haiku-5-5": { costUSD: 0.0008812 } },
  result: '{"capital":"Paris"}',
  structured_output: { capital: "Paris" },
});

const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
const FAKE = join(dir, "claude");
writeFileSync(
  FAKE,
  `#!/usr/bin/env node
const fs = require("fs");
let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  const argv = process.argv.slice(2);
  const model = argv[argv.indexOf("--model") + 1];
  // TMPDIR is on the env allowlist; the bridge test points it at a pid dir.
  const t = process.env.TMPDIR || "";
  if (t.includes("fake-claude-pids")) fs.writeFileSync(t + "/pid-" + process.pid, "");
  const reply = () => process.stdout.write(JSON.stringify({
    type: "result", subtype: "success", is_error: false,
    total_cost_usd: 0.0123,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 0 },
    modelUsage: { [model]: {} },
    result: JSON.stringify({ argv, cwdFiles: fs.readdirSync(process.cwd()), stdin, envKeys: Object.keys(process.env) }),
  }));
  if (model === "slow") setTimeout(reply, 5000); else reply();
});
`,
);
chmodSync(FAKE, 0o755);

beforeEach(() => setLlmEnv({ CLAUDE_BIN: FAKE }));

const req = (model: string) => ({
  route: parseModel(`cli/${model}`),
  prompt: "the prompt",
  system: "be terse",
  maxOutputTokens: 100,
  effort: "low" as const,
});

describe("parseCliOutput", () => {
  it("reads cost, usage and structured output from a real result", () => {
    expect(parseCliOutput(REAL, "claude-haiku-5-5")).toMatchObject({
      text: '{"capital":"Paris"}',
      stop: "end",
      costUsd: 0.000881,
      servedModel: "claude-haiku-5-5",
      usage: {
        inputTokens: 2,
        outputTokens: 54,
        cacheWriteTokens: 4270,
        cacheReadTokens: 0,
      },
    });
  });

  it("maps max turns / max_tokens to truncation and an error result to a provider error", () => {
    const parse = (o: unknown) => parseCliOutput(JSON.stringify(o), "m");
    expect(parse({ subtype: "error_max_turns", is_error: true }).stop).toBe(
      "max_tokens",
    );
    expect(
      parse({ subtype: "success", stop_reason: "max_tokens", result: "Par" }),
    ).toMatchObject({
      stop: "max_tokens",
      text: "Par",
    });
    expect(() =>
      parse({ subtype: "error_during_execution", is_error: true }),
    ).toThrow(LlmProviderError);
    expect(() => parseCliOutput("Invalid API key", "m")).toThrow(/non-JSON/);
  });
});

describe("argv and environment", () => {
  it("is tool-less, settings-isolated, session-less — and identical in the bridge", () => {
    const opts = {
      model: "claude-opus-5-5",
      system: "s",
      effort: "high" as const,
      jsonSchema: { type: "object" },
    };
    const args = cliArgs(opts);
    expect(args).toEqual(claudeArgs(opts));
    expect(args.join(" ")).toContain(
      "--setting-sources project --no-session-persistence --tools  --strict-mcp-config",
    );
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("always sends a system prompt, so Claude Code's own agent prompt is never used", () => {
    const args = cliArgs({ model: "m" });
    expect(args[args.indexOf("--system-prompt") + 1]).toBe(
      NEUTRAL_SYSTEM_PROMPT,
    );
    expect(claudeArgs({ model: "m" })).toEqual(args);
  });

  it("passes the child an allowlisted env: no app secrets, never ANTHROPIC_*", () => {
    const source = {
      PATH: "/bin",
      HOME: "/h",
      LC_ALL: "C",
      XDG_CONFIG_HOME: "/h/.config",
      CLAUDE_CONFIG_DIR: "/c",
      ANTHROPIC_API_KEY: "sk-ant-x",
      ANTHROPIC_BASE_URL: "https://x",
      DATABASE_URL: "postgres://x",
      BETTER_AUTH_SECRET: "s",
      SMTP_PASS: "p",
      CLAUDE_BRIDGE_KEY: "k",
    };
    const expected = {
      PATH: "/bin",
      HOME: "/h",
      LC_ALL: "C",
      XDG_CONFIG_HOME: "/h/.config",
      CLAUDE_CONFIG_DIR: "/c",
    };
    expect(childEnv(source)).toEqual(expected);
    expect(bridgeChildEnv(source)).toEqual(expected);
  });
});

describe("local spawn", () => {
  it("runs from an empty dir, sends the prompt on stdin, and records the CLI's own cost", async () => {
    const r = await callCli(req("claude-sonnet-5-5"));
    const echo = JSON.parse(r.text) as {
      argv: string[];
      cwdFiles: string[];
      stdin: string;
    };
    expect(echo.cwdFiles).toEqual([]);
    expect(echo.stdin).toBe("the prompt");
    expect(echo.argv).toEqual(
      expect.arrayContaining([
        "--system-prompt",
        "be terse",
        "--effort",
        "low",
      ]),
    );
    expect(r).toMatchObject({
      costUsd: 0.0123,
      servedBy: "cli/claude-sonnet-5-5",
      stop: "end",
    });
  });

  it("really spawns with the allowlist: an ANTHROPIC_API_KEY in the app env never reaches claude", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-leak";
    try {
      const echo = JSON.parse((await callCli(req("m"))).text) as {
        envKeys: string[];
      };
      expect(echo.envKeys).toContain("PATH");
      expect(
        echo.envKeys.filter((k) =>
          /^ANTHROPIC_|^DATABASE_URL$|^BETTER_AUTH/.test(k),
        ),
      ).toEqual([]);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("kills a run that exceeds the timeout, and marks its cost unknown", async () => {
    const err = await runClaude(cliArgs({ model: "slow" }), "x", 300).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LlmProviderError);
    expect((err as LlmProviderError).message).toMatch(/timed out/);
    expect((err as LlmProviderError).costUnknown).toBe(true);
  });

  it("counts queue wait inside the timeout: a call stuck behind a slow one never starts", async () => {
    const slow = runClaude(cliArgs({ model: "slow" }), "x", 600).catch(
      (e: unknown) => e,
    );
    const queued = await runClaude(cliArgs({ model: "fast" }), "x", 300).catch(
      (e: unknown) => e,
    );
    expect((queued as LlmProviderError).message).toMatch(
      /waiting in the queue/,
    );
    expect((queued as LlmProviderError).costUnknown).toBe(false); // never ran
    expect(((await slow) as LlmProviderError).costUnknown).toBe(true); // killed mid-run
  });

  it("refuses images with a config error, before starting anything", async () => {
    setLlmEnv({ CLAUDE_BIN: join(dir, "does-not-exist") });
    await expect(
      callCli({
        ...req("m"),
        images: [{ data: new Uint8Array([1]), mediaType: "image/png" }],
      }),
    ).rejects.toThrow(/cannot take images/);
  });

  it("fails with a typed error naming CLAUDE_BIN when claude is not installed", async () => {
    setLlmEnv({ CLAUDE_BIN: join(dir, "does-not-exist") });
    await expect(callCli(req("m"))).rejects.toThrow(
      /could not start .*CLAUDE_BIN/,
    );
  });
});

describe("bridge", () => {
  const KEY = "k".repeat(40);
  const PORT = 30000 + Math.floor(Math.random() * 20000);
  const SERVER = resolve(
    import.meta.dirname,
    "../../../../scripts/claude-bridge/server.mjs",
  );
  const PIDS = mkdtempSync(join(tmpdir(), "fake-claude-pids-"));
  let server: ChildProcess;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const pids = () => readdirSync(PIDS).filter((f) => f.startsWith("pid-"));
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const post = (model: string, signal?: AbortSignal) =>
    fetch(`http://127.0.0.1:${PORT}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bridge-key": KEY },
      body: JSON.stringify({ prompt: "p", model }),
      ...(signal ? { signal } : {}),
    });

  beforeAll(async () => {
    server = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        CLAUDE_BRIDGE_KEY: KEY,
        CLAUDE_BRIDGE_PORT: String(PORT),
        CLAUDE_BRIDGE_MAX_QUEUE: "1",
        CLAUDE_BIN: FAKE,
        TMPDIR: PIDS,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((ok, fail) => {
      server.stdout!.on(
        "data",
        (d: Buffer) => d.toString().includes("listening") && ok(),
      );
      server.on("exit", (c) => fail(new Error(`bridge exited ${c}`)));
    });
  });
  afterAll(() => {
    server.kill();
  });

  it("answers with the CLI's JSON when the key matches", async () => {
    setLlmEnv({
      CLAUDE_BRIDGE_URL: `http://127.0.0.1:${PORT}`,
      CLAUDE_BRIDGE_KEY: KEY,
      CLAUDE_BIN: "/nonexistent",
    });
    const r = await callCli(req("claude-haiku-5-5"));
    const echo = JSON.parse(r.text) as { stdin: string; envKeys: string[] };
    expect(echo.stdin).toBe("the prompt");
    // The bridge's own key never reaches claude either.
    expect(echo.envKeys).not.toContain("CLAUDE_BRIDGE_KEY");
    expect(r.costUsd).toBe(0.0123);
  });

  it("rejects a wrong key with 401 and a model id that could smuggle a flag with 400", async () => {
    setLlmEnv({
      CLAUDE_BRIDGE_URL: `http://127.0.0.1:${PORT}`,
      CLAUDE_BRIDGE_KEY: "x".repeat(40),
    });
    await expect(callCli(req("m"))).rejects.toThrow(/bridge 401/);
    setLlmEnv({
      CLAUDE_BRIDGE_URL: `http://127.0.0.1:${PORT}`,
      CLAUDE_BRIDGE_KEY: KEY,
    });
    await expect(
      callCli(req("--dangerously-skip-permissions")),
    ).rejects.toThrow(/bridge 400/);
  });

  it("rejects a timeoutMs that is not a positive number, over HTTP and in validate()", async () => {
    for (const timeoutMs of ["300", -1, 0, null, Number.NaN]) {
      expect(validate({ prompt: "p", model: "m", timeoutMs })).toMatch(
        /timeoutMs/,
      );
    }
    expect(validate({ prompt: "p", model: "m", timeoutMs: 1e12 })).toBeNull(); // clamped, not refused
    const res = await fetch(`http://127.0.0.1:${PORT}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bridge-key": KEY },
      body: JSON.stringify({ prompt: "p", model: "m", timeoutMs: "soon" }),
    });
    expect(res.status).toBe(400);
  });

  it("kills claude when the client hangs up, and answers 503 when the queue is full", async () => {
    const before = new Set(pids());
    const a = new AbortController();
    const b = new AbortController();
    const running = post("slow", a.signal).catch(() => null);
    await sleep(400);
    const queued = post("slow", b.signal).catch(() => null);
    await sleep(100);
    expect((await post("slow")).status).toBe(503); // 1 running + 1 waiting = full
    const started = pids().filter((p) => !before.has(p));
    expect(started).toHaveLength(1);
    const pid = Number(started[0]!.slice(4));
    expect(alive(pid)).toBe(true);
    a.abort();
    b.abort();
    await Promise.all([running, queued]);
    await sleep(400);
    expect(alive(pid)).toBe(false); // killed, not left spending
    // The queued run was dropped, never started.
    expect(pids().filter((p) => !before.has(p))).toHaveLength(1);
  });

  it("binds loopback, or this host's tailscale address only, and compares keys in constant time", () => {
    const ifaces = {
      tailscale0: [{ address: "100.101.1.2" }],
      eth0: [{ address: "100.70.0.9" }],
    } as unknown as Parameters<typeof hostAllowed>[1];
    const allowed = (h: string) => hostAllowed(h, ifaces, "");
    expect(["127.0.0.1", "::1", "100.101.1.2"].every(allowed)).toBe(true);
    // Carrier-grade NAT space on a non-tailscale interface is NOT a tailnet.
    expect(
      ["0.0.0.0", "192.168.1.5", "100.70.0.9", "100.128.0.1", "::"].some(
        allowed,
      ),
    ).toBe(false);
    expect(hostAllowed("192.168.1.5", ifaces, "192.168.1.5")).toBe(true); // explicit override
    expect(keyOk(KEY, KEY)).toBe(true);
    expect(keyOk(KEY.slice(1), KEY)).toBe(false);
    expect(keyOk(undefined, KEY)).toBe(false);
  });
});
