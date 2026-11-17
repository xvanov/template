/**
 * The engine: reserve before send, settle after, typed stops, and the
 * structured-output failure path. Providers and the ledger are fakes — no
 * network, no database. (The real ledger's lock is tested against Postgres in
 * budget.int.test.ts.)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createLlm,
  llmConfigReport,
  llmEnabled,
  LlmBudgetExceededError,
  LlmConfigError,
  LlmDisabledError,
  LlmProviderError,
  LlmRefusalError,
  LlmTruncatedError,
  LlmUnpricedError,
  type Ledger,
  type LlmCallRow,
  type LlmDeps,
} from "./index";
import type { ProviderResult } from "./providers/types";
import { setLlmEnv } from "./test-env";

const reply = (over: Partial<ProviderResult> = {}): ProviderResult => ({
  text: "Paris",
  usage: {
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  stop: "end",
  servedBy: "anthropic/claude-opus-5-5",
  ...over,
});

/** The ledger's semantics in memory: rows, today's sum incl. pending. */
function memoryLedger(initialSpend = 0, failing = false) {
  const rows = new Map<string, LlmCallRow>();
  let n = 0;
  const ledger: Ledger = {
    async reserve(row, capped, check) {
      if (failing) throw new Error("db down");
      if (capped) {
        const spent =
          initialSpend +
          [...rows.values()]
            .filter((r) => r.organizationId === capped.organizationId)
            .reduce((s, r) => s + r.costUsd, 0);
        const decision = check(spent);
        if (!decision.allowed) return { id: null, decision, spentUsd: spent };
        const id = `r${++n}`;
        rows.set(id, row);
        return { id, decision, spentUsd: spent };
      }
      const id = `r${++n}`;
      rows.set(id, row);
      return {
        id,
        decision: { allowed: true, overCap: false },
        spentUsd: null,
      };
    },
    async settle(id, row) {
      rows.set(id ?? `r${++n}`, row);
    },
  };
  return { ledger, rows: () => [...rows.values()] };
}

