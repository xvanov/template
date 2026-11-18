/**
 * LLM plumbing — one seam, many providers, every call priced and capped.
 *
 *   const r = await ask({
 *     tier: "fast", priority: "discretionary", purpose: "item.summarize",
 *     organizationId, prompt,
 *   });
 *   r.text; r.servedBy; r.costUsd;
 *
 * The model is CONFIG: a `provider/model` string (see models.ts) chosen by
 * tier in .env, so app code says `tier: "fast"`, never a model id.
 *
 * Every call:
 *  1. is checked against the tenant's daily cap BEFORE sending (budget.ts);
 *  2. is written to `llm_call` — provider, model, tier, priority, tokens incl.
 *     cache reads/writes, USD, latency, ok/error — even when it fails;
 *  3. surfaces refusals and truncation as typed errors (errors.ts) instead of
 *     returning a half answer as if it were whole.
 *
 * askObject() is the structured variant: zod-validated, never repaired, and it
 * never throws for a model-side failure — it returns `{ ok: false, reason }`
 * so the caller routes the case to a human.
 */
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { db } from "@repo/db";
import { env } from "@repo/env";
import { notifyOperator } from "@repo/notify";
import { z } from "zod";

import {
  dbLedger,
  decide,
  startOfUtcDay,
  type Decision,
  type Ledger,
  type LlmCallRow,
} from "./budget";
import {
  LlmBudgetExceededError,
  LlmConfigError,
  LlmDisabledError,
  LlmProviderError,
  LlmRefusalError,
  LlmTruncatedError,
  LlmUnpricedError,
} from "./errors";
import {
  modelForTier,
  parseConfigured,
  parseModel,
  PROVIDERS,
  providerConfigured,
  resolve,
  routeEnabled,
  type Effort,
  type Priority,
  type Route,
  type Tier,
} from "./models";
import {
  estimateUsd,
  priceFor,
  priceUsage,
  ZERO_USAGE,
  type TokenUsage,
} from "./pricing";
import { callAnthropic, callAnthropicTools } from "./providers/anthropic";
import { callCli } from "./providers/cli";
import {
  callOpenAiFamily,
  callOpenAiTools,
  EMBEDDING_PROVIDERS,
  embedOpenAiFamily,
} from "./providers/openai";
import {
  TRANSCRIBE_PROVIDERS,
  transcribeEndpoint,
  transcribeOpenAiCompatible,
  type TranscribeRequest,
  type TranscribeResponse,
} from "./providers/transcribe";
import type {
  ChatEntry,
  ImageInput,
  ProviderCall,
  ProviderResult,
  ProviderTurn,
  ToolCall,
  ToolSpec,
  ToolTurnResult,
} from "./providers/types";

export * from "./errors";
export { assertGrounded, unknownFactsIn, UngroundedOutputError } from "./guard";
export type { UnknownFacts } from "./guard";
export { decide, startOfUtcDay } from "./budget";
export type { Decision, Ledger, LlmCallRow, Reservation } from "./budget";
export { parseModel, PROVIDERS } from "./models";
export type { Effort, Priority, ProviderId, Route, Tier } from "./models";
export { costUsd, parsePrices, priceFor } from "./pricing";
export type { Price, TokenUsage } from "./pricing";
export type {
  ChatEntry,
  ImageInput,
  ProviderTurn,
  ToolCall,
  ToolResult,
  ToolSpec,
  ToolTurnRequest,
  ToolTurnResult,
  TurnStop,
} from "./providers/types";

// ── options and results ──────────────────────────────────────────────────

/**
 * Pre-flight estimate for one image, in prompt characters (~4 per token).
 * Anthropic bills about (width × height) / 750 tokens, capped near 1,600 for
 * an image it downsizes; OpenAI "high" detail is similar. 1,600 tokens ≈ this.
 */
export const IMAGE_ESTIMATE_CHARS = 6_400;

interface CallOptions {
  /** Free-text label for cost attribution, e.g. "item.summarize". */
  purpose: string;
  /** What the daily cap does with this call — see budget.ts. */
  priority: Priority;
  organizationId?: string | null;
  userId?: string | null;
  /** Named tier from .env. Ignored when `model` is given. */
  tier?: Tier;
  /** Explicit `provider/model`. Prefer `tier` in app code. */
  model?: string;
}

