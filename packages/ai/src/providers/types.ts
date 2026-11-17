import type { Effort, Route } from "../models";
import type { TokenUsage } from "../pricing";

/** What every provider is asked to do: one prompt in, one reply out. */
export interface ProviderRequest {
  route: Route;
  system?: string;
  prompt: string;
  maxOutputTokens: number;
  effort: Effort;
  /** JSON Schema the reply must match (structured output). The caller validates. */
  jsonSchema?: Record<string, unknown>;
  timeoutMs?: number;
}

export type StopKind = "end" | "max_tokens" | "refusal";

export interface ProviderResult {
  text: string;
  usage: TokenUsage;
  /**
   * Cost when the provider knows it better than a price table: Claude Code
   * reports `total_cost_usd`; Anthropic fallbacks bill per hop. `undefined` =
   * price `usage` at the route's model. `null` = unknown.
   */
  costUsd?: number | null;
  stop: StopKind;
  refusal?: { category: string | null; explanation: string | null };
  /** `provider/model` that actually answered (differs after a server-side fallback). */
  servedBy: string;
}

export type ProviderCall = (req: ProviderRequest) => Promise<ProviderResult>;
