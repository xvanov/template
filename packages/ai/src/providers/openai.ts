/**
 * OpenAI, Azure OpenAI, OpenRouter, DeepSeek and any OpenAI-compatible server
 * (local/) — through the Vercel AI SDK.
 *
 * openai/ and azure/ use the OFFICIAL @ai-sdk/openai and @ai-sdk/azure
 * providers, not the generic compatible one. That is load-bearing: the
 * generic provider always sends `max_tokens`, which Azure and OpenAI reject
 * for reasoning models (gpt-5.x, o-series: "Use 'max_completion_tokens'
 * instead"). The official providers detect a reasoning model from its id and
 * send `max_completion_tokens`, drop unsupported sampling params, and emit
 * strict `json_schema` response formats. @ai-sdk/azure was chosen over the
 * `openai` package's AzureOpenAI client because this package already speaks
 * AI SDK for the other four providers: one usage shape, one error shape.
 *
 * Azure deployment names are not model ids, so a deployment called "prod-chat"
 * that runs gpt-5 is not detected as a reasoning model by name. Name
 * deployments after the model (the Azure default) or expect max_tokens.
 */
import { createAzure } from "@ai-sdk/azure";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { env } from "@repo/env";
import {
  APICallError,
  embedMany,
  generateText,
  jsonSchema,
  NoObjectGeneratedError,
  Output,
  type EmbeddingModel,
  type LanguageModel,
  type LanguageModelUsage,
} from "ai";

import { LlmConfigError, LlmProviderError } from "../errors";
import type { Effort, ProviderId, Route } from "../models";
import type { TokenUsage } from "../pricing";
import type { ProviderRequest, ProviderResult } from "./types";

const OPENROUTER_URL = "https://openrouter.ai/api/v1";
const DEEPSEEK_URL = "https://api.deepseek.com/v1";

function azure() {
  const e = env();
  const endpoint = (e.AZURE_OPENAI_ENDPOINT ?? "")
    .replace(/\/+$/, "")
    .replace(/\/openai(\/v1)?$/, "");
  const dated =
    e.AZURE_OPENAI_API_VERSION && e.AZURE_OPENAI_API_VERSION !== "v1";
  return createAzure({
    baseURL: `${endpoint}/openai`,
    apiKey: e.AZURE_OPENAI_API_KEY,
    // A dated api-version means the classic deployment-scoped URL:
    // {endpoint}/openai/deployments/{deployment}/chat/completions?api-version=…
    // Otherwise the v1 surface: {endpoint}/openai/v1/chat/completions.
    ...(dated
      ? { apiVersion: e.AZURE_OPENAI_API_VERSION, useDeploymentBasedUrls: true }
      : {}),
  });
}

function compatible(name: string, baseURL: string, apiKey?: string) {
  return createOpenAICompatible({
    name,
    baseURL,
    ...(apiKey ? { apiKey } : {}),
    includeUsage: true,
    supportsStructuredOutputs: true,
  });
}

/** The chat model for a route. Built per call so a rotated key applies at once. */
export function chatModel(route: Route): LanguageModel {
  const e = env();
  switch (route.provider) {
    case "openai":
      return createOpenAI({
        apiKey: e.OPENAI_API_KEY,
        ...(e.OPENAI_BASE_URL ? { baseURL: e.OPENAI_BASE_URL } : {}),
      }).chat(route.model);
    case "azure":
      return azure().chat(route.model);
    case "openrouter":
      return compatible(
        "openrouter",
        OPENROUTER_URL,
        e.OPENROUTER_API_KEY,
      )(route.model);
    case "deepseek":
      return compatible(
        "deepseek",
        DEEPSEEK_URL,
        e.DEEPSEEK_API_KEY,
      )(route.model);
    case "local":
      return compatible(
        "local",
        e.LLM_BASE_URL,
        e.LLM_API_KEY || undefined,
      )(route.model);
    default:
      throw new LlmConfigError(`${route.provider} is not an AI SDK provider`);
  }
}

export const EMBEDDING_PROVIDERS: ProviderId[] = ["openai", "azure", "local"];

