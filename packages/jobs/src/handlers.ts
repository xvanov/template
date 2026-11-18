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
import { abandonStaleRuns, executeRun } from "@repo/agent";
import { db } from "@repo/db";
import { runOperatorTick } from "@repo/notify";
import { ingestDocument, markIngestFailed, sweepStaleIngests } from "@repo/rag";
import {
  ask,
  LlmBudgetExceededError,
  LlmDisabledError,
  llmEnabled,
  LlmUnpricedError,
} from "@repo/ai";

const schemas = {
  /** Demo job: summarise a tenant's open items with the LLM. */
  "items.summarize": z.object({
    organizationId: z.string().min(1),
    userId: z.string().optional(),
  }),

  /** Execute one agent run (packages/agent). Started by `agent.start`. */
  "agent.run": z.object({
    organizationId: z.string().min(1),
    runId: z.string().min(1),
  }),

  /** Chunk + embed one document (packages/rag). Idempotent by content hash. */
  "docs.ingest": z.object({
    organizationId: z.string().min(1),
    documentId: z.string().min(1),
    /** Rebuild even if the content hash says nothing changed. */
    force: z.boolean().optional(),
  }),

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
      const fallback = (why: string) => ({
        summary: `${items.length} open items (${why}).`,
      });
      if (!llmEnabled("fast")) return fallback("LLM disabled");

      let result;
      try {
        result = await ask({
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
      } catch (err) {
        // Expected states, not failures: the job still produces a summary.
        if (err instanceof LlmBudgetExceededError)
          return fallback("daily AI budget reached");
        if (err instanceof LlmUnpricedError)
          return fallback("AI model has no price configured");
        if (err instanceof LlmDisabledError) return fallback("LLM disabled");
        throw err;
      }
      return { summary: result.text, costUsd: result.costUsd };
    },
  },

  "agent.run": {
    scope: "org",
    schema: schemas["agent.run"],
    // Never throws for a run that went wrong (that is recorded on agent_run),
    // and a redelivered job finds the run already claimed: no double runs.
    run: (payload) => executeRun(payload),
  },

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
    // ticks retry nothing and find no digest due. The same tick fails documents
    // stuck in indexing for over an hour, and agent
    // runs a dead worker left "running" (past runCutoffMs()), so a stuck run
    // shows as failed within ~15 minutes of its cutoff, not the next night.
    run: async () => {
      const abandonedAgentRuns = await abandonStaleRuns(db);
      // Same idea for documents a lost docs.ingest job left "indexing".
      const abandonedIngests = await sweepStaleIngests();
      return {
        ...(await runOperatorTick()),
        abandonedAgentRuns,
        abandonedIngests,
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

export function isJobName(name: string): name is JobName {
  return name in handlers;
}
