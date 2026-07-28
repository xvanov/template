/**
 * The job registry: name → payload schema + handler.
 *
 * Adding a job means adding one entry here. The worker needs no edit, the
 * producer gets type safety from `JobPayloads`, and an unknown job name fails
 * loudly instead of being silently dropped.
 */
import { z } from "zod";
import { db } from "@repo/db";
import { ask, llmEnabled } from "@repo/ai";

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

type Handler<N extends JobName> = (payload: JobPayloads[N]) => Promise<unknown>;

export const handlers: {
  [N in JobName]: { schema: (typeof schemas)[N]; run: Handler<N> };
} = {
  "items.summarize": {
    schema: schemas["items.summarize"],
    run: async ({ organizationId, userId }) => {
      const items = await db.item.findMany({
        where: { organizationId, done: false },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { title: true, notes: true },
      });
      if (items.length === 0) return { summary: "Nothing open." };
      if (!llmEnabled())
        return { summary: `${items.length} open items (LLM disabled).` };

      const result = await ask({
        purpose: "items.summarize",
        organizationId,
        userId,
        system: "You summarise task lists in two sentences. Be concrete.",
        prompt: items
          .map((i) => `- ${i.title}${i.notes ? `: ${i.notes}` : ""}`)
          .join("\n"),
      });
      return { summary: result.text, costUsd: result.costUsd };
    },
  },

  "maintenance.nightly": {
    schema: schemas["maintenance.nightly"],
    run: async () => {
      // Bound the durable job history so this table cannot grow forever.
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const { count } = await db.jobRun.deleteMany({
        where: {
          createdAt: { lt: cutoff },
          status: { in: ["completed", "failed"] },
        },
      });
      return { prunedJobRuns: count };
    },
  },

  "notify.digest": {
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
