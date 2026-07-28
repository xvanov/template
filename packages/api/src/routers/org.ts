/**
 * The current tenant: who am I acting as, and with whom.
 *
 * Creating orgs, inviting members and switching the active org are handled by
 * better-auth's organization plugin over `/api/auth/**` — do not reimplement
 * them here.
 */
import { z } from "zod";

import { createTRPCRouter, orgProcedure } from "../trpc";

export const orgRouter = createTRPCRouter({
  current: orgProcedure.query(async ({ ctx }) => {
    const org = await ctx.db.organization.findUnique({
      where: { id: ctx.organizationId },
      select: {
        id: true,
        name: true,
        slug: true,
        createdAt: true,
        members: {
          select: {
            role: true,
            createdAt: true,
            user: {
              select: { id: true, name: true, email: true, image: true },
            },
          },
          orderBy: { createdAt: "asc" },
          take: 50,
        },
      },
    });

    const me = org?.members.find((m) => m.user.id === ctx.user.id);
    return { organization: org, myRole: me?.role ?? "member" };
  }),

  rename: orgProcedure
    .input(z.object({ name: z.string().trim().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      // Owners and admins only — checked against this tenant's membership row,
      // not a claim carried on the client.
      const me = await ctx.db.member.findFirst({
        where: { organizationId: ctx.organizationId, userId: ctx.user.id },
        select: { role: true },
      });
      if (me?.role !== "owner" && me?.role !== "admin") {
        throw new Error("Only an owner or admin can rename the workspace.");
      }
      return ctx.db.organization.update({
        where: { id: ctx.organizationId },
        data: { name: input.name },
        select: { id: true, name: true },
      });
    }),
});
