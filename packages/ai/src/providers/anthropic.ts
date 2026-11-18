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
import type {
  ChatEntry,
  ProviderRequest,
  ProviderResult,
  ToolCall,
  ToolTurnRequest,
  ToolTurnResult,
} from "./types";

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

/** The prompt, after any images (Anthropic recommends image-then-text). */
function userContent(req: ProviderRequest) {
  if (!req.images?.length) return req.prompt;
  return [
    ...req.images.map((img) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: img.mediaType,
        data: Buffer.from(img.data).toString("base64"),
      },
    })),
    { type: "text" as const, text: req.prompt },
  ];
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
    messages: [{ role: "user", content: userContent(req) }],
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
  // An HTTP error status means the API refused the request: nothing billed.
  // A connection error or timeout may have been billed for unseen output.
  const httpStatus =
    err instanceof Anthropic.APIError &&
    !(err instanceof Anthropic.APIConnectionError)
      ? err.status
      : undefined;
  const answered = typeof httpStatus === "number";
  const status = answered ? ` ${httpStatus}` : "";
  const message = err instanceof Error ? err.message : String(err);
  return new LlmProviderError(
    `anthropic${status}: ${message.slice(0, 300)}`,
    "anthropic",
    retryable,
    { cause: err, costUnknown: !answered },
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

// ── tool use ─────────────────────────────────────────────────────────────

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ContentParam = Anthropic.Beta.Messages.BetaContentBlockParam;

/** The provider-neutral transcript as Anthropic messages. */
export function toAnthropicMessages(transcript: ChatEntry[]): MessageParam[] {
  return transcript.map((entry): MessageParam => {
    switch (entry.role) {
      case "user":
        return { role: "user", content: entry.text };
      case "assistant": {
        // Our own reply comes back exactly as it was sent to us — thinking
        // blocks included, which the API requires unchanged.
        if (entry.native) {
          return { role: "assistant", content: entry.native as ContentParam[] };
        }
        const content: ContentParam[] = [];
        if (entry.text) content.push({ type: "text", text: entry.text });
        for (const c of entry.toolCalls) {
          content.push({
            type: "tool_use",
            id: c.id,
            name: c.name,
            input: c.input as Record<string, unknown>,
          });
        }
        return { role: "assistant", content };
      }
      case "tool":
        // Every result of one turn in ONE user message: splitting them teaches
        // the model to stop making parallel calls.
        return {
          role: "user",
          content: entry.results.map((r) => ({
            type: "tool_result" as const,
            tool_use_id: r.id,
            content: r.content,
            ...(r.isError ? { is_error: true } : {}),
          })),
        };
    }
  });
}

/**
 * The request body for one agent turn. Same rules as buildParams, plus:
 *  - tool_choice is NOT sent (auto): forcing a tool 400s on Opus/Sonnet 5.5,
 *    and an agent must be free to answer without one.
 *  - no `eager_input_streaming`: our tool inputs are a few hundred bytes, and
 *    without it the API validates each input's JSON before returning it, so
 *    finalMessage() cannot reject on a half-parsed input. (Inputs are still
 *    validated against the zod schema by the caller before anything runs.)
 */
export function buildToolParams(
  req: ToolTurnRequest,
): Omit<StreamParams, "stream"> {
  const model = req.route.model;
  return {
    model,
    max_tokens: req.maxOutputTokens,
    ...(req.system ? { system: req.system } : {}),
    messages: toAnthropicMessages(req.transcript),
    tools: req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema:
        t.inputSchema as Anthropic.Beta.Messages.BetaTool.InputSchema,
    })),
    ...(supportsEffort(model) ? { output_config: { effort: req.effort } } : {}),
    // Tools + system are the stable prefix across turns: cache it.
    cache_control: { type: "ephemeral" },
    ...(supportsFallbacks(model)
      ? { betas: [FALLBACK_BETA], fallbacks: "default" as const }
      : {}),
  };
}

/** One agent turn: native tool use through the official SDK. */
export async function callAnthropicTools(
  req: ToolTurnRequest,
  sdk: AnthropicLike = defaultClient(),
): Promise<ToolTurnResult> {
  let msg: Anthropic.Beta.Messages.BetaMessage;
  try {
    msg = await sdk.beta.messages
      .stream(buildToolParams(req), {
        ...(req.timeoutMs ? { timeout: req.timeoutMs } : {}),
        ...(req.signal ? { signal: req.signal } : {}),
      })
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
  const toolCalls: ToolCall[] = msg.content
    .filter(
      (b): b is Anthropic.Beta.Messages.BetaToolUseBlock =>
        b.type === "tool_use",
    )
    .map((b) => ({ id: b.id, name: b.name, input: b.input }));
  const stop: ToolTurnResult["stop"] =
    msg.stop_reason === "tool_use"
      ? "tool_use"
      : msg.stop_reason === "pause_turn"
        ? "pause"
        : msg.stop_reason === "refusal"
          ? "refusal"
          : msg.stop_reason === "max_tokens" ||
              msg.stop_reason === "model_context_window_exceeded"
            ? "max_tokens"
            : "end";
  return {
    text,
    toolCalls,
    usage: usageOf(msg.usage),
    costUsd: messageCost(req.route.model, msg),
    servedBy: `anthropic/${msg.model}`,
    stop,
    ...(stop === "refusal"
      ? {
          refusal: {
            category: msg.stop_details?.category ?? null,
            explanation: msg.stop_details?.explanation ?? null,
          },
        }
      : {}),
    assistant: { role: "assistant", text, toolCalls, native: msg.content },
  };
}