function harness(
  result: ProviderResult | Error = reply(),
  opts: { spent?: number; failing?: boolean } = {},
) {
  const warn = vi.fn();
  const call = vi.fn<LlmDeps["call"]>(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  const mem = memoryLedger(opts.spent ?? 0, opts.failing ?? false);
  const llm = createLlm({ call, ledger: mem.ledger, warn });
  return { llm, rows: mem.rows, call, warn };
}

const base = {
  purpose: "test.ask",
  priority: "discretionary" as const,
  organizationId: "org_1",
  prompt: "Capital of France?",
  maxOutputTokens: 1000,
};

beforeEach(() =>
  setLlmEnv({
    ANTHROPIC_API_KEY: "test",
    LLM_MODEL_FAST: "anthropic/claude-haiku-5-5",
    LLM_DAILY_CAP_USD: "1",
  }),
);

describe("ask", () => {
  it("routes by tier, prices the reply and settles one row with provider/tier/priority", async () => {
    const h = harness();
    const r = await h.llm.ask({ ...base, tier: "fast" });
    expect(h.call.mock.calls[0]![0]).toMatchObject({
      route: { provider: "anthropic", model: "claude-haiku-5-5" },
      effort: "medium",
    });
    expect(r).toMatchObject({ text: "Paris", tier: "fast", costKnown: true });
    expect(r.costUsd).toBe(0.00015); // haiku: 1000*0.1 + 100*0.5 per M
    expect(h.rows()).toHaveLength(1);
    expect(h.rows()[0]).toMatchObject({
      model: "anthropic/claude-haiku-5-5",
      provider: "anthropic",
      tier: "fast",
      priority: "discretionary",
      ok: true,
      status: "done",
      costUsd: 0.00015,
    });
  });

  it("throws LlmRefusalError with the category — and still records the billed call", async () => {
    const h = harness(
      reply({
        stop: "refusal",
        refusal: { category: "cyber", explanation: null },
      }),
    );
    const err = await h.llm.ask(base).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmRefusalError);
    expect((err as LlmRefusalError).category).toBe("cyber");
    expect(h.rows()[0]).toMatchObject({ ok: false, error: "refusal (cyber)" });
    expect(h.rows()[0]!.costUsd).toBeGreaterThan(0);
  });

  it("throws LlmTruncatedError on max_tokens, carrying the partial text", async () => {
    const h = harness(reply({ stop: "max_tokens", text: "Par" }));
    const err = await h.llm.ask(base).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmTruncatedError);
    expect((err as LlmTruncatedError).partialText).toBe("Par");
  });

  it("records an HTTP-refused call as a known $0", async () => {
    const h = harness(
      new LlmProviderError("anthropic 400", "anthropic", false, {
        costUnknown: false,
      }),
    );
    await expect(h.llm.ask(base)).rejects.toBeInstanceOf(LlmProviderError);
    expect(h.rows()[0]).toMatchObject({
      ok: false,
      error: "anthropic 400",
      costUsd: 0,
      costKnown: true,
    });
  });

  it("records a timeout as cost-UNKNOWN and keeps its estimate against the cap", async () => {
    const h = harness(
      new LlmProviderError("timed out", "cli", true, { costUnknown: true }),
    );
    await expect(h.llm.ask(base)).rejects.toBeInstanceOf(LlmProviderError);
    // Opus 5.5: ~5 input tokens + 1000 output at $20/M
    expect(h.rows()[0]).toMatchObject({
      ok: false,
      costKnown: false,
      status: "done",
    });
    expect(h.rows()[0]!.costUsd).toBeCloseTo(0.02, 4);
  });

  it("is disabled, not crashing, when the provider has no key or LLM_ENABLED=false", async () => {
    setLlmEnv({ LLM_ENABLED: "false", ANTHROPIC_API_KEY: "k" });
    await expect(harness().llm.ask(base)).rejects.toBeInstanceOf(
      LlmDisabledError,
    );
    setLlmEnv({ LLM_MODEL: "azure/x" });
    await expect(harness().llm.ask(base)).rejects.toThrow(
      /azure\/x is not configured/,
    );
  });
});

describe("the daily cap — reserved before sending", () => {
  it("refuses a discretionary call that would cross the cap, without calling the provider", async () => {
    // Opus 5.5 estimate for 1000 output tokens ≈ $0.02; $0.99 spent of $1.
    const h = harness(reply(), { spent: 0.99 });
    await expect(h.llm.ask(base)).rejects.toBeInstanceOf(
      LlmBudgetExceededError,
    );
    expect(h.call).not.toHaveBeenCalled();
    expect(h.rows()).toHaveLength(0);
  });

  it("counts pending reservations: concurrent calls cannot all slip under the cap", async () => {
    // Each call reserves ~$0.02; the cap admits 50 of them, not all 80.
    const h = harness();
    const results = await Promise.allSettled(
      Array.from({ length: 80 }, () => h.llm.ask(base)),
    );
    const ran = results.filter((r) => r.status === "fulfilled").length;
    expect(ran).toBeLessThan(80);
    expect(h.rows().reduce((s, r) => s + r.costUsd, 0)).toBeLessThanOrEqual(1);
  });

  it("lets essential work through over the cap, and warns", async () => {
    const h = harness(reply(), { spent: 5 });
    await expect(
      h.llm.ask({ ...base, priority: "essential" }),
    ).resolves.toMatchObject({ text: "Paris" });
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringMatching(/over the daily cap/),
      expect.anything(),
    );
  });

  it("refuses discretionary calls on an UNPRICED model while a cap is set; essential ones run, cost unknown", async () => {
    setLlmEnv({ OPENAI_API_KEY: "k", LLM_DAILY_CAP_USD: "1" });
    const h = harness(reply({ servedBy: "openai/gpt-5" }));
    await expect(
      h.llm.ask({ ...base, model: "openai/gpt-5" }),
    ).rejects.toBeInstanceOf(LlmUnpricedError);
    expect(h.call).not.toHaveBeenCalled();
    const r = await h.llm.ask({
      ...base,
      model: "openai/gpt-5",
      priority: "essential",
    });
    expect(r).toMatchObject({ costUsd: 0, costKnown: false });
    expect(h.rows()[0]!.costKnown).toBe(false);
  });

  it("defaults to a $2 cap when unset; only an explicit `off` removes it", async () => {
    setLlmEnv({ ANTHROPIC_API_KEY: "k" });
    await expect(
      harness(reply(), { spent: 2 }).llm.ask(base),
    ).rejects.toBeInstanceOf(LlmBudgetExceededError);
  });

  it("with the cap explicitly off, never refuses — unpriced or not", async () => {
    setLlmEnv({ OPENAI_API_KEY: "k", LLM_DAILY_CAP_USD: "off" });
    const h = harness(reply(), { spent: 1e9 });
    await expect(
      h.llm.ask({ ...base, model: "openai/gpt-5" }),
    ).resolves.toBeDefined();
  });

  it("fails closed for discretionary work when the ledger is down; essential proceeds unrecorded", async () => {
    const h = harness(reply(), { failing: true });
    await expect(h.llm.ask(base)).rejects.toThrow(/could not be read/);
    await expect(
      h.llm.ask({ ...base, priority: "essential" }),
    ).resolves.toBeDefined();
  });

  it("does not cap calls that belong to no tenant (system jobs)", async () => {
    const h = harness(reply(), { spent: 1e9 });
    await expect(
      h.llm.ask({ ...base, organizationId: null }),
    ).resolves.toBeDefined();
  });
});

