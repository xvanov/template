/**
 * Opt-in live smoke: `npm run ai:live [-- provider/model …]`.
 *
 * SPENDS REAL MONEY (a few cents at most). Never run by `make test` or CI —
 * the unit tests use fakes. With no arguments it calls every configured tier
 * model, the embedding model, and `cli/claude-haiku-5-5` when `claude` is
 * installed; each gets a text ask and a structured ask. Calls are NOT written
 * to llm_call (this is a diagnostic, not app usage) and no tenant cap applies.
 */
import "@repo/env/load";

import { spawnSync } from "node:child_process";

import { env } from "@repo/env";
import { z } from "zod";

import { createLlm, describeLlm } from "./index";
import { parseModel, providerConfigured } from "./models";

// A diagnostic, not app usage: nothing is written to llm_call.
const llm = createLlm({
  ledger: {
    reserve: async () => ({
      id: null,
      decision: { allowed: true, overCap: false },
      spentUsd: null,
    }),
    settle: async () => undefined,
  },
  capHit: () => undefined,
});

function claudeInstalled(): boolean {
  return (
    spawnSync(env().CLAUDE_BIN, ["--version"], { stdio: "ignore" }).status === 0
  );
}

function targets(): string[] {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  if (args.length) return args;
  const d = describeLlm();
  const models = new Set(
    Object.values(d.tiers).filter((m) =>
      providerConfigured(parseModel(m).provider),
    ),
  );
  if (![...models].some((m) => m.startsWith("cli/")) && claudeInstalled()) {
    models.add("cli/claude-haiku-5-5");
  }
  return [...models].filter(
    (m) => parseModel(m).provider !== "cli" || claudeInstalled(),
  );
}

const usd = (n: number, known: boolean) =>
  known ? `$${n.toFixed(6)}` : "unpriced";

async function main() {
  const models = targets();
  const embedding = env().LLM_EMBEDDING_MODEL;
  if (!models.length && !embedding) {
    console.log(
      "No provider configured — set a key (see .env.example) or pass a model.",
    );
    return;
  }
  let failed = 0;
  const base = {
    purpose: "ai.live",
    priority: "essential" as const,
    maxOutputTokens: 2048,
    effort: "low" as const,
  };

  for (const model of models) {
    try {
      const r = await llm.ask({
        ...base,
        model,
        prompt: "Reply with exactly: pong",
      });
      console.log(
        `✓ ${model.padEnd(36)} text   ${String(r.latencyMs).padStart(6)}ms  ${usd(r.costUsd, r.costKnown).padStart(10)}  served by ${r.servedBy}: ${JSON.stringify(r.text.slice(0, 40))}`,
      );
    } catch (err) {
      failed++;
      console.log(
        `✗ ${model.padEnd(36)} text   ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
      );
    }
    const o = await llm.askObject({
      ...base,
      model,
      schema: z.object({ capital: z.string(), country: z.string() }),
      prompt: "What is the capital of France? Answer as JSON.",
    });
    if (o.ok) {
      console.log(
        `✓ ${model.padEnd(36)} object ${String(o.latencyMs).padStart(6)}ms  ${usd(o.costUsd, o.costKnown).padStart(10)}  ${JSON.stringify(o.object)}`,
      );
    } else {
      failed++;
      console.log(`✗ ${model.padEnd(36)} object ${o.reason}: ${o.detail}`);
    }
  }

  if (embedding) {
    try {
      const r = await llm.embed({ ...base, texts: ["hello world"] });
      console.log(
        `✓ ${embedding.padEnd(36)} embed  ${String(r.latencyMs).padStart(6)}ms  ${usd(r.costUsd, r.costKnown).padStart(10)}  ${r.embeddings[0]!.length} dims`,
      );
    } catch (err) {
      failed++;
      console.log(
        `✗ ${embedding.padEnd(36)} embed  ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  process.exitCode = failed ? 1 : 0;
}

void main();
