/**
 * LLM plumbing — one seam, provider-agnostic, every call priced.
 *
 * The model is a config value (LLM_BASE_URL / LLM_MODEL), not code: any
 * OpenAI-compatible endpoint works — OpenAI, Azure OpenAI, DeepSeek,
 * OpenRouter, Groq, Together, vLLM, Ollama. Swapping provider is an .env edit.
 *
 * Every call is written to the `llm_call` table with tokens, latency and USD
 * cost, so spend is auditable per org and per feature instead of arriving as
 * one opaque provider invoice at the end of the month.
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, streamText, type LanguageModel } from "ai";
import { db } from "@repo/db";
import { env, llmEnabled } from "@repo/env";

export class LlmDisabledError extends Error {
  constructor() {
    super(
      "LLM is not configured — set LLM_API_KEY in .env to enable AI features.",
    );
    this.name = "LlmDisabledError";
  }
}

export { llmEnabled };

let provider: ReturnType<typeof createOpenAICompatible> | undefined;

/** The configured language model. Throws if no API key is set. */
export function model(modelId?: string): LanguageModel {
  if (!llmEnabled()) throw new LlmDisabledError();
  const e = env();
  provider ??= createOpenAICompatible({
    name: "llm",
    apiKey: e.LLM_API_KEY,
    baseURL: e.LLM_BASE_URL,
  });
  return provider(modelId ?? e.LLM_MODEL);
}

export interface AskOptions {
  prompt: string;
  system?: string;
  /** Free-text label for cost attribution, e.g. "item.summarize". */
  purpose: string;
  organizationId?: string | null;
  userId?: string | null;
  modelId?: string;
  maxOutputTokens?: number;
}

export interface AskResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

/** One-shot completion, recorded and priced. */
export async function ask(opts: AskOptions): Promise<AskResult> {
  const e = env();
  const modelId = opts.modelId ?? e.LLM_MODEL;
  const startedAt = Date.now();

  try {
    const result = await generateText({
      model: model(modelId),
      system: opts.system,
      prompt: opts.prompt,
      maxOutputTokens: opts.maxOutputTokens ?? 1024,
    });

    const inputTokens = result.usage.inputTokens ?? 0;
    const outputTokens = result.usage.outputTokens ?? 0;
    const latencyMs = Date.now() - startedAt;
    const costUsd = priceUsd(inputTokens, outputTokens);

    await record({
      ...opts,
      model: modelId,
      inputTokens,
      outputTokens,
      costUsd,
      latencyMs,
      ok: true,
    });

    return { text: result.text, inputTokens, outputTokens, costUsd, latencyMs };
  } catch (err) {
    // A failed call still consumed time (and sometimes tokens). Record it, so
    // "the AI feature is broken" is visible in the same place as its spend.
    await record({
      ...opts,
      model: modelId,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      latencyMs: Date.now() - startedAt,
      ok: false,
      error:
        err instanceof Error
          ? err.message.slice(0, 500)
          : String(err).slice(0, 500),
    });
    throw err;
  }
}

/**
 * Streaming completion. Returns the AI SDK result; usage is recorded from the
 * `onFinish` callback once the stream completes.
 */
export function askStream(opts: AskOptions) {
  const e = env();
  const modelId = opts.modelId ?? e.LLM_MODEL;
  const startedAt = Date.now();

  return streamText({
    model: model(modelId),
    system: opts.system,
    prompt: opts.prompt,
    maxOutputTokens: opts.maxOutputTokens ?? 1024,
    onFinish: ({ usage }) => {
      const inputTokens = usage.inputTokens ?? 0;
      const outputTokens = usage.outputTokens ?? 0;
      void record({
        ...opts,
        model: modelId,
        inputTokens,
        outputTokens,
        costUsd: priceUsd(inputTokens, outputTokens),
        latencyMs: Date.now() - startedAt,
        ok: true,
      });
    },
  });
}

/** USD cost from the per-million-token rates in .env. */
export function priceUsd(inputTokens: number, outputTokens: number): number {
  const e = env();
  const cost =
    (inputTokens / 1_000_000) * e.LLM_INPUT_COST_PER_MTOK +
    (outputTokens / 1_000_000) * e.LLM_OUTPUT_COST_PER_MTOK;
  return Math.round(cost * 1e6) / 1e6;
}

/** Spend rollup for a tenant over the last N days. */
export async function spendByPurpose(organizationId: string, days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await db.llmCall.groupBy({
    by: ["purpose"],
    where: { organizationId, createdAt: { gte: since } },
    _sum: { costUsd: true, inputTokens: true, outputTokens: true },
    _count: { _all: true },
  });
  return rows.map((r) => ({
    purpose: r.purpose,
    calls: r._count._all,
    inputTokens: r._sum.inputTokens ?? 0,
    outputTokens: r._sum.outputTokens ?? 0,
    costUsd: r._sum.costUsd ?? 0,
  }));
}

interface RecordArgs extends Omit<AskOptions, "prompt" | "system" | "modelId"> {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  ok: boolean;
  error?: string;
}

/** Accounting must never take down the feature it is measuring. */
async function record(args: RecordArgs): Promise<void> {
  try {
    await db.llmCall.create({
      data: {
        organizationId: args.organizationId ?? null,
        userId: args.userId ?? null,
        purpose: args.purpose,
        model: args.model,
        inputTokens: args.inputTokens,
        outputTokens: args.outputTokens,
        costUsd: args.costUsd,
        latencyMs: args.latencyMs,
        ok: args.ok,
        error: args.error ?? null,
      },
    });
  } catch (err) {
    console.error("[ai] failed to record llm_call:", err);
  }
}
