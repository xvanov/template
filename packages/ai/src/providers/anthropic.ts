/**
 * Anthropic — through the official @anthropic-ai/sdk, never an
 * OpenAI-compatible shim (which silently drops Claude features and sends
 * parameters current models reject).
 *
 * Rules for the current models (claude-api reference, 2026-11):
 *  - no temperature/top_p/top_k: they 400.
 *  - thinking is adaptive and cannot be disabled on Opus 5.5 — `thinking` is
 *    omitted; depth is `output_config.effort`, set explicitly because Opus
 *    5.5 defaults to "medium" while others default to "high".
 *  - no forced tool_choice for JSON (400 on Opus/Sonnet 5.5): structured
 *    output goes through `output_config.format`.
 *  - server-side refusal fallback is ON where supported (beta
 *    server-side-fallback-2026-07-01, `fallbacks: "default"`): a refusal is
 *    re-run on the fallback model inside the same call. A `refusal` stop that
 *    still comes back means the whole chain declined.
 *  - streaming + finalMessage(), so a large max_tokens never hits an HTTP
 *    timeout.
 */
import Anthropic from "@anthropic-ai/sdk";
import { env } from "@repo/env";

import { LlmProviderError } from "../errors";
import { priceUsage, type TokenUsage } from "../pricing";
import type { ProviderRequest, ProviderResult } from "./types";

type StreamParams = Anthropic.Beta.Messages.MessageCreateParamsStreaming;

/** The slice of the SDK client this module uses — tests pass a fake. */
export interface AnthropicLike {
  beta: {
    messages: {
      stream(
        params: Omit<StreamParams, "stream">,
        options?: { signal?: AbortSignal; timeout?: number },
      ): { finalMessage(): Promise<Anthropic.Beta.Messages.BetaMessage> };
    };
  };
}

export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Models that accept server-side `fallbacks` (Haiku has none). */
export function supportsFallbacks(model: string): boolean {
  return /^claude-(fable-5|mythos-5|opus-5|sonnet-5-5)/.test(model);
}

/** Models that accept `output_config.effort` (not Haiku 4.5 / Sonnet 4.5 / older). */
export function supportsEffort(model: string): boolean {
  return /^claude-(fable|mythos|opus|sonnet|haiku)-5|^claude-opus-4-[5-8]|^claude-sonnet-4-6/.test(
    model,
  );
}

let client: Anthropic | undefined;
function defaultClient(): AnthropicLike {
  const e = env();
  client ??= new Anthropic({
    apiKey: e.ANTHROPIC_API_KEY,
    ...(e.ANTHROPIC_BASE_URL ? { baseURL: e.ANTHROPIC_BASE_URL } : {}),
  });
  return client;
}

/** The request body. Pure — unit-tested for what must NOT be sent. */
export function buildParams(
  req: ProviderRequest,
): Omit<StreamParams, "stream"> {
  const model = req.route.model;
  const outputConfig: Anthropic.Beta.Messages.BetaOutputConfig = {};
  if (supportsEffort(model)) outputConfig.effort = req.effort;
  if (req.jsonSchema)
    outputConfig.format = { type: "json_schema", schema: req.jsonSchema };
  return {
    model,
    max_tokens: req.maxOutputTokens,
    ...(req.system ? { system: req.system } : {}),
    messages: [{ role: "user", content: req.prompt }],
    ...(Object.keys(outputConfig).length
      ? { output_config: outputConfig }
      : {}),
    // Auto-cache the longest stable prefix; below the minimum size it is a no-op.
    cache_control: { type: "ephemeral" },
    ...(supportsFallbacks(model)
      ? { betas: [FALLBACK_BETA], fallbacks: "default" as const }
      : {}),
  };
}

function usageOf(u: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
}): TokenUsage {
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

/**
 * Cost of a finished message. When a fallback model served the turn, each
 * `usage.iterations` entry is priced at the model that ran it (the declined
 * hop at the requested model, the rescue at the fallback's own rate).
 */
export function messageCost(
  requested: string,
  msg: Anthropic.Beta.Messages.BetaMessage,
): number | null {
  const iterations = msg.usage.iterations ?? [];
  if (!iterations.some((i) => i.type === "fallback_message")) {
    return priceUsage(`anthropic/${requested}`, usageOf(msg.usage));
  }
  let total = 0;
  for (const it of iterations) {
    if (it.type !== "message" && it.type !== "fallback_message") continue;
    const model = it.type === "fallback_message" ? it.model : requested;
    const cost = priceUsage(`anthropic/${model}`, usageOf(it));
    if (cost === null) return null;
    total += cost;
  }
  return Math.round(total * 1e6) / 1e6;
}

/** Typed SDK errors → retryable or not. No message matching. */
export function toProviderError(err: unknown): LlmProviderError {
  const retryable =
    err instanceof Anthropic.RateLimitError ||
    err instanceof Anthropic.InternalServerError ||
    err instanceof Anthropic.APIConnectionError;
  const status =
    err instanceof Anthropic.APIError ? ` ${err.status ?? ""}` : "";
  const message = err instanceof Error ? err.message : String(err);
  return new LlmProviderError(
    `anthropic${status}: ${message.slice(0, 300)}`,
    "anthropic",
    retryable,
    { cause: err },
  );
}

export async function callAnthropic(
  req: ProviderRequest,
  sdk: AnthropicLike = defaultClient(),
): Promise<ProviderResult> {
  let msg: Anthropic.Beta.Messages.BetaMessage;
  try {
    msg = await sdk.beta.messages
      .stream(buildParams(req), req.timeoutMs ? { timeout: req.timeoutMs } : {})
      .finalMessage();
  } catch (err) {
    throw toProviderError(err);
  }

  const text = msg.content
    .filter(
      (b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text",
    )
    .map((b) => b.text)
    .join("");
  const base = {
    text,
    usage: usageOf(msg.usage),
    costUsd: messageCost(req.route.model, msg),
    servedBy: `anthropic/${msg.model}`,
  };
  switch (msg.stop_reason) {
    case "refusal":
      return {
        ...base,
        stop: "refusal",
        refusal: {
          category: msg.stop_details?.category ?? null,
          explanation: msg.stop_details?.explanation ?? null,
        },
      };
    case "max_tokens":
    case "model_context_window_exceeded":
      return { ...base, stop: "max_tokens" };
    default:
      return { ...base, stop: "end" };
  }
}