export interface AskOptions extends CallOptions {
  prompt: string;
  system?: string;
  /**
   * Images the model looks at (vision). The tier's model must accept images;
   * cli/ models never do (LlmConfigError). Each counts ~IMAGE_ESTIMATE_CHARS
   * toward the pre-flight cap estimate; the real usage is what gets billed.
   */
  images?: ImageInput[];
  /** Default 16000. The cap reserves the FULL allowance — lower it for cheap calls. */
  maxOutputTokens?: number;
  /** Reasoning depth. Default LLM_EFFORT ("medium"). */
  effort?: Effort;
  timeoutMs?: number;
}

export interface CallMeta {
  /** `provider/model` that was requested. */
  model: string;
  /** `provider/model` that answered (differs after an Anthropic fallback). */
  servedBy: string;
  provider: string;
  tier: Tier | null;
  usage: TokenUsage;
  /** 0 when unknown — check costKnown. */
  costUsd: number;
  costKnown: boolean;
  latencyMs: number;
}

export interface AskResult extends CallMeta {
  text: string;
}

export type AskObjectFailure =
  | "disabled"
  | "over_budget"
  | "unpriced"
  | "refusal"
  | "truncated"
  | "invalid_output"
  | "provider_error";

export type AskObjectResult<T> =
  | ({ ok: true; object: T } & CallMeta)
  | {
      ok: false;
      reason: AskObjectFailure;
      /** One line a human reviewer can read. */
      detail: string;
      costUsd: number;
      model: string;
      /** The model's raw reply when there was one — for the reviewer, not for use. */
      rawText?: string;
    };

export interface ConverseOptions extends CallOptions {
  system?: string;
  transcript: ChatEntry[];
  tools: ToolSpec[];
  /** Default 16000 per turn. The cap reserves the FULL allowance. */
  maxOutputTokens?: number;
  effort?: Effort;
  timeoutMs?: number;
  /** Aborts the in-flight request (cancellation). */
  signal?: AbortSignal;
}

export interface ConverseResult extends CallMeta {
  text: string;
  toolCalls: ToolCall[];
  stop: ToolTurnResult["stop"];
  refusal?: { category: string | null; explanation: string | null };
  /** Append this to the transcript before the tool results. */
  assistant: ToolTurnResult["assistant"];
}

export interface EmbedOptions extends Omit<CallOptions, "tier"> {
  texts: string[];
  /**
   * Ask the model for vectors of this length (OpenAI text-embedding-3-* and
   * compatible servers shorten natively). Unset: the model's native size.
   * A model that ignores it and returns another length is refused with
   * LlmConfigError, never stored.
   */
  dimensions?: number;
}

export interface TranscribeOptions extends Omit<CallOptions, "tier"> {
  audio: Uint8Array;
  /** With its extension: servers use it to tell the format (`note.m4a`). */
  filename: string;
  contentType: string;
  /** ISO-639-1 hint ("en"). */
  language?: string;
  /** Vocabulary hint: product names, jargon. */
  prompt?: string;
  timeoutMs?: number;
}

export interface TranscribeResult {
  text: string;
  model: string;
  /** Audio length the server reported; null if it did not. */
  seconds: number | null;
  costUsd: number;
  costKnown: boolean;
  latencyMs: number;
}

/**
 * The LOWEST bitrate (bytes per second) a recording of each type plausibly
 * has, so size / rate is the LONGEST it can be: the pre-send estimate errs
 * long, i.e. high on cost, as a spending control should. Opus (webm/ogg)
 * speech can be ~6 kbit/s, HE-AAC and MP3 ~8; PCM WAV is at least 8 kHz
 * 8-bit mono (64 kbit/s), FLAC about half that. Unknown types use the lowest.
 */
const MIN_BYTES_PER_SECOND: Record<string, number> = {
  "audio/webm": 750,
  "audio/ogg": 750,
  "audio/mp4": 1000,
  "audio/aac": 1000,
  "audio/mpeg": 1000,
  "audio/flac": 4000,
  "audio/wav": 8000,
};

/** The longest a recording of this size and type can be, in seconds. */
export function maxAudioSeconds(bytes: number, contentType: string): number {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  return Math.ceil(bytes / (MIN_BYTES_PER_SECOND[type] ?? 750));
}

export interface EmbedResult {
  embeddings: number[][];
  model: string;
  tokens: number;
  costUsd: number;
  costKnown: boolean;
  latencyMs: number;
}

// ── dependencies (the test seam) ─────────────────────────────────────────

export interface LlmDeps {
  call: ProviderCall;
  /** One tool-use turn (converse). */
  converse: ProviderTurn;
  embed: (
    route: Route,
    texts: string[],
    opts: { dimensions?: number },
  ) => Promise<{ embeddings: number[][]; tokens: number }>;
  transcribe: (
    route: Route,
    req: TranscribeRequest,
  ) => Promise<TranscribeResponse>;
  ledger: Ledger;
  warn: (message: string, data: Record<string, unknown>) => void;
  /** A tenant reached its daily cap. Default: tell the operator, once per org per day. */
  capHit: (info: CapHit) => void;
}

