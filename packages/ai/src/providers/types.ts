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

// ── tool use (a conversation turn, for agents) ───────────────────────────

/** A tool the model may call. `inputSchema` is JSON Schema (z.toJSONSchema). */
export interface ToolSpec {
  /** `^[a-zA-Z0-9_-]{1,64}$`: Anthropic and OpenAI both reject dots. */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** As the model sent it. NOT validated: the caller validates. */
  input: unknown;
}

export interface ToolResult {
  /** The ToolCall's id. */
  id: string;
  name: string;
  content: string;
  isError?: boolean;
}

/**
 * A provider-neutral conversation. An assistant entry keeps the provider's
 * own content (`native`) so it can be sent back UNCHANGED — Anthropic needs
 * its thinking blocks returned exactly as they came.
 */
export type ChatEntry =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; native?: unknown }
  | { role: "tool"; results: ToolResult[] };

export interface ToolTurnRequest {
  route: Route;
  system?: string;
  transcript: ChatEntry[];
  tools: ToolSpec[];
  maxOutputTokens: number;
  effort: Effort;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * `tool_use`: run `toolCalls` and send their results. `pause`: send the turn
 * back as is (Anthropic `pause_turn`). The rest end the conversation.
 */
export type TurnStop = "end" | "tool_use" | "pause" | "max_tokens" | "refusal";

export interface ToolTurnResult extends Omit<ProviderResult, "stop"> {
  stop: TurnStop;
  toolCalls: ToolCall[];
  /** The assistant entry to append to the transcript. */
  assistant: Extract<ChatEntry, { role: "assistant" }>;
}

export type ProviderTurn = (req: ToolTurnRequest) => Promise<ToolTurnResult>;
