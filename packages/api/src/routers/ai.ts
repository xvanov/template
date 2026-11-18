/**
 * AI features — the demo box on the dashboard.
 *
 * Everything that matters lives in `@repo/ai`: routing (`provider/model` from
 * .env by tier), the per-tenant daily cap checked BEFORE sending, and pricing
 * into `llm_call`. Its typed errors map to tRPC codes by name (../errors):
 * over the cap → TOO_MANY_REQUESTS, not configured / unpriced / bad model
 * string → PRECONDITION_FAILED, refused → BAD_REQUEST. Never a bare 500.
 */
import { z } from "zod";
import {
  ask,
  describeLlm,
  llmEnabled,
  LlmTruncatedError,
  transcribeEnabled,
  spendByPurpose,
  type ImageInput,
} from "@repo/ai";
import { storage } from "@repo/storage";

import { DomainRuleError, NotFoundError } from "../errors";
import {
  createTRPCRouter,
  orgProcedure,
  publicProcedure,
  rateLimited,
} from "../trpc";

/** What every vision provider accepts. HEIC is converted on the phone. */
const VISION_TYPES: readonly ImageInput["mediaType"][] = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];
/** Anthropic's per-image limit is 5 MB; phone/glasses JPEGs are well under. */
export const MAX_DESCRIBE_BYTES = 5 * 1024 * 1024;

/**
 * Short, spoken-friendly, and never identifying people: the description may
 * be read aloud through open-ear speakers, near the people in the photo.
 */
const DESCRIBE_SYSTEM = [
  "You describe a photo taken by the user (often from smart glasses) so it can be read aloud.",
  "Answer in at most three short sentences of plain text: no lists, no markdown.",
  "Lead with what matters: the main subject, any readable text, anything that needs attention.",
  "Never identify, name or guess the identity of a person from their face or body; describe people only in general terms.",
  "If the photo is too dark or blurry to tell, say so.",
].join(" ");

export const aiRouter = createTRPCRouter({
  /** Public: a boolean only. Which model runs is not for anonymous visitors. */
  enabled: publicProcedure.query(() => ({ enabled: llmEnabled() })),

  /**
   * Signed in: can audio be transcribed (POST /api/media/transcribe)? The app
   * hides its dictate button when not.
   */
  transcribeEnabled: orgProcedure.query(() => ({
    enabled: transcribeEnabled(),
  })),

  /** Signed in: which model each tier routes to, and the cap. Never a key. */
  info: orgProcedure.query(() => {
    const d = describeLlm();
    return { enabled: d.enabled, tiers: d.tiers, dailyCapUsd: d.dailyCapUsd };
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

  /**
   * Describe one of this tenant's photos (the glasses capture flow). Optional
   * and capped: "discretionary", so it stops at the daily cap; the fast tier,
   * which must be a vision-capable model; a small output allowance. Rate
   * limited per user, because each call sends a whole image.
   */
  describeImage: orgProcedure
    .use(rateLimited({ limit: 10, windowSeconds: 60 }))
    .input(
      z.object({
        mediaId: z.string().min(1).max(64),
        question: z.string().trim().min(1).max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const asset = await ctx.db.mediaAsset.findFirst({
        where: { id: input.mediaId, organizationId: ctx.organizationId },
        select: { key: true, contentType: true, sizeBytes: true },
      });
      if (!asset) throw new NotFoundError("Photo not found.");
      const mediaType = asset.contentType.split(";")[0]!.trim().toLowerCase();
      if (!(VISION_TYPES as readonly string[]).includes(mediaType)) {
        throw new DomainRuleError(
          "Only JPEG, PNG, WebP or GIF photos can be described.",
        );
      }
      if (asset.sizeBytes > MAX_DESCRIBE_BYTES) {
        throw new DomainRuleError(
          "That photo is too large to describe (5 MB max).",
        );
      }
      const data = await storage().get(asset.key);
      const r = await ask({
        purpose: "media.describe",
        priority: "discretionary",
        tier: "fast",
        organizationId: ctx.organizationId,
        userId: ctx.user.id,
        system: DESCRIBE_SYSTEM,
        prompt: input.question ?? "What is in this photo?",
        images: [{ data, mediaType: mediaType as ImageInput["mediaType"] }],
        maxOutputTokens: 400,
        effort: "low",
      });
      return {
        text: r.text,
        servedBy: r.servedBy,
        costUsd: r.costUsd,
        costKnown: r.costKnown,
        latencyMs: r.latencyMs,
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