export interface CapHit {
  organizationId: string;
  spentUsd: number;
  capUsd: number;
  purpose: string;
  /** True when a discretionary call was refused; false when an essential one ran over. */
  refused: boolean;
}

/**
 * Tenants already reported today, in this process. notify's dedupe key makes
 * it once per org per day across processes; this memo stops every refused
 * call from writing a "deduped" row on the way. "pending" while the alert is
 * in flight (so concurrent refusals do not each send); it becomes "done" only
 * once notify says the alert was recorded for the operator. Any other outcome
 * (failed, blocked) clears it, so the next refused call tries again.
 */
const capReported = {
  day: "",
  orgs: new Map<string, "pending" | "done">(),
};
/** sent/held/logged: the operator has it. deduped: another process sent it. */
const CAP_ALERT_RECORDED = new Set(["sent", "held", "logged", "deduped"]);

/** The operator hears about a tenant's cap once per tenant per UTC day. */
function notifyCapHit(info: CapHit): void {
  const day = startOfUtcDay().toISOString().slice(0, 10);
  if (capReported.day !== day) {
    capReported.day = day;
    capReported.orgs.clear();
  }
  const org = info.organizationId;
  if (capReported.orgs.has(org)) return;
  capReported.orgs.set(org, "pending");
  const forget = () => {
    if (capReported.day === day) capReported.orgs.delete(org);
  };
  void notifyOperator({
    title: `A tenant reached the daily AI cap ($${info.capUsd})`,
    body: [
      `Organization ${info.organizationId} has spent $${info.spentUsd.toFixed(2)} of its $${info.capUsd} cap today (UTC).`,
      info.refused
        ? "Discretionary AI calls are refused until 00:00 UTC; essential ones still run."
        : "An essential call ran over it (essential calls are never refused).",
      `Triggered by: ${info.purpose}. Raise LLM_DAILY_CAP_USD if this is expected.`,
    ].join("\n"),
    priority: "normal",
    dedupeKey: `ai-cap:${info.organizationId}:${day}`,
    dedupeWindowMinutes: 24 * 60,
    organizationId: info.organizationId,
    tags: ["money_with_wings"],
  }).then((r) => {
    if (!CAP_ALERT_RECORDED.has(r.status)) forget();
    else if (capReported.day === day) capReported.orgs.set(org, "done");
  }, forget);
}

const dispatch: ProviderCall = (req) => {
  switch (req.route.provider) {
    case "anthropic":
      return callAnthropic(req);
    case "cli":
      return callCli(req);
    default:
      return callOpenAiFamily(req);
  }
};

/**
 * Tool use: Anthropic natively through the official SDK, the OpenAI family
 * through the AI SDK. `cli/` (headless `claude -p`) runs Claude Code's own
 * tools, not ours, so it cannot drive an agent here.
 */
const dispatchTurn: ProviderTurn = (req) => {
  switch (req.route.provider) {
    case "anthropic":
      return callAnthropicTools(req);
    case "cli":
      return Promise.reject(
        new LlmConfigError(
          `${req.route.id} cannot call tools: cli/ models do not support tool use. ` +
            "Point the agent's tier (AGENT_TIER) at an anthropic/ or OpenAI-family model.",
        ),
      );
    default:
      return callOpenAiTools(req);
  }
};

const defaultDeps: LlmDeps = {
  call: dispatch,
  converse: dispatchTurn,
  embed: (route, texts, opts) => embedOpenAiFamily(route, texts, opts),
  transcribe: (route, req) => transcribeOpenAiCompatible(route, req),
  ledger: dbLedger,
  warn: (message, data) => console.warn(`[ai] ${message}`, data),
  capHit: notifyCapHit,
};

const errText = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).slice(0, 500);

// ── the engine ───────────────────────────────────────────────────────────