describe("askObject", () => {
  const schema = z.object({ capital: z.string(), population: z.number() });
  const ask = { ...base, schema };

  it("returns the validated object and sends a JSON schema to the provider", async () => {
    const h = harness(
      reply({ text: '{"capital":"Paris","population":2100000}' }),
    );
    const r = await h.llm.askObject(ask);
    expect(r).toMatchObject({
      ok: true,
      object: { capital: "Paris", population: 2100000 },
    });
    expect(h.call.mock.calls[0]![0].jsonSchema).toMatchObject({
      type: "object",
      required: ["capital", "population"],
    });
  });

  it("sends cli/ and OpenAI-family providers a schema without the draft-2020 `$schema` tag", async () => {
    const h = harness(reply({ text: '{"capital":"Paris","population":1}' }));
    await h.llm.askObject({ ...ask, model: "cli/claude-haiku-5-5" });
    expect(h.call.mock.calls[0]![0].jsonSchema).not.toHaveProperty("$schema");
  });

  it("NEVER repairs: a wrong type is invalid_output, recorded as failed, with the raw text for review", async () => {
    const h = harness(
      reply({ text: '{"capital":"Paris","population":"lots"}' }),
    );
    const r = await h.llm.askObject(ask);
    expect(r).toMatchObject({
      ok: false,
      reason: "invalid_output",
      rawText: expect.stringContaining("lots"),
    });
    if (!r.ok) expect(r.detail).toMatch(/population/);
    expect(h.call).toHaveBeenCalledTimes(1); // no "fix your JSON" retry
    expect(h.rows()[0]).toMatchObject({
      ok: false,
      error: expect.stringMatching(/schema/),
    });
  });

  it("rejects prose-wrapped JSON rather than digging the object out", async () => {
    const h = harness(
      reply({ text: 'Sure! ```json\n{"capital":"Paris","population":1}\n```' }),
    );
    expect(await h.llm.askObject(ask)).toMatchObject({
      ok: false,
      reason: "invalid_output",
      detail: "reply is not JSON",
    });
  });

  it("turns every other failure into a typed reason instead of throwing", async () => {
    expect(
      await harness(reply({ stop: "refusal" })).llm.askObject(ask),
    ).toMatchObject({ ok: false, reason: "refusal" });
    expect(
      await harness(reply({ stop: "max_tokens" })).llm.askObject(ask),
    ).toMatchObject({ ok: false, reason: "truncated" });
    expect(
      await harness(new LlmProviderError("x", "anthropic", true)).llm.askObject(
        ask,
      ),
    ).toMatchObject({
      ok: false,
      reason: "provider_error",
    });
    expect(
      await harness(reply(), { spent: 0.99 }).llm.askObject(ask),
    ).toMatchObject({ ok: false, reason: "over_budget" });
    setLlmEnv({ OPENAI_API_KEY: "k", LLM_DAILY_CAP_USD: "1" });
    expect(
      await harness().llm.askObject({ ...ask, model: "openai/gpt-5" }),
    ).toMatchObject({ ok: false, reason: "unpriced" });
    setLlmEnv({ LLM_ENABLED: "false" });
    expect(await harness().llm.askObject(ask)).toMatchObject({
      ok: false,
      reason: "disabled",
    });
  });

  it("still throws for a malformed model string — that is a bug, not a case for a human", async () => {
    await expect(
      harness().llm.askObject({ ...ask, model: "antropic/x" }),
    ).rejects.toBeInstanceOf(LlmConfigError);
  });
});

