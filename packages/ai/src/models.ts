/**
 * Which provider a model string goes to. Pure apart from reading env().
 *
 *   anthropic/claude-opus-5-5     Anthropic API, official SDK (ANTHROPIC_API_KEY)
 *   openai/gpt-4.1-mini           api.openai.com or OPENAI_BASE_URL
 *   azure/<deployment>            Azure OpenAI; the part after azure/ is the DEPLOYMENT
 *   openrouter/meta-llama/…       OpenRouter; everything after the first / is its id
 *   deepseek/deepseek-chat        DeepSeek's API
 *   local/qwen3:32b               any OpenAI-compatible server at LLM_BASE_URL
 *   cli/claude-sonnet-5-5         headless `claude -p` (or the bridge) — no API key
 *   gpt-4.1-mini                  bare = local/ — what LLM_MODEL meant before the router
 *
 * Only the first segment is the provider, so a model id may contain slashes.
 * An unknown prefix is an ERROR, not a bare name: `antropic/claude-…` must not
 * quietly become a request to LLM_BASE_URL for a model called "antropic/…".
 */
import { env } from "@repo/env";

import { LlmConfigError } from "./errors";

export const PROVIDERS = [
  "anthropic",
  "openai",
  "azure",
  "openrouter",
  "deepseek",
  "local",
  "cli",
] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export type Tier = "fast" | "default" | "smart";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type Priority = "essential" | "discretionary";

export interface Route {
  provider: ProviderId;
  /** The id the provider receives (deployment name for azure). */
  model: string;
  /** Canonical `provider/model` — what llm_call.model records. */
  id: string;
}

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";
const LEGACY_DEFAULT_MODEL = "gpt-4.1-mini";

export function parseModel(value: string): Route {
  const raw = value.trim();
  if (!raw) throw new LlmConfigError("empty model string");
  const slash = raw.indexOf("/");
  if (slash < 0) return { provider: "local", model: raw, id: `local/${raw}` };
  const prefix = raw.slice(0, slash).toLowerCase();
  const model = raw.slice(slash + 1).trim();
  if (!(PROVIDERS as readonly string[]).includes(prefix)) {
    throw new LlmConfigError(
      `unknown provider "${raw.slice(0, slash)}" in model "${raw}" — use one of ` +
        `${PROVIDERS.join(", ")} (a slash-containing id for an OpenAI-compatible ` +
        `server is local/${raw})`,
    );
  }
  if (!model)
    throw new LlmConfigError(`model "${raw}" names a provider but no model`);
  const provider = prefix as ProviderId;
  return { provider, model, id: `${provider}/${model}` };
}

/** LLM_MODEL, else the first sensible default for the keys present. */
export function defaultModel(): string {
  const e = env();
  if (e.LLM_MODEL) return e.LLM_MODEL;
  if (e.ANTHROPIC_API_KEY) return `anthropic/${DEFAULT_ANTHROPIC_MODEL}`;
  return `local/${LEGACY_DEFAULT_MODEL}`;
}

/** The model string for a tier. An unset tier falls back to the default. */
export function modelForTier(tier: Tier = "default"): string {
  const e = env();
  if (tier === "fast" && e.LLM_MODEL_FAST) return e.LLM_MODEL_FAST;
  if (tier === "smart" && e.LLM_MODEL_SMART) return e.LLM_MODEL_SMART;
  return defaultModel();
}

/** Explicit `model` wins over `tier`. */
export function resolve(opts: { model?: string; tier?: Tier }): Route {
  return parseModel(opts.model ?? modelForTier(opts.tier));
}

/**
 * Are this provider's credentials present? A pure env check — no network, no
 * process spawn — so health checks can call it freely. `cli` is trusted when
 * chosen: whether `claude` actually runs is found out by the call, which then
 * fails with an LlmProviderError naming CLAUDE_BIN.
 */
export function providerConfigured(provider: ProviderId): boolean {
  const e = env();
  switch (provider) {
    case "anthropic":
      return Boolean(e.ANTHROPIC_API_KEY);
    case "openai":
      return Boolean(e.OPENAI_API_KEY);
    case "azure":
      return Boolean(e.AZURE_OPENAI_API_KEY && e.AZURE_OPENAI_ENDPOINT);
    case "openrouter":
      return Boolean(e.OPENROUTER_API_KEY);
    case "deepseek":
      return Boolean(e.DEEPSEEK_API_KEY);
    case "local":
      // A keyless local server (Ollama) is configured by pointing the base URL
      // somewhere other than the OpenAI default.
      return (
        Boolean(e.LLM_API_KEY) ||
        e.LLM_BASE_URL.replace(/\/+$/, "") !== "https://api.openai.com/v1"
      );
    case "cli":
      return true;
  }
}

/** Is this route usable right now? */
export function routeEnabled(route: Route): boolean {
  return env().LLM_ENABLED && providerConfigured(route.provider);
}
