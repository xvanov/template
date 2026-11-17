/**
 * cli/ provider. Offline: `claude` is replaced by a tiny Node script that
 * echoes back what it was given, so the real spawn path, the queue, the
 * timeout and the bridge server are exercised without a login or a network.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  claudeArgs,
  hostAllowed,
  keyOk,
} from "../../../../scripts/claude-bridge/server.mjs";
import { LlmProviderError } from "../errors";
import { parseModel } from "../models";
import { setLlmEnv } from "../test-env";
import { callCli, cliArgs, parseCliOutput, runClaude } from "./cli";

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
  const reply = () => process.stdout.write(JSON.stringify({
    type: "result", subtype: "success", is_error: false,
    total_cost_usd: 0.0123,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 0 },
    modelUsage: { [model]: {} },
    result: JSON.stringify({ argv, cwdFiles: fs.readdirSync(process.cwd()), stdin }),
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
    const r = parseCliOutput(REAL, "claude-haiku-5-5");
    expect(r).toMatchObject({
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

  it("maps max turns to truncation and an error result to a provider error", () => {
    expect(
      parseCliOutput(
        JSON.stringify({ subtype: "error_max_turns", is_error: true }),
        "m",
      ).stop,
    ).toBe("max_tokens");
    expect(() =>
      parseCliOutput(
        JSON.stringify({ subtype: "error_during_execution", is_error: true }),
        "m",
      ),
    ).toThrow(LlmProviderError);
    expect(() => parseCliOutput("Invalid API key", "m")).toThrow(/non-JSON/);
  });
});

describe("argv", () => {
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

  it("kills a run that exceeds the timeout", async () => {
    await expect(
      runClaude(cliArgs({ model: "slow" }), "x", 300),
    ).rejects.toThrow(/timed out/);
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
  let server: ChildProcess;

  beforeAll(async () => {
    server = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        CLAUDE_BRIDGE_KEY: KEY,
        CLAUDE_BRIDGE_PORT: String(PORT),
        CLAUDE_BIN: FAKE,
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
    expect(JSON.parse(r.text).stdin).toBe("the prompt");
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

  it("binds loopback/tailnet only and compares keys in constant time", () => {
    expect(
      ["127.0.0.1", "::1", "100.101.1.2", "fd7a:115c:a1e0::1"].every(
        hostAllowed,
      ),
    ).toBe(true);
    expect(
      ["0.0.0.0", "192.168.1.5", "100.128.0.1", "::"].some(hostAllowed),
    ).toBe(false);
    expect(keyOk(KEY, KEY)).toBe(true);
    expect(keyOk(KEY.slice(1), KEY)).toBe(false);
    expect(keyOk(undefined, KEY)).toBe(false);
  });
});
