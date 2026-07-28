/**
 * Media metadata. The bytes themselves move through
 * `apps/web/src/app/api/media/**` (multipart upload + authenticated download),
 * because tRPC is the wrong transport for file bodies.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { storage } from "@repo/storage";

import { createTRPCRouter, orgProcedure } from "../trpc";

export const mediaRouter = createTRPCRouter({
  list: orgProcedure
    .input(
      z
        .object({ limit: z.number().int().min(1).max(100).default(20) })
        .default({ limit: 20 }),
    )
    .query(async ({ ctx, input }) => {
      const assets = await ctx.db.mediaAsset.findMany({
        where: { organizationId: ctx.organizationId },
        orderBy: { createdAt: "desc" },
        take: input.limit,
        select: {
          id: true,
          key: true,
          filename: true,
          contentType: true,
          sizeBytes: true,
          createdAt: true,
        },
      });

      const driver = storage();
      return Promise.all(
        assets.map(async (a) => ({ ...a, url: await driver.url(a.key) })),
      );
    }),

  remove: orgProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const asset = await ctx.db.mediaAsset.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
        select: { id: true, key: true },
      });
      if (!asset) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Asset not found." });
      }

      // Delete the row first: an orphaned blob is inert, an orphaned row is a
      // broken image in the UI.
      await ctx.db.mediaAsset.delete({ where: { id: asset.id } });
      try {
        await storage().delete(asset.key);
      } catch (err) {
        console.error("[media] blob delete failed (row already removed):", err);
      }
      return { id: asset.id };
    }),
});
