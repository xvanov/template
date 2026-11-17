/**
 * Organization API keys (for the MCP endpoint, /api/mcp). Owners and admins
 * create and revoke them; every change is audited. The secret is returned
 * ONCE, by `create`; only its hash is stored (../api-keys.ts).
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { generateApiKey } from "../api-keys";
import { NotFoundError } from "../errors";
import { adminOnlyProcedure, createTRPCRouter } from "../trpc";

/** Keys are managed by people in the app, never by another key. */
const keyAdmin = adminOnlyProcedure("manage API keys").use(({ ctx, next }) => {
  if (ctx.apiKey) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "API keys cannot manage API keys.",
    });
  }
  return next();
});

export const apiKeysRouter = createTRPCRouter({
  list: keyAdmin.query(({ ctx }) =>
    ctx.db.apiKey.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        name: true,
        prefix: true,
        canWrite: true,
        lastUsedAt: true,
        revokedAt: true,
        createdAt: true,
        createdBy: { select: { id: true, name: true } },
      },
    }),
  ),

  create: keyAdmin
    .input(
      z.object({
        name: z.string().trim().min(1).max(100),
        /** False (default): MCP write tools queue proposals instead of acting. */
        canWrite: z.boolean().default(false),
      }),
    )
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        const { secret, prefix, hash } = generateApiKey();
        const key = await tx.apiKey.create({
          data: {
            organizationId: ctx.organizationId,
            createdById: ctx.user.id,
            name: input.name,
            canWrite: input.canWrite,
            prefix,
            hash,
          },
          select: { id: true, name: true, prefix: true, canWrite: true },
        });
        await ctx.audit(
          "api_key.create",
          {
            targetId: key.id,
            metadata: { name: key.name, canWrite: key.canWrite },
          },
          tx,
        );
        // The only time the secret leaves the server.
        return { ...key, secret };
      }),
    ),

  revoke: keyAdmin
    .input(z.object({ id: z.string().min(1).max(64) }))
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        const { count } = await tx.apiKey.updateMany({
          where: {
            id: input.id,
            organizationId: ctx.organizationId,
            revokedAt: null,
          },
          data: { revokedAt: new Date() },
        });
        if (count === 0) throw new NotFoundError("API key not found.");
        await ctx.audit("api_key.revoke", { targetId: input.id }, tx);
        return { id: input.id };
      }),
    ),
});