export function createLlm(overrides: Partial<LlmDeps> = {}) {
  const deps: LlmDeps = { ...defaultDeps, ...overrides };

  /**
   * Reserve the call in the ledger (the cap check happens there, under the
   * tenant's lock) or throw the typed refusal. Returns the pending row's id.
   */
  async function reserve(
    opts: CallOptions,
    route: Route,
    row: LlmCallRow,
    estimate: number | null,
  ): Promise<string | null> {
    announceLlmConfig();
    const capUsd = env().LLM_DAILY_CAP_USD;
    const capped =
      opts.organizationId && capUsd !== undefined
        ? { organizationId: opts.organizationId }
        : null;
    const check = (spentUsd: number | null): Decision =>
      decide({
        priority: opts.priority,
        spentUsd,
        estimateUsd: estimate,
        capUsd: capUsd ?? Number.POSITIVE_INFINITY,
      });

    let id: string | null;
    let decision: Decision;
    let spentUsd: number | null;
    try {
      ({ id, decision, spentUsd } = await deps.ledger.reserve(
        row,
        capped,
        check,
      ));
    } catch (err) {
      id = null;
      spentUsd = null;
      decision = capped ? check(null) : { allowed: true, overCap: false };
      deps.warn(
        decision.allowed
          ? "could not reserve the call in llm_call — proceeding unrecorded"
          : "spend unknown — discretionary call refused",
        {
          organizationId: opts.organizationId,
          purpose: opts.purpose,
          error: errText(err),
        },
      );
    }
    // Over the cap by a KNOWN amount (not "spend unknown", not "unpriced").
    if (
      capped &&
      decision.overCap &&
      spentUsd !== null &&
      (decision.allowed || decision.reason === "over_cap")
    ) {
      deps.capHit({
        organizationId: capped.organizationId,
        spentUsd,
        capUsd: capUsd ?? 0,
        purpose: opts.purpose,
        refused: !decision.allowed,
      });
    }
    if (!decision.allowed) {
      if (decision.reason === "unpriced") throw new LlmUnpricedError(route.id);
      throw new LlmBudgetExceededError(spentUsd, estimate ?? 0, capUsd ?? 0);
    }
    if (decision.overCap) {
      deps.warn("essential call over the daily cap — allowed", {
        organizationId: opts.organizationId,
        purpose: opts.purpose,
        model: route.id,
        spentUsd,
        estimateUsd: estimate,
        capUsd,
      });
    }
    return id;
  }

  /** What a failed call is recorded as: unknown cost keeps the estimate. */
  function failedRow(
    row: LlmCallRow,
    err: unknown,
    estimate: number | null,
    latencyMs: number,
  ): LlmCallRow {
    // A config error (cli/ given images or tools, an unwired provider) is
    // thrown before anything is sent: nothing billed, nothing to hold back.
    const costUnknown =
      err instanceof LlmProviderError
        ? err.costUnknown
        : !(err instanceof LlmConfigError);
    return {
      ...row,
      usage: ZERO_USAGE,
      costUsd: costUnknown ? (estimate ?? 0) : 0,
      costKnown: !costUnknown,
      latencyMs,
      ok: false,
      error: errText(err),
      status: "done",
    };
  }

  /**
   * The metering every chat-kind call goes through: enabled check, cap
   * reservation (estimate from `inputChars` + the full output allowance),
   * the provider call, and settling `llm_call` with the real numbers — or
   * with the failure, so "the AI feature is broken" shows up where its spend
   * does.
   */
  async function metered<
    R extends Pick<ProviderResult, "text" | "usage" | "costUsd" | "refusal"> & {
      stop: string;
    },
  >(
    opts: CallOptions,
    inputChars: number,
    maxOutputTokens: number,
    send: (route: Route) => Promise<R>,
    validate?: (result: R) => string | null,
  ): Promise<{ result: R; meta: CallMeta }> {
    const route = resolve(opts);
    if (!routeEnabled(route)) {
      throw new LlmDisabledError(
        env().LLM_ENABLED
          ? `${route.id} is not configured — set its key in .env (see .env.example).`
          : "LLM is switched off (LLM_ENABLED=false).",
      );
    }
    const tier = opts.model ? null : (opts.tier ?? "default");
    const estimate = estimateUsd(route.id, inputChars, maxOutputTokens);

    const row: LlmCallRow = {
      organizationId: opts.organizationId ?? null,
      userId: opts.userId ?? null,
      purpose: opts.purpose,
      model: route.id,
      provider: route.provider,
      tier,
      priority: opts.priority,
      kind: "chat",
      usage: ZERO_USAGE,
      costUsd: estimate ?? 0,
      costKnown: false,
      latencyMs: 0,
      ok: false,
      error: null,
      status: "pending",
    };
    const id = await reserve(opts, route, row, estimate);

    const started = Date.now();
    let result: R;
    try {
      result = await send(route);
    } catch (err) {
      await deps.ledger.settle(
        id,
        failedRow(row, err, estimate, Date.now() - started),
      );
      throw err;
    }

    const latencyMs = Date.now() - started;
    const cost =
      result.costUsd !== undefined
        ? result.costUsd
        : priceUsage(route.id, result.usage);
    const error =
      result.stop === "refusal"
        ? `refusal${result.refusal?.category ? ` (${result.refusal.category})` : ""}`
        : result.stop === "max_tokens"
          ? "max_tokens"
          : validate
            ? validate(result)
            : null;
    await deps.ledger.settle(id, {
      ...row,
      usage: result.usage,
      // Unknown real cost: the estimate stays on the books against the cap.
      costUsd: cost ?? estimate ?? 0,
      costKnown: cost !== null,
      latencyMs,
      ok: error === null,
      error,
      status: "done",
    });
    const meta: CallMeta = {
      model: route.id,
      servedBy: (result as { servedBy?: string }).servedBy ?? route.id,
      provider: route.provider,
      tier,
      usage: result.usage,
      costUsd: cost ?? 0,
      costKnown: cost !== null,
      latencyMs,
    };
    return { result, meta };
  }

  function run(
    opts: AskOptions,
    jsonSchema?: (route: Route) => Record<string, unknown>,
    validate?: (text: string) => string | null,
  ): Promise<{ result: ProviderResult; meta: CallMeta }> {
    const maxOutputTokens = opts.maxOutputTokens ?? 16_000;
    return metered(
      opts,
      (opts.system?.length ?? 0) +
        opts.prompt.length +
        (opts.images?.length ?? 0) * IMAGE_ESTIMATE_CHARS,
      maxOutputTokens,
      (route) =>
        deps.call({
          route,
          ...(opts.system ? { system: opts.system } : {}),
          prompt: opts.prompt,
          ...(opts.images?.length ? { images: opts.images } : {}),
          maxOutputTokens,
          effort: opts.effort ?? env().LLM_EFFORT,
          ...(jsonSchema ? { jsonSchema: jsonSchema(route) } : {}),
          ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        }),
      validate ? (r) => validate(r.text) : undefined,
    );
  }

  /**
   * One turn of a tool-using conversation (packages/agent drives the loop).
   * Capped, recorded and priced like ask(). Unlike ask() it does NOT throw on
   * a refusal or a truncated reply: `stop` says so and the caller ends the
   * conversation. It throws for disabled / over budget / unpriced / provider
   * errors, and LlmConfigError for a provider without tool use (cli/).
   */
  async function converse(opts: ConverseOptions): Promise<ConverseResult> {
    const maxOutputTokens = opts.maxOutputTokens ?? 16_000;
    const inputChars =
      (opts.system?.length ?? 0) +
      JSON.stringify(opts.tools).length +
      transcriptChars(opts.transcript);
    const { result, meta } = await metered(
      opts,
      inputChars,
      maxOutputTokens,
      (route) =>
        deps.converse({
          route,
          ...(opts.system ? { system: opts.system } : {}),
          transcript: opts.transcript,
          tools: opts.tools,
          maxOutputTokens,
          effort: opts.effort ?? env().LLM_EFFORT,
          ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
        }),
    );
    return {
      ...meta,
      text: result.text,
      toolCalls: result.toolCalls,
      stop: result.stop,
      ...(result.refusal ? { refusal: result.refusal } : {}),
      assistant: result.assistant,
    };
  }

  function stopError(result: ProviderResult, meta: CallMeta): Error | null {
    if (result.stop === "refusal") {
      return new LlmRefusalError(
        result.refusal?.category ?? null,
        result.refusal?.explanation ?? null,
        meta.costUsd,
      );
    }
    if (result.stop === "max_tokens")
      return new LlmTruncatedError(result.text, meta.costUsd);
    return null;
  }

  /** One-shot completion, capped, recorded and priced. */
  async function ask(opts: AskOptions): Promise<AskResult> {
    const { result, meta } = await run(opts);
    const stop = stopError(result, meta);
    if (stop) throw stop;
    return { ...meta, text: result.text };
  }

  /**
   * Structured output validated against `schema`. NEVER repairs: no retry
   * with "fix your JSON", no partial acceptance, no coercion. Any failure is
   * `{ ok: false, reason }` for the caller to route to a human. Only a
   * malformed model string (a bug, LlmConfigError) throws.
   */
  async function askObject<S extends z.ZodType>(
    opts: AskOptions & { schema: S },
  ): Promise<AskObjectResult<z.infer<S>>> {
    const { schema, ...rest } = opts;
    const parse = (text: string) => {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return { ok: false as const, detail: "reply is not JSON" };
      }
      const parsed = schema.safeParse(json);
      return parsed.success
        ? { ok: true as const, object: parsed.data }
        : {
            ok: false as const,
            detail: `reply does not match the schema: ${parsed.error.issues
              .slice(0, 3)
              .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
              .join("; ")}`,
          };
    };
    const jsonSchema = (route: Route) => {
      if (route.provider === "anthropic")
        return betaZodOutputFormat(schema).schema;
      // `$schema` names draft 2020-12, which Claude Code's validator rejects;
      // the schema body is plain enough for every validator without it.
      const { $schema: _draft, ...body } = z.toJSONSchema(schema) as Record<
        string,
        unknown
      >;
      return body;
    };

    let model = "";
    try {
      model = resolve(rest).id;
      const { result, meta } = await run(rest, jsonSchema, (text) => {
        const p = parse(text);
        return p.ok ? null : p.detail;
      });
      const stop = stopError(result, meta);
      if (stop) {
        return {
          ok: false,
          reason: stop instanceof LlmRefusalError ? "refusal" : "truncated",
          detail: stop.message,
          costUsd: meta.costUsd,
          model,
          rawText: result.text,
        };
      }
      const p = parse(result.text);
      if (!p.ok) {
        return {
          ok: false,
          reason: "invalid_output",
          detail: p.detail,
          costUsd: meta.costUsd,
          model,
          rawText: result.text,
        };
      }
      return { ok: true, object: p.object as z.infer<S>, ...meta };
    } catch (err) {
      if (err instanceof LlmConfigError) throw err;
      const reason: AskObjectFailure =
        err instanceof LlmDisabledError
          ? "disabled"
          : err instanceof LlmBudgetExceededError
            ? "over_budget"
            : err instanceof LlmUnpricedError
              ? "unpriced"
              : "provider_error";
      return { ok: false, reason, detail: errText(err), costUsd: 0, model };
    }
  }

  /**
   * Embeddings through the same routing (openai/, azure/, local/), capped and
   * priced. Model: `opts.model` or LLM_EMBEDDING_MODEL.
   */
  async function embed(opts: EmbedOptions): Promise<EmbedResult> {
    const modelString = opts.model ?? env().LLM_EMBEDDING_MODEL;
    if (!modelString) {
      throw new LlmDisabledError(
        "Embeddings are off — set LLM_EMBEDDING_MODEL (e.g. openai/text-embedding-3-small).",
      );
    }
    const route = opts.model
      ? parseModel(modelString)
      : parseConfigured(modelString);
    if (!EMBEDDING_PROVIDERS.includes(route.provider)) {
      throw new LlmConfigError(
        `embeddings are not wired for ${route.provider}/ — use ${EMBEDDING_PROVIDERS.join(", ")}`,
      );
    }
    if (!routeEnabled(route)) {
      throw new LlmDisabledError(`${route.id} is not configured.`);
    }
    const dimensions = opts.dimensions;
    const chars = opts.texts.reduce((n, t) => n + t.length, 0);
    const estimate = estimateUsd(route.id, chars, 0);
    const row: LlmCallRow = {
      organizationId: opts.organizationId ?? null,
      userId: opts.userId ?? null,
      purpose: opts.purpose,
      model: route.id,
      provider: route.provider,
      tier: null,
      priority: opts.priority,
      kind: "embed",
      usage: ZERO_USAGE,
      costUsd: estimate ?? 0,
      costKnown: false,
      latencyMs: 0,
      ok: false,
      error: null,
      status: "pending",
    };
    const id = await reserve(opts, route, row, estimate);

    const started = Date.now();
    let r: { embeddings: number[][]; tokens: number };
    try {
      r = await deps.embed(route, opts.texts, { dimensions });
      const wrong =
        dimensions === undefined
          ? undefined
          : r.embeddings.find((v) => v.length !== dimensions);
      if (wrong) {
        throw new LlmConfigError(
          `${route.id} returned ${wrong.length}-dimension embeddings, expected ${dimensions} ` +
            "Use an embedding model that supports that size.",
        );
      }
    } catch (err) {
      await deps.ledger.settle(
        id,
        failedRow(row, err, estimate, Date.now() - started),
      );
      throw err;
    }
    const usage = { ...ZERO_USAGE, inputTokens: r.tokens };
    const cost = priceUsage(route.id, usage);
    const latencyMs = Date.now() - started;
    await deps.ledger.settle(id, {
      ...row,
      usage,
      costUsd: cost ?? estimate ?? 0,
      costKnown: cost !== null,
      latencyMs,
      ok: true,
      error: null,
      status: "done",
    });
    return {
      embeddings: r.embeddings,
      model: route.id,
      tokens: r.tokens,
      costUsd: cost ?? 0,
      costKnown: cost !== null,
      latencyMs,
    };
  }

  /**
   * Speech to text through LLM_TRANSCRIBE_MODEL (or `opts.model`), capped and
   * priced like any call.
   *
   * Before sending, the cap reserves a PER-MINUTE estimate
   * (LLM_TRANSCRIBE_COST_PER_MINUTE x the longest the file can be, see
   * maxAudioSeconds). Without a per-minute rate the call is unpriced, and a
   * capped discretionary call is refused, as for any model.
   *
   * After, the row settles with the best price the answer allows, in order:
   *   1. tokens reported (gpt-4o-*-transcribe) AND a token price for the
   *      model in LLM_PRICES → token price, costKnown
   *   2. duration reported (whisper, local servers) → per-minute, costKnown
   *   3. otherwise → the estimate stays, costKnown=false
   */
  async function transcribe(
    opts: TranscribeOptions,
  ): Promise<TranscribeResult> {
    const modelString = opts.model ?? env().LLM_TRANSCRIBE_MODEL;
    if (!modelString) {
      throw new LlmDisabledError(
        "Transcription is off — set LLM_TRANSCRIBE_MODEL (e.g. openai/gpt-4o-mini-transcribe, azure/<deployment>, or local/<model> on a whisper server).",
      );
    }
    const route = parseModel(modelString);
    if (!TRANSCRIBE_PROVIDERS.includes(route.provider)) {
      throw new LlmConfigError(
        `transcription is not wired for ${route.provider}/ — use ${TRANSCRIBE_PROVIDERS.join(", ")}`,
      );
    }
    if (!env().LLM_ENABLED || !transcribeEndpoint(route).url) {
      throw new LlmDisabledError(`${route.id} is not configured.`);
    }
    const perMinute = env().LLM_TRANSCRIBE_COST_PER_MINUTE;
    const priceSeconds = (seconds: number) =>
      perMinute === undefined
        ? null
        : Math.round((seconds / 60) * perMinute * 1e6) / 1e6;
    const estimate = priceSeconds(
      maxAudioSeconds(opts.audio.byteLength, opts.contentType),
    );
    const row: LlmCallRow = {
      organizationId: opts.organizationId ?? null,
      userId: opts.userId ?? null,
      purpose: opts.purpose,
      model: route.id,
      provider: route.provider,
      tier: null,
      priority: opts.priority,
      kind: "transcribe",
      usage: ZERO_USAGE,
      costUsd: estimate ?? 0,
      costKnown: false,
      latencyMs: 0,
      ok: false,
      error: null,
      status: "pending",
    };
    const id = await reserve(opts, route, row, estimate);

    const started = Date.now();
    let r: TranscribeResponse;
    try {
      r = await deps.transcribe(route, {
        audio: opts.audio,
        filename: opts.filename,
        contentType: opts.contentType,
        language: opts.language,
        prompt: opts.prompt,
        timeoutMs: opts.timeoutMs,
      });
    } catch (err) {
      await deps.ledger.settle(
        id,
        failedRow(row, err, estimate, Date.now() - started),
      );
      throw err;
    }
    const latencyMs = Date.now() - started;
    const usage = r.tokens
      ? {
          ...ZERO_USAGE,
          inputTokens: r.tokens.input,
          outputTokens: r.tokens.output,
        }
      : ZERO_USAGE;
    const cost =
      (r.tokens ? priceUsage(route.id, usage) : null) ??
      (r.seconds !== null ? priceSeconds(r.seconds) : null);
    await deps.ledger.settle(id, {
      ...row,
      usage,
      costUsd: cost ?? estimate ?? 0,
      costKnown: cost !== null,
      latencyMs,
      ok: true,
      error: null,
      status: "done",
    });
    return {
      text: r.text,
      model: route.id,
      seconds: r.seconds,
      costUsd: cost ?? estimate ?? 0,
      costKnown: cost !== null,
      latencyMs,
    };
  }

  return { ask, askObject, embed, converse, transcribe };
}