describe("embed", () => {
  it("routes to the embedding model, prices it from LLM_PRICES and records kind=embed", async () => {
    setLlmEnv({
      OPENAI_API_KEY: "k",
      LLM_EMBEDDING_MODEL: "openai/text-embedding-3-small",
      LLM_PRICES: "openai/text-embedding-3-small=0.02:0",
    });
    const mem = memoryLedger();
    const llm = createLlm({
      embed: async () => ({ embeddings: [[1, 2]], tokens: 1_000_000 }),
      ledger: mem.ledger,
    });
    const r = await llm.embed({
      texts: ["a"],
      purpose: "test.embed",
      priority: "essential",
      organizationId: "o",
    });
    expect(r).toMatchObject({
      embeddings: [[1, 2]],
      costUsd: 0.02,
      model: "openai/text-embedding-3-small",
    });
    expect(mem.rows()[0]).toMatchObject({
      kind: "embed",
      ok: true,
      status: "done",
    });
  });

  it("is disabled until LLM_EMBEDDING_MODEL is set, and refuses non-embedding providers", async () => {
    const llm = createLlm({ ledger: memoryLedger().ledger });
    await expect(
      llm.embed({ texts: ["a"], purpose: "p", priority: "essential" }),
    ).rejects.toBeInstanceOf(LlmDisabledError);
    await expect(
      llm.embed({
        texts: ["a"],
        purpose: "p",
        priority: "essential",
        model: "anthropic/claude-opus-5-5",
      }),
    ).rejects.toBeInstanceOf(LlmConfigError);
  });
});

describe("introspection", () => {
  it("llmEnabled checks the tier the caller will use, not just the default", () => {
    setLlmEnv({ ANTHROPIC_API_KEY: "k", LLM_MODEL_FAST: "openai/gpt-5" });
    expect(llmEnabled()).toBe(true);
    expect(llmEnabled("fast")).toBe(false);
  });

  it("the boot report names every unpriced tier, legacy reading and the cap", () => {
    setLlmEnv({
      LLM_BASE_URL: "https://openrouter.ai/api/v1",
      LLM_API_KEY: "k",
      LLM_MODEL: "meta-llama/llama-4",
      LLM_DAILY_CAP_USD: "2",
    });
    const { summary, warnings } = llmConfigReport();
    expect(summary).toMatch(
      /default=local\/meta-llama\/llama-4 .*cap \$2\/tenant\/UTC day/,
    );
    expect(warnings.join("\n")).toMatch(/legacy/);
    expect(warnings.join("\n")).toMatch(
      /NO PRICE for local\/meta-llama\/llama-4 .*REFUSED/,
    );
  });
});
