/**
 * AI features.
 *
 * Every call is priced and attributed to the tenant by `@repo/ai`, and gated by
 * a per-tenant daily USD ceiling. An LLM endpoint with no spend ceiling is an
 * open invitation to run up someone else's bill.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { ask, llmEnabled, spendByPurpose } from "@repo/ai";

import { createTRPCRouter, orgProcedure, publicProcedure } from "../trpc";

/** Raise deliberately, per environment — not by deleting the check. */
const DAILY_USD_CEILING = 2;

export const aiRouter = createTRPCRouter({
  enabled: publicProcedure.query(() => ({ enabled: llmEnabled() })),

  ask: orgProcedure
    .input(
      z.object({
        prompt: z.string().trim().min(1).max(4000),
        system: z.string().trim().max(2000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!llmEnabled()) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "AI is not configured. Set LLM_API_KEY in .env.",
        });
      }

      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const spent = await ctx.db.llmCall.aggregate({
        where: {
          organizationId: ctx.organizationId,
          createdAt: { gte: since },
        },
        _sum: { costUsd: true },
      });
      if ((spent._sum.costUsd ?? 0) >= DAILY_USD_CEILING) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: `Daily AI budget of $${DAILY_USD_CEILING} reached for this workspace.`,
        });
      }

      const result = await ask({
        purpose: "ai.ask",
        organizationId: ctx.organizationId,
        userId: ctx.user.id,
        system: input.system,
        prompt: input.prompt,
      });

      return {
        text: result.text,
        costUsd: result.costUsd,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        latencyMs: result.latencyMs,
      };
    }),

  spend: orgProcedure
    .input(
      z
        .object({ days: z.number().int().min(1).max(365).default(30) })
        .default({ days: 30 }),
    )
    .query(({ ctx, input }) => spendByPurpose(ctx.organizationId, input.days)),
});
