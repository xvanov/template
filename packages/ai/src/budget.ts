/**
 * The per-tenant daily spend cap — enforced BEFORE the request is sent, and
 * safe under concurrency.
 *
 * A post-hoc check reports damage; it does not prevent it. And a check that
 * reads the day's total and then sends lets twenty concurrent calls all read
 * the same total and all go. So every call RESERVES first: under a per-tenant
 * Postgres advisory lock, read today's total (pending reservations included),
 * decide, and insert this call's row as `pending` with its estimated cost
 * (pricing.estimateUsd: ~4 chars/token in, the full output allowance out).
 * The lock is released; the provider is called; the row is then settled with
 * the real cost. The estimate errs high on purpose — refusing slightly early
 * is the right direction of error for a spending control.
 *
 * Every call declares a priority:
 *  - essential:     keeps the product correct (e.g. classifying an inbound
 *                   message). Never refused — a cap that stops it saves money by
 *                   making the app wrong. Over the cap it is logged, loudly.
 *  - discretionary: speculative or nice-to-have (summaries, suggestions, a
 *                   demo box). Refused once spent + estimate would cross the
 *                   cap, and refused outright on a model with no known price
 *                   (a cap that cannot price a call cannot cap it).
 *
 * The cap is LLM_DAILY_CAP_USD per tenant per UTC day: it resets at 00:00 UTC,
 * a fixed boundary that is easy to reason about mid-incident. Unset = no cap.
 * Calls with no organizationId (system jobs) are not capped.
 *
 * When the ledger cannot be reached (database down), discretionary work is
 * refused while a cap is set — not knowing what was spent is not a licence to
 * spend more — and essential work proceeds, unrecorded, with a warning.
 */
import { db } from "@repo/db";

import type { Priority } from "./models";
import type { TokenUsage } from "./pricing";

export interface Decision {
  allowed: boolean;
  /** True when this call takes (or would take) the tenant past the cap. */
  overCap: boolean;
  /** Why a refused call was refused. */
  reason?: "over_cap" | "unpriced" | "spend_unknown";
}

/**
 * The rule. Pure. `spentUsd` null = unknown; `estimateUsd` null = the model
 * has no known price.
 */
export function decide(args: {
  priority: Priority;
  spentUsd: number | null;
  estimateUsd: number | null;
  capUsd: number;
}): Decision {
  const spent = args.spentUsd ?? Number.POSITIVE_INFINITY;
  const overCap = spent + Math.max(0, args.estimateUsd ?? 0) > args.capUsd;
  if (args.priority === "essential") return { allowed: true, overCap };
  if (args.spentUsd === null)
    return { allowed: false, overCap, reason: "spend_unknown" };
  if (args.estimateUsd === null)
    return { allowed: false, overCap, reason: "unpriced" };
  return overCap
    ? { allowed: false, overCap, reason: "over_cap" }
    : { allowed: true, overCap };
}

/** Midnight UTC of the day `now` falls in. */
export function startOfUtcDay(now: Date = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/** One `llm_call` row, as the engine sees it. */
export interface LlmCallRow {
  organizationId: string | null;
  userId: string | null;
  purpose: string;
  model: string;
  provider: string;
  tier: string | null;
  priority: Priority;
  kind: "chat" | "embed";
  usage: TokenUsage;
  costUsd: number;
  costKnown: boolean;
  latencyMs: number;
  ok: boolean;
  error: string | null;
  status: "pending" | "done";
}

export interface Reservation {
  /** The pending row's id; null when the call was refused. */
  id: string | null;
  decision: Decision;
  spentUsd: number | null;
}

/** Where calls are reserved and settled. The engine's only storage seam. */
export interface Ledger {
  /**
   * With `capped`: under the tenant's lock, read today's spend (pending rows
   * included), ask `check`, and insert `row` only if allowed. Without: insert.
   */
  reserve(
    row: LlmCallRow,
    capped: { organizationId: string } | null,
    check: (spentUsd: number) => Decision,
  ): Promise<Reservation>;
  /** Final numbers for a reserved row; inserts when there is no id. Never throws. */
  settle(id: string | null, row: LlmCallRow): Promise<void>;
}

function toData(row: LlmCallRow) {
  return {
    organizationId: row.organizationId,
    userId: row.userId,
    purpose: row.purpose,
    model: row.model,
    provider: row.provider,
    tier: row.tier,
    priority: row.priority,
    kind: row.kind,
    inputTokens: row.usage.inputTokens,
    outputTokens: row.usage.outputTokens,
    cacheReadTokens: row.usage.cacheReadTokens,
    cacheWriteTokens: row.usage.cacheWriteTokens,
    costUsd: row.costUsd,
    costKnown: row.costKnown,
    latencyMs: row.latencyMs,
    ok: row.ok,
    error: row.error,
    status: row.status,
  };
}

/** The Postgres ledger: `llm_call` plus a per-tenant advisory lock. */
export const dbLedger: Ledger = {
  async reserve(row, capped, check) {
    if (!capped) {
      const r = await db.llmCall.create({
        data: toData(row),
        select: { id: true },
      });
      return {
        id: r.id,
        decision: { allowed: true, overCap: false },
        spentUsd: null,
      };
    }
    return db.$transaction(async (tx) => {
      // Serialises reservations for ONE tenant; released at commit. Other
      // tenants, and the provider calls themselves, never wait on it.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`llm_cap:${capped.organizationId}`}, 0))`;
      const agg = await tx.llmCall.aggregate({
        where: {
          organizationId: capped.organizationId,
          createdAt: { gte: startOfUtcDay() },
        },
        _sum: { costUsd: true },
      });
      const spentUsd = agg._sum.costUsd ?? 0;
      const decision = check(spentUsd);
      if (!decision.allowed) return { id: null, decision, spentUsd };
      const r = await tx.llmCall.create({
        data: toData(row),
        select: { id: true },
      });
      return { id: r.id, decision, spentUsd };
    });
  },

  async settle(id, row) {
    // Accounting must never take down the feature it is measuring.
    try {
      if (id) await db.llmCall.update({ where: { id }, data: toData(row) });
      else await db.llmCall.create({ data: toData(row) });
    } catch (err) {
      console.error("[ai] failed to record llm_call:", err);
    }
  },
};
