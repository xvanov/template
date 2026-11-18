/**
 * What happened in this tenant: the audit trail and the outbound message log.
 * Read-only, org-scoped, and for owners/admins: both name other members and
 * the addresses mail went to.
 *
 * Rows with a null organizationId (system/auth mail, global actions) are never
 * returned to any tenant: the `where` always pins the tenant.
 */
import { z } from "zod";

import { adminOnlyProcedure, createTRPCRouter } from "../trpc";

const adminProcedure = adminOnlyProcedure("view activity");

const page = {
  limit: z.number().int().min(1).max(200).default(50),
  /** createdAt of the last row of the previous page. */
  before: z.date().optional(),
};

export const activityRouter = createTRPCRouter({
  audit: adminProcedure
    .input(
      z
        .object({
          ...page,
          action: z.string().max(100).optional(),
          targetType: z.string().max(100).optional(),
          targetId: z.string().max(100).optional(),
        })
        .default({ limit: 50 }),
    )
    .query(({ ctx, input }) =>
      ctx.db.auditEvent.findMany({
        where: {
          organizationId: ctx.organizationId,
          action: input.action,
          targetType: input.targetType,
          targetId: input.targetId,
          ...(input.before ? { createdAt: { lt: input.before } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: input.limit,
        select: {
          id: true,
          actorType: true,
          actorId: true,
          action: true,
          targetType: true,
          targetId: true,
          metadata: true,
          ip: true,
          userAgent: true,
          createdAt: true,
        },
      }),
    ),

  outbound: adminProcedure
    .input(
      z
        .object({
          ...page,
          status: z.enum(["pending", "sent", "failed", "blocked"]).optional(),
        })
        .default({ limit: 50 }),
    )
    .query(({ ctx, input }) =>
      ctx.db.outboundMessage.findMany({
        where: {
          organizationId: ctx.organizationId,
          status: input.status,
          ...(input.before ? { createdAt: { lt: input.before } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: input.limit,
        select: {
          id: true,
          channel: true,
          recipient: true,
          subject: true,
          purpose: true,
          status: true,
          blockReason: true,
          detail: true,
          deliveryStatus: true,
          deliveryDetail: true,
          createdAt: true,
          finishedAt: true,
        },
      }),
    ),
});
