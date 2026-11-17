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
import { db } from "@repo/db";
import { ask, LlmBudgetExceededError, llmEnabled } from "@repo/ai";

const schemas = {
  /** Demo job: summarise a tenant's open items with the LLM. */
  "items.summarize": z.object({
    organizationId: z.string().min(1),
    userId: z.string().optional(),
  }),

  /** Demo scheduled job: prune soft state and log a heartbeat. */
  "maintenance.nightly": z.object({}),

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
      if (!llmEnabled()) return fallback("LLM disabled");

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
        if (err instanceof LlmBudgetExceededError)
          return fallback("daily AI budget reached");
        throw err;
      }
      return { summary: result.text, costUsd: result.costUsd };
    },
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
      return { prunedJobRuns: count };
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
