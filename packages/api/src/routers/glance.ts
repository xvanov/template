/**
 * Glance links (../glance.ts): each member manages their OWN links — a link
 * acts as its creator, so nobody else may mint or revoke one for them. Every
 * change is audited; the secret is returned once, by `createLink`.
 *
 * `snapshot` is the same data the link shows, for a signed-in caller (the
 * web settings preview, the phone app).
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { NotFoundError } from "../errors";
import { generateGlanceSecret, glanceSnapshot } from "../glance";
import { createTRPCRouter, orgProcedure } from "../trpc";

/** Links are made by people in the app, never by an API key (MCP). */
const memberOnly = orgProcedure.use(({ ctx, next }) => {
  // @module:agent
  if (ctx.apiKey) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "API keys cannot manage glance links.",
    });
  }
  // @end
  return next();
});

/** A person has a pair of glasses or two, not a fleet. */
const MAX_ACTIVE_LINKS = 10;

export const glanceRouter = createTRPCRouter({
  snapshot: orgProcedure.query(({ ctx }) =>
    glanceSnapshot(ctx.db, ctx.organizationId),
  ),

  links: memberOnly.query(({ ctx }) =>
    ctx.db.glanceLink.findMany({
      where: { organizationId: ctx.organizationId, userId: ctx.user.id },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        name: true,
        prefix: true,
        showDetails: true,
        expiresAt: true,
        lastUsedAt: true,
        revokedAt: true,
        createdAt: true,
      },
    }),
  ),

  createLink: memberOnly
    .input(
      z.object({
        name: z.string().trim().min(1).max(60),
        /** null = never expires. */
        expiresInDays: z.number().int().min(1).max(365).nullable().default(30),
        /** Titles and senders, not just counts. Off by default. */
        showDetails: z.boolean().default(false),
      }),
    )
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        const active = await tx.glanceLink.count({
          where: {
            organizationId: ctx.organizationId,
            userId: ctx.user.id,
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
        });
        if (active >= MAX_ACTIVE_LINKS) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `You already have ${MAX_ACTIVE_LINKS} active glance links. Revoke one first.`,
          });
        }
        const { secret, prefix, hash } = generateGlanceSecret();
        const link = await tx.glanceLink.create({
          data: {
            organizationId: ctx.organizationId,
            userId: ctx.user.id,
            name: input.name,
            prefix,
            hash,
            showDetails: input.showDetails,
            expiresAt:
              input.expiresInDays === null
                ? null
                : new Date(Date.now() + input.expiresInDays * 86_400_000),
          },
          select: {
            id: true,
            name: true,
            prefix: true,
            showDetails: true,
            expiresAt: true,
            createdAt: true,
          },
        });
        await ctx.audit(
          "glance_link.create",
          {
            targetId: link.id,
            metadata: {
              name: link.name,
              showDetails: link.showDetails,
              expiresAt: link.expiresAt?.toISOString() ?? null,
            },
          },
          tx,
        );
        // The only time the secret leaves the server.
        return { ...link, secret };
      }),
    ),

  revokeLink: memberOnly
    .input(z.object({ id: z.string().min(1).max(64) }))
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        const { count } = await tx.glanceLink.updateMany({
          where: {
            id: input.id,
            organizationId: ctx.organizationId,
            userId: ctx.user.id,
            revokedAt: null,
          },
          data: { revokedAt: new Date() },
        });
        if (count === 0) throw new NotFoundError("Glance link not found.");
        await ctx.audit("glance_link.revoke", { targetId: input.id }, tx);
        return { id: input.id };
      }),
    ),
});
