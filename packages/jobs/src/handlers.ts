/**
 * The job registry: name → scope + payload schema + handler.
 *
 * Adding a job means adding one entry here. The worker needs no edit, the
 * producer gets type safety from `JobPayloads`, and an unknown job name fails
 * loudly instead of being silently dropped.
 *
 * `scope` says who owns the job's runs in `job_run`, and the compiler holds
 * it to the schema (see `ScopeOf`):
 *   "org"     the tenant named by the payload's `organizationId`, which the
 *             schema must declare as a required string.
 *   "system"  nobody; never shown to a tenant. The schema must not declare
 *             `organizationId`, and the worker rejects payloads that carry one.
 */
import { z } from "zod";
import { abandonStaleRuns, executeRun } from "@repo/agent"; // @module:agent
import { db } from "@repo/db";
import { env } from "@repo/env"; // @module:ml
import { markInboundFailed, processInbound } from "@repo/inbound"; // @module:inbound
import { runOperatorTick } from "@repo/notify";
// @module:push-mobile
import {
  checkMobilePushReceipts,
  mobilePushEnabled,
  notifyAppEvent,
  type AppEvent,
} from "@repo/push-mobile";
// @end
import { ingestDocument, markIngestFailed, sweepStaleIngests } from "@repo/rag"; // @module:rag
import { reconcileSmsDelivery } from "@repo/sms"; // @module:sms

import { predictItems } from "./ml"; // @module:ml
import { enqueue } from "./queue"; // @module:push-mobile|inbound
// @module:ai
import {
  ask,
  LlmBudgetExceededError,
  LlmDisabledError,
  llmEnabled,
  LlmUnpricedError,
} from "@repo/ai";
// @end

const schemas = {
  /** Demo job: summarise a tenant's open items with the LLM. */
  "items.summarize": z.object({
    organizationId: z.string().min(1),
    userId: z.string().optional(),
  }),

  // @module:agent
  /** Execute one agent run (packages/agent). Started by `agent.start`. */
  "agent.run": z.object({
    organizationId: z.string().min(1),
    runId: z.string().min(1),
  }),
  // @end

  // @module:ml
  /**
   * Example of the Python bridge (./ml.ts): score a tenant's open items with
   * the toy model trained in ml/. Needs ML_ENABLED and `cd ml && uv run train`.
   */
  "ml.predict": z.object({
    organizationId: z.string().min(1),
  }),
  // @end

  // @module:rag
  /** Chunk + embed one document (packages/rag). Idempotent by content hash. */
  "docs.ingest": z.object({
    organizationId: z.string().min(1),
    documentId: z.string().min(1),
    /** Rebuild even if the content hash says nothing changed. */
    force: z.boolean().optional(),
  }),
  // @end

  // @module:inbound
  /**
   * Finish an inbound message the webhook stored (packages/inbound): fetch
   * its content, attachments into storage, thread it. Idempotent.
   */
  "inbound.process": z.object({
    organizationId: z.string().min(1),
    inboundMessageId: z.string().min(1),
  }),
  // @end

  // @module:push-mobile
  /**
   * Push "something wants you" to the app (packages/push-mobile): a pending
   * proposal or a new inbound message. Queued by `queueAppPush`; one job per
   * event (job id), and the outbound idempotency key per device makes a
   * retry send nothing twice.
   */
  "push.notify": z.object({
    organizationId: z.string().min(1),
    kind: z.enum([
      "item",
      "proposal", // @module:agent
      "inbound", // @module:inbound
    ]),
    id: z.string().min(1),
  }),

  /** Expo push receipts: record delivery, disable uninstalled devices (every 15 min). */
  "push.receipts": z.object({}),
  // @end

  // @module:sms
  /** Ask Twilio about texts whose delivery status never arrived (every 30 min). */
  "sms.reconcile": z.object({}),
  // @end

  /** Demo scheduled job: prune soft state and log a heartbeat. */
  "maintenance.nightly": z.object({}),

  /** The 15-minute operator tick: retry cap-held alerts, send a due digest, fail stuck agent runs. */
  "operator.digest": z.object({}),
  /** Demo job: something a webhook or a UI action would fire. */
  "notify.digest": z.object({
    organizationId: z.string().min(1),
    email: z.string().email(),
  }),
} as const;

export type JobName = keyof typeof schemas;
export type JobPayloads = { [K in JobName]: z.infer<(typeof schemas)[K]> };

/**
 * The only scope a schema admits: "org" iff its payload has a required string
 * `organizationId`, "system" iff it has none. Anything else (an optional or
 * non-string `organizationId`) is `never`, so the entry does not compile.
 */
export type ScopeOf<S extends z.ZodType> = ScopeOfPayload<z.infer<S>>;
type ScopeOfPayload<T> =
  // `z.object({})` infers as Record<string, never>: no fields, so no tenant.
  string extends keyof T
    ? "system"
    : T extends { organizationId: string }
      ? "org"
      : "organizationId" extends keyof T
        ? never
        : "system";