/** Rough size of a transcript for the pre-send estimate (errs high). */
function transcriptChars(transcript: ChatEntry[]): number {
  let n = 0;
  for (const e of transcript) {
    if (e.role === "user") n += e.text.length;
    else if (e.role === "tool")
      n += e.results.reduce((m, r) => m + r.content.length + 40, 0);
    else n += e.text.length + JSON.stringify(e.toolCalls).length;
  }
  return n;
}

const llm = createLlm();
export const ask = llm.ask;
export const converse = llm.converse;
export const askObject = llm.askObject;
export const embed = llm.embed;
export const transcribe = llm.transcribe;

/** Can transcribe() run right now (model set, provider configured, LLM on)? */
export function transcribeEnabled(): boolean {
  const e = env();
  if (!e.LLM_ENABLED || !e.LLM_TRANSCRIBE_MODEL) return false;
  try {
    const route = parseModel(e.LLM_TRANSCRIBE_MODEL);
    return (
      TRANSCRIBE_PROVIDERS.includes(route.provider) &&
      Boolean(transcribeEndpoint(route).url)
    );
  } catch {
    return false;
  }
}

// ── introspection ────────────────────────────────────────────────────────

/**
 * The configured embedding model as `provider/model` (what embed() records),
 * or null when embeddings are off or misconfigured.
 */
