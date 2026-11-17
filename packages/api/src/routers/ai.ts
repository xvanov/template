/**
 * AI features — the demo box on the dashboard.
 *
 * Everything that matters lives in `@repo/ai`: routing (`provider/model` from
 * .env by tier), the per-tenant daily cap checked BEFORE sending, and pricing
 * into `llm_call`. Its typed errors map to tRPC codes by name (../errors):
 * over the cap → TOO_MANY_REQUESTS, not configured → PRECONDITION_FAILED,
 * refused → BAD_REQUEST.
 */
import { z } from "zod";
import { ask, describeLlm, LlmTruncatedError, spendByPurpose } from "@repo/ai";

import { createTRPCRouter, orgProcedure, publicProcedure } from "../trpc";

export const aiRouter = createTRPCRouter({
  enabled: publicProcedure.query(() => {
    const d = describeLlm();
    return { enabled: d.enabled, model: d.tiers.default };
  }),

  ask: orgProcedure
    .input(
      z.object({
        prompt: z.string().trim().min(1).max(4000),
        system: z.string().trim().max(2000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const r = await ask({
          purpose: "ai.ask",
          // A demo box is the definition of optional: it stops at the cap.
          priority: "discretionary",
          organizationId: ctx.organizationId,
          userId: ctx.user.id,
          system: input.system,
          prompt: input.prompt,
          maxOutputTokens: 4096,
          effort: "low",
        });
        return {
          text: r.text,
          truncated: false,
          servedBy: r.servedBy,
          costUsd: r.costUsd,
          costKnown: r.costKnown,
          inputTokens:
            r.usage.inputTokens +
            r.usage.cacheReadTokens +
            r.usage.cacheWriteTokens,
          outputTokens: r.usage.outputTokens,
          latencyMs: r.latencyMs,
        };
      } catch (err) {
        // A cut-off reply is still worth showing — labelled, never as complete.
        if (err instanceof LlmTruncatedError) {
          return {
            text: err.partialText,
            truncated: true,
            servedBy: null,
            costUsd: err.costUsd,
            costKnown: true,
            inputTokens: null,
            outputTokens: null,
            latencyMs: null,
          };
        }
        throw err;
      }
    }),

  spend: orgProcedure
    .input(
      z
        .object({ days: z.number().int().min(1).max(365).default(30) })
        .default({ days: 30 }),
    )
    .query(({ ctx, input }) => spendByPurpose(ctx.organizationId, input.days)),
});