export function embeddingModel(route: Route): EmbeddingModel {
  const e = env();
  switch (route.provider) {
    case "openai":
      return createOpenAI({
        apiKey: e.OPENAI_API_KEY,
        ...(e.OPENAI_BASE_URL ? { baseURL: e.OPENAI_BASE_URL } : {}),
      }).embedding(route.model);
    case "azure":
      return azure().embedding(route.model);
    case "local":
      return compatible(
        "local",
        e.LLM_BASE_URL,
        e.LLM_API_KEY || undefined,
      ).embeddingModel(route.model);
    default:
      throw new LlmConfigError(
        `embeddings are not wired for ${route.provider}/ — use one of ${EMBEDDING_PROVIDERS.join(", ")}`,
      );
  }
}

export function usageOf(u: LanguageModelUsage | undefined): TokenUsage {
  const cacheRead = u?.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWrite = u?.inputTokenDetails?.cacheWriteTokens ?? 0;
  const uncached =
    u?.inputTokenDetails?.noCacheTokens ??
    Math.max(0, (u?.inputTokens ?? 0) - cacheRead - cacheWrite);
  return {
    inputTokens: uncached,
    outputTokens: u?.outputTokens ?? 0,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
}

/** OpenAI reasoning effort has no xhigh/max on every model; cap at high. */
function reasoningEffort(effort: Effort): "low" | "medium" | "high" {
  return effort === "low" || effort === "medium" ? effort : "high";
}

export function toProviderError(
  err: unknown,
  provider: string,
): LlmProviderError {
  const status = APICallError.isInstance(err) ? err.statusCode : undefined;
  const retryable = APICallError.isInstance(err)
    ? err.isRetryable
    : !(err instanceof LlmConfigError);
  const message = err instanceof Error ? err.message : String(err);
  return new LlmProviderError(
    `${provider}${status ? ` ${status}` : ""}: ${message.slice(0, 300)}`,
    provider,
    retryable,
    // An HTTP error status = refused, nothing billed; anything else (abort,
    // dropped connection) may have been billed for output we never saw.
    { cause: err, costUnknown: status === undefined },
  );
}

/** The seam tests replace: AI SDK's generateText. */
export type GenerateTextFn = typeof generateText;

export async function callOpenAiFamily(
  req: ProviderRequest,
  generate: GenerateTextFn = generateText,
): Promise<ProviderResult> {
  const { route } = req;
  const isReasoningCapable =
    route.provider === "openai" || route.provider === "azure";
  try {
    const result = await generate({
      model: chatModel(route),
      ...(req.system ? { system: req.system } : {}),
      prompt: req.prompt,
      maxOutputTokens: req.maxOutputTokens,
      ...(req.timeoutMs
        ? { abortSignal: AbortSignal.timeout(req.timeoutMs) }
        : {}),
      ...(req.jsonSchema
        ? { output: Output.object({ schema: jsonSchema(req.jsonSchema) }) }
        : {}),
      ...(isReasoningCapable && /^(gpt-5|o\d)/i.test(route.model)
        ? {
            providerOptions: {
              openai: { reasoningEffort: reasoningEffort(req.effort) },
            },
          }
        : {}),
    });
    const stop =
      result.finishReason === "length"
        ? "max_tokens"
        : result.finishReason === "content-filter"
          ? "refusal"
          : "end";
    return {
      text: result.text,
      usage: usageOf(result.usage),
      stop,
      ...(stop === "refusal"
        ? { refusal: { category: "content_filter", explanation: null } }
        : {}),
      servedBy: route.id,
    };
  } catch (err) {
    // The model answered but not in the schema: hand the raw text back so the
    // caller's validation fails the same way for every provider (and the
    // tokens it burned are still recorded).
    if (NoObjectGeneratedError.isInstance(err)) {
      return {
        text: err.text ?? "",
        usage: usageOf(err.usage),
        stop: err.finishReason === "length" ? "max_tokens" : "end",
        servedBy: route.id,
      };
    }
    throw toProviderError(err, route.provider);
  }
}

export type EmbedManyFn = typeof embedMany;

export async function embedOpenAiFamily(
  route: Route,
  texts: string[],
  embed: EmbedManyFn = embedMany,
): Promise<{ embeddings: number[][]; tokens: number }> {
  try {
    const result = await embed({ model: embeddingModel(route), values: texts });
    return { embeddings: result.embeddings, tokens: result.usage.tokens };
  } catch (err) {
    throw toProviderError(err, route.provider);
  }
}
