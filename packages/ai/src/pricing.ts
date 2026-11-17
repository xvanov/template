/**
 * USD per call. Anthropic list prices are built in (claude-api reference,
 * cached 2026-11); everything else comes from LLM_PRICES or, for local/, the
 * legacy LLM_INPUT/OUTPUT_COST_PER_MTOK. An unknown price is `null` — recorded
 * as costKnown=false — never a guess: a made-up number in the spend table is
 * worse than an honest gap.
 */
import { env } from "@repo/env";

import { parseModel } from "./models";

/** USD per 1M tokens. Cache prices default to 0.1x / 1.25x input (Anthropic's 5-minute cache). */
export interface Price {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Above this many input tokens the long-context price applies (Haiku 5.5). */
  longContext?: { above: number; input: number; output: number };
}

export interface TokenUsage {
  /** Uncached input tokens. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

const ANTHROPIC: Record<string, Price> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    longContext: { above: 100_000, input: 0.5, output: 2.5 },
  },
  "claude-fable-5-2": { input: 8, output: 40, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/** `a=1:2,b=0.4:1.6:0.04` → { a: Price, b: Price }. Malformed entries are skipped. */
export function parsePrices(text: string | undefined): Record<string, Price> {
  const out: Record<string, Price> = {};
  for (const entry of (text ?? "").split(",")) {
    const m =
      /^\s*(.+?)\s*=\s*([\d.]+):([\d.]+)(?::([\d.]+))?(?::([\d.]+))?\s*$/.exec(
        entry,
      );
    if (!m) continue;
    const [input, output, cacheRead, cacheWrite] = [m[2], m[3], m[4], m[5]].map(
      (v) => (v === undefined ? undefined : Number(v)),
    );
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
    out[m[1]!.toLowerCase()] = {
      input: input!,
      output: output!,
      ...(cacheRead !== undefined ? { cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    };
  }
  return out;
}

/**
 * Price for a model string. Order: LLM_PRICES (full `provider/model`), then
 * the built-in Anthropic table for anthropic/ and cli/ (Claude Code reports
 * its own cost, this is only the estimate), then local/'s legacy rates.
 * `openrouter/anthropic/claude-…` is OpenRouter's price, so it is NOT matched
 * to the Anthropic table.
 */
export function priceFor(model: string): Price | null {
  const route = parseModel(model);
  const overrides = parsePrices(env().LLM_PRICES);
  const own = overrides[route.id.toLowerCase()];
  if (own) return own;
  if (route.provider === "anthropic" || route.provider === "cli") {
    return ANTHROPIC[route.model.toLowerCase()] ?? null;
  }
  if (route.provider === "local") {
    const e = env();
    return {
      input: e.LLM_INPUT_COST_PER_MTOK,
      output: e.LLM_OUTPUT_COST_PER_MTOK,
    };
  }
  return null;
}

/** USD, rounded to 6 decimals so sub-cent calls survive. */
export function costUsd(usage: TokenUsage, price: Price): number {
  const totalIn =
    usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const long =
    price.longContext && totalIn > price.longContext.above
      ? price.longContext
      : null;
  const input = long?.input ?? price.input;
  const output = long?.output ?? price.output;
  const cacheRead = price.cacheRead ?? input * 0.1;
  const cacheWrite = price.cacheWrite ?? input * 1.25;
  const usd =
    (usage.inputTokens * input +
      usage.outputTokens * output +
      usage.cacheReadTokens * cacheRead +
      usage.cacheWriteTokens * cacheWrite) /
    1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}

/** Cost of a call on `model`, or null when the model has no known price. */
export function priceUsage(model: string, usage: TokenUsage): number | null {
  const price = priceFor(model);
  return price ? costUsd(usage, price) : null;
}

/**
 * Upper-bound estimate for the pre-send budget check: ~4 chars per input
 * token, and the full output allowance. Errs high on purpose — refusing a
 * call slightly early is the right direction of error for a spending control.
 */
export function estimateUsd(
  model: string,
  inputChars: number,
  maxOutputTokens: number,
): number {
  const price = priceFor(model);
  if (!price) return 0;
  return costUsd(
    {
      ...ZERO_USAGE,
      inputTokens: Math.ceil(inputChars / 4),
      outputTokens: maxOutputTokens,
    },
    price,
  );
}