export function embeddingModelId(): string | null {
  const e = env();
  if (!e.LLM_ENABLED || !e.LLM_EMBEDDING_MODEL) return null;
  try {
    const route = parseConfigured(e.LLM_EMBEDDING_MODEL);
    return EMBEDDING_PROVIDERS.includes(route.provider) && routeEnabled(route)
      ? route.id
      : null;
  } catch {
    return null;
  }
}

/** True when the tier's model (default tier if omitted) can be called right now. */
export function llmEnabled(tier: Tier = "default"): boolean {
  try {
    return routeEnabled(resolve({ tier }));
  } catch {
    return false;
  }
}

/**
 * What the AI config will do, as lines worth reading at boot: which model each
 * tier routes to, the cap, and every problem — a model with no price (its
 * discretionary calls are refused while a cap is set), a legacy-mode model
 * string, a string that does not parse.
 */
export function llmConfigReport(): { summary: string; warnings: string[] } {
  const e = env();
  if (!e.LLM_ENABLED)
    return { summary: "[ai] LLM: off (LLM_ENABLED=false)", warnings: [] };
  const warnings: string[] = [];
  const parts: string[] = [];
  for (const tier of ["default", "fast", "smart"] as const) {
    const value = modelForTier(tier);
    try {
      const route = parseConfigured(value);
      parts.push(
        `${tier}=${route.id}${providerConfigured(route.provider) ? "" : " (no key)"}`,
      );
      if (route.legacy) {
        warnings.push(
          `[ai] ${value} is read as a model id on LLM_BASE_URL (legacy). Write local/${value} to say so explicitly.`,
        );
      }
      if (providerConfigured(route.provider) && priceFor(route.id) === null) {
        warnings.push(
          e.LLM_DAILY_CAP_USD !== undefined
            ? `[ai] NO PRICE for ${route.id} (tier ${tier}): its discretionary calls are REFUSED while LLM_DAILY_CAP_USD is set. Add it to LLM_PRICES.`
            : `[ai] NO PRICE for ${route.id} (tier ${tier}): its spend is recorded as unknown. Add it to LLM_PRICES.`,
        );
      }
    } catch (err) {
      warnings.push(`[ai] tier ${tier}: ${errText(err)}`);
    }
  }
  const cap =
    e.LLM_DAILY_CAP_USD === undefined
      ? "NO daily cap (LLM_DAILY_CAP_USD=off)"
      : `cap $${e.LLM_DAILY_CAP_USD}/tenant/UTC day`;
  return {
    summary: `[ai] LLM: ${[...new Set(parts)].join(" · ")} · ${cap}`,
    warnings: [...new Set(warnings)],
  };
}

let announced = false;
/** Print llmConfigReport() once per process. Called at boot and on first use. */
export function announceLlmConfig(): void {
  if (announced) return;
  announced = true;
  try {
    const { summary, warnings } = llmConfigReport();
    console.log(summary);
    for (const w of warnings) console.warn(w);
  } catch (err) {
    console.warn(`[ai] could not read the AI config: ${errText(err)}`);
  }
}

/**
 * What the app will use, safe to render to a SIGNED-IN user: never a key.
 * (Model ids are not for anonymous visitors.)
 */
export function describeLlm() {
  const e = env();
  const tiers = Object.fromEntries(
    (["fast", "default", "smart"] as const).map((t) => {
      try {
        return [t, resolve({ tier: t }).id];
      } catch {
        return [t, modelForTier(t)];
      }
    }),
  ) as Record<Tier, string>;
  return {
    enabled: llmEnabled(),
    tiers,
    embeddingModel: e.LLM_EMBEDDING_MODEL ?? null,
    dailyCapUsd: e.LLM_DAILY_CAP_USD ?? null,
    providers: PROVIDERS.map((id) => ({
      id,
      configured: providerConfigured(id),
    })),
  };
}

/** Spend rollup for a tenant over the last N days (pending reservations included). */
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
