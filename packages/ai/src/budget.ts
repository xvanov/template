/**
 * The per-tenant daily spend cap — checked BEFORE the request is sent.
 *
 * A post-hoc check reports damage; it does not prevent it. A runaway loop with
 * a post-hoc check spends the whole budget and then complains. So the check
 * runs on an estimate (pricing.estimateUsd: full output allowance) and the
 * refusal beats the socket.
 *
 * Every call declares a priority:
 *  - essential:     keeps the product correct (e.g. classifying an inbound
 *                   message). Never refused — a cap that stops it saves money by
 *                   making the app wrong. Over the cap it is logged, loudly.
 *  - discretionary: speculative or nice-to-have (summaries, suggestions, a
 *                   demo box). Refused with LlmBudgetExceededError once
 *                   spent + estimate would cross LLM_DAILY_CAP_USD.
 *
 * "Daily" is the UTC day: it clears at a fixed boundary, which is easier to
 * reason about mid-incident than a rolling window that frees a few cents at a
 * time. Calls with no organizationId (system jobs) are not capped per tenant.
 *
 * When the spend cannot be read (database down), discretionary work is refused
 * — not knowing what was spent is not a licence to spend more.
 */
import { db } from "@repo/db";

import type { Priority } from "./models";

export interface Decision {
  allowed: boolean;
  /** True when this call takes (or would take) the tenant past the cap. */
  overCap: boolean;
}

/** The rule. Pure. `spentUsd` null = unknown. */
export function decide(args: {
  priority: Priority;
  spentUsd: number | null;
  estimateUsd: number;
  capUsd: number;
}): Decision {
  const spent = args.spentUsd ?? Number.POSITIVE_INFINITY;
  const overCap = spent + Math.max(0, args.estimateUsd) > args.capUsd;
  if (args.priority === "essential") return { allowed: true, overCap };
  return { allowed: !overCap, overCap };
}

/** Midnight UTC of the day `now` falls in. */
export function startOfUtcDay(now: Date = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/** Dollars this tenant has spent on LLM calls since midnight UTC. */
export async function spentTodayUsd(
  organizationId: string,
  now: Date = new Date(),
): Promise<number> {
  const agg = await db.llmCall.aggregate({
    where: { organizationId, createdAt: { gte: startOfUtcDay(now) } },
    _sum: { costUsd: true },
  });
  return agg._sum.costUsd ?? 0;
}
