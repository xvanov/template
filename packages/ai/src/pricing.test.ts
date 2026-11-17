import { beforeEach, describe, expect, it } from "vitest";

import {
  costUsd,
  estimateUsd,
  parsePrices,
  priceFor,
  priceUsage,
} from "./pricing";
import { setLlmEnv } from "./test-env";

beforeEach(() => setLlmEnv());

const usage = (i: number, o: number, r = 0, w = 0) => ({
  inputTokens: i,
  outputTokens: o,
  cacheReadTokens: r,
  cacheWriteTokens: w,
});

describe("built-in Anthropic prices", () => {
  it("prices Opus 5.5 at $4/$20, cache reads at $0.20, cache writes at 1.25x", () => {
    expect(priceUsage("anthropic/claude-opus-5-5", usage(1e6, 1e6))).toBe(24);
    expect(priceUsage("anthropic/claude-opus-5-5", usage(0, 0, 1e6))).toBe(0.2);
    expect(priceUsage("anthropic/claude-opus-5-5", usage(0, 0, 0, 1e6))).toBe(
      5,
    );
  });

  it("prices Sonnet 5.5 and Haiku 5.5, with Haiku's long-context rate above 100K input", () => {
    expect(priceUsage("anthropic/claude-sonnet-5-5", usage(1e6, 1e6))).toBe(12);
    expect(priceUsage("anthropic/claude-haiku-5-5", usage(1e6, 0))).toBe(0.5);
    expect(priceUsage("anthropic/claude-haiku-5-5", usage(50_000, 0))).toBe(
      0.005,
    );
  });

  it("does not price OpenRouter's Claude at Anthropic's rate, and returns null — never a guess", () => {
    expect(priceFor("openrouter/anthropic/claude-opus-5-5")).toBeNull();
    expect(priceUsage("openai/gpt-5", usage(1000, 1000))).toBeNull();
    expect(priceUsage("anthropic/claude-unknown-9", usage(1, 1))).toBeNull();
  });
});

describe("overrides and the legacy local rates", () => {
  it("parses LLM_PRICES and lets it win over the built-in table", () => {
    expect(
      parsePrices("openai/gpt-5=1.25:10, bad, azure/x=1:2:0.1:1.5"),
    ).toEqual({
      "openai/gpt-5": { input: 1.25, output: 10 },
      "azure/x": { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.5 },
    });
    setLlmEnv({
      LLM_PRICES: "openai/gpt-5=1.25:10,anthropic/claude-opus-5-5=1:1",
    });
    expect(priceUsage("openai/gpt-5", usage(1e6, 1e6))).toBe(11.25);
    expect(priceUsage("anthropic/claude-opus-5-5", usage(1e6, 0))).toBe(1);
  });

  it("prices local/ (and bare names) from LLM_INPUT/OUTPUT_COST_PER_MTOK", () => {
    setLlmEnv({
      LLM_INPUT_COST_PER_MTOK: "0.40",
      LLM_OUTPUT_COST_PER_MTOK: "1.60",
    });
    expect(priceUsage("gpt-4.1-mini", usage(1e6, 1e6))).toBe(2);
    // Six decimals: a $0.0004 call must not round to nothing.
    expect(priceUsage("local/x", usage(1000, 0))).toBe(0.0004);
  });
});

describe("estimateUsd", () => {
  it("prices ~4 chars per token plus the FULL output allowance", () => {
    // 4000 chars → 1000 input tokens @ $4/M + 1000 output @ $20/M
    expect(estimateUsd("anthropic/claude-opus-5-5", 4000, 1000)).toBe(0.024);
    expect(estimateUsd("openai/unpriced", 4000, 1000)).toBe(0);
  });

  it("costUsd is zero for an empty call", () => {
    expect(costUsd(usage(0, 0), { input: 4, output: 20 })).toBe(0);
  });
});