export interface JobEntry<S extends z.ZodType> {
  scope: ScopeOf<S>;
  schema: S;
  run: (payload: z.infer<S>) => Promise<unknown>;
  /**
   * Optional: called once when a run has failed for good (retries used up),
   * to leave the job's own records in a final state. Must not throw.
   */
  onFinalFailure?: (payload: z.infer<S>, err: Error) => Promise<void>;
}

export const handlers: { [N in JobName]: JobEntry<(typeof schemas)[N]> } = {
  "items.summarize": {
    scope: "org",
    schema: schemas["items.summarize"],
    run: async ({ organizationId, userId }) => {
      const items = await db.item.findMany({
        where: { organizationId, done: false },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { title: true, notes: true },
      });
      if (items.length === 0) return { summary: "Nothing open." };
      let result: { summary: string; costUsd?: number } = {
        summary: `${items.length} open items.`,
      };
      // @module:ai
      result = await summarizeWithLlm(items, organizationId, userId);
      // @end
      return result;
    },
  },

  // @module:agent
  "agent.run": {
    scope: "org",
    schema: schemas["agent.run"],
    // Never throws for a run that went wrong (that is recorded on agent_run),
    // and a redelivered job finds the run already claimed: no double runs.
    run: async (payload) => {
      const outcome = await executeRun(payload);
      // @module:push-mobile
      // Its proposals wait for a person: tell their phone.
      const pending = await db.agentProposal.findMany({
        where: {
          organizationId: payload.organizationId,
          runId: payload.runId,
          status: "pending",
        },
        select: { id: true },
      });
      for (const p of pending) {
        await queueAppPush(payload.organizationId, {
          kind: "proposal",
          id: p.id,
        });
      }
      // @end
      return outcome;
    },
  },
  // @end

  // @module:ml
  "ml.predict": {
    scope: "org",
    schema: schemas["ml.predict"],
    run: async ({ organizationId }) => {
      // Off is an outcome, not a failure: no retries, no operator page.
      if (!env().ML_ENABLED) return { skipped: "ML_ENABLED is off" };
      const items = await db.item.findMany({
        where: { organizationId, done: false },
        orderBy: { createdAt: "desc" },
        take: 200,
        select: { id: true, title: true, notes: true },
      });
      if (items.length === 0) return { scored: 0 };
      // "No model trained yet" comes back as ok:false: recorded, not retried.
      // A crash or a timeout throws (MlProcessError) and the job retries.
      const res = await predictItems(items);
      if (!res.ok) {
        console.warn(`[ml] predict org=${organizationId}: ${res.reason}`);
        return { scored: 0, reason: res.reason };
      }
      const urgent = res.predictions.filter((p) => p.urgent).length;
      console.log(
        `[ml] predict org=${organizationId} model=${res.model.run_id} items=${res.predictions.length} urgent=${urgent}`,
      );
      // An example: the result is the job's return value. A real feature
      // stores it (its own table, written in a transaction with the org in
      // the where) and shows it in the app.
      return {
        scored: res.predictions.length,
        urgent,
        model: res.model.run_id,
      };
    },
  },
  // @end

  // @module:rag
  "docs.ingest": {
    scope: "org",
    schema: schemas["docs.ingest"],
    // AI off / over budget is not a failure: the document is indexed for
    // keyword search and says why. A bad input (not UTF-8 text, the file is
    // gone) is the user's to fix: recorded on the document, shown in the app,
    // and returned — not thrown, which would retry it and page the operator.
    // Only unexpected errors (database down) throw.
    run: (payload) => ingestDocument(payload),
    // An unexpected error (database blip, storage down) that outlived the
    // retries: the document must not stay "indexing" forever.
    onFinalFailure: (payload, err) => markIngestFailed(payload, err),
  },
  // @end

  // @module:inbound
  "inbound.process": {
    scope: "org",
    schema: schemas["inbound.process"],
    run: async (payload) => {
      const result = await processInbound(payload);
      // @module:push-mobile
      if (result.status === "processed") {
        await queueAppPush(payload.organizationId, {
          kind: "inbound",
          id: payload.inboundMessageId,
        });
      }
      // @end
      return result;
    },
    // Retries used up (Resend unreachable for minutes, storage down): the
    // row shows "failed" and why, instead of "received" forever.
    onFinalFailure: (payload, err) => markInboundFailed(payload, err),
  },
  // @end

  // @module:push-mobile
  "push.notify": {
    scope: "org",
    schema: schemas["push.notify"],
    run: ({ organizationId, kind, id }) =>
      notifyAppEvent(organizationId, { kind, id }),
  },
  // @end

  // @module:push-mobile
  "push.receipts": {
    scope: "system",
    schema: schemas["push.receipts"],
    run: () => checkMobilePushReceipts(),
  },
  // @end

  // @module:sms
  "sms.reconcile": {
    scope: "system",
    schema: schemas["sms.reconcile"],
    run: () => reconcileSmsDelivery(),
  },
  // @end

  "maintenance.nightly": {
    scope: "system",
    schema: schemas["maintenance.nightly"],
    run: async () => {
      // Bound the durable job history so this table cannot grow forever.
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const { count } = await db.jobRun.deleteMany({
        where: {
          createdAt: { lt: cutoff },
          status: { in: ["completed", "failed", "skipped"] },
        },
      });
      // Operator notifications: 90 days, except any still waiting for a digest.
      const notifications = await db.notification.deleteMany({
        where: {
          createdAt: { lt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
          status: { not: "held" },
        },
      });
      return { prunedJobRuns: count, prunedNotifications: notifications.count };
    },
  },

  "operator.digest": {
    scope: "system",
    schema: schemas["operator.digest"],
    // Due-ness is decided inside (NOTIFY_DIGEST_TIMES in APP_TIMEZONE): most
    // ticks retry nothing and find no digest due. The same tick sweeps up work
    // a lost job left in flight, so it shows as failed within ~15 minutes, not
    // the next night.
    run: async () => {
      // @module:agent
      // Agent runs a dead worker left "running" (past runCutoffMs()).
      const abandonedAgentRuns = await abandonStaleRuns(db);
      // @end
      // @module:rag
      // Documents a lost docs.ingest job left "indexing" for over an hour.
      const abandonedIngests = await sweepStaleIngests();
      // @end
      // @module:inbound
      // Inbound messages whose job was never queued (Redis was down
      // when the webhook stored them).
      const requeuedInbound = await requeueStuckInbound();
      // @end
      return {
        ...(await runOperatorTick()),
        abandonedAgentRuns, // @module:agent
        abandonedIngests, // @module:rag
        requeuedInbound, // @module:inbound
      };
    },
  },
  "notify.digest": {
    scope: "org",
    schema: schemas["notify.digest"],
    run: async ({ organizationId, email }) => {
      const open = await db.item.count({
        where: { organizationId, done: false },
      });
      // Wire your email provider here (Resend / SES / SendGrid). Logging keeps
      // the template runnable without an account, and makes the seam obvious.
      console.log(`[jobs] digest → ${email}: ${open} open item(s)`);
      return { email, open, sent: false };
    },
  },
};

// @module:ai
/** The LLM half of items.summarize. AI off or over budget is an outcome, not a failure. */
async function summarizeWithLlm(
  items: { title: string; notes: string | null }[],
  organizationId: string,
  userId: string | undefined,
): Promise<{ summary: string; costUsd?: number }> {
  const fallback = (why: string) => ({
    summary: `${items.length} open items (${why}).`,
  });
  if (!llmEnabled("fast")) return fallback("LLM disabled");
  try {
    const result = await ask({
      purpose: "items.summarize",
      tier: "fast",
      // A summary is nice to have: it stops at the tenant's daily cap.
      priority: "discretionary",
      organizationId,
      userId,
      maxOutputTokens: 2048,
      effort: "low",
      system: "You summarise task lists in two sentences. Be concrete.",
      prompt: items
        .map((i) => `- ${i.title}${i.notes ? `: ${i.notes}` : ""}`)
        .join("\n"),
    });
    return { summary: result.text, costUsd: result.costUsd };
  } catch (err) {
    // Expected states, not failures: the job still produces a summary.
    if (err instanceof LlmBudgetExceededError)
      return fallback("daily AI budget reached");
    if (err instanceof LlmUnpricedError)
      return fallback("AI model has no price configured");
    if (err instanceof LlmDisabledError) return fallback("LLM disabled");
    throw err;
  }
}
// @end

// @module:push-mobile
/**
 * Queue a mobile push about an event (push.notify). Never throws: a push is
 * a courtesy, and the work that produced the event (an agent run, an inbound
 * message) must not fail or retry because Redis hiccuped. A no-op while
 * mobile push is off, so the template queues nothing by default.
 */
export async function queueAppPush(
  organizationId: string,
  event: AppEvent,
): Promise<void> {
  if (!mobilePushEnabled()) return;
  try {
    // Bounded: the queue's Redis client waits for a connection rather than
    // failing, and this can run inside a user's request.
    await Promise.race([
      enqueue(
        "push.notify",
        { organizationId, ...event },
        { jobId: `push-${event.kind}-${event.id}` },
      ),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("queue timeout (3s)")), 3000).unref(),
      ),
    ]);
  } catch (err) {
    console.error(
      `[push-mobile] could not queue a push for ${event.kind} ${event.id}:`,
      err,
    );
  }
}
// @end

// @module:inbound
/**
 * Inbound messages still "received" 10 minutes after arriving: their
 * `inbound.process` job was never queued or was lost. Queue them again; the
 * job id makes this a no-op for one that is merely still waiting.
 */
async function requeueStuckInbound(): Promise<number> {
  const now = Date.now();
  const stuck = await db.inboundMessage.findMany({
    where: {
      status: "received",
      createdAt: {
        lt: new Date(now - 10 * 60_000),
        gt: new Date(now - 7 * 24 * 3_600_000),
      },
    },
    orderBy: { createdAt: "asc" },
    take: 100,
    select: { id: true, organizationId: true },
  });
  for (const m of stuck) {
    await enqueue(
      "inbound.process",
      { organizationId: m.organizationId, inboundMessageId: m.id },
      { jobId: `inbound-${m.id}` },
    );
  }
  return stuck.length;
}
// @end

export function isJobName(name: string): name is JobName {
  return name in handlers;
}
