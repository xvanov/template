/**
 * The demo domain router — and the reference for how to write an org-scoped
 * resolver. Replace `Item` with your own model; keep the shape.
 *
 * Note every mutation filters by `organizationId` in its `where` clause and
 * uses `updateMany`/`deleteMany` rather than `update`/`delete` by id. That is
 * deliberate: a by-id write with a separate ownership check is two round trips
 * and one forgotten `if` away from a cross-tenant write.
 *
 * Every mutation also writes an audit event IN THE SAME TRANSACTION
 * (`ctx.audit(..., tx)`), so the trail cannot claim a change that rolled back
 * or miss one that committed.
 */
import { z } from "zod";
import { enqueue } from "@repo/jobs";

import { NotFoundError } from "../errors";
import { createTRPCRouter, orgProcedure, rateLimited } from "../trpc";

export const itemsRouter = createTRPCRouter({
  list: orgProcedure
    .input(
      z
        .object({
          includeDone: z.boolean().default(true),
          limit: z.number().int().min(1).max(200).default(50),
        })
        .default({ includeDone: true, limit: 50 }),
    )
    .query(({ ctx, input }) =>
      ctx.db.item.findMany({
        where: {
          organizationId: ctx.organizationId,
          ...(input.includeDone ? {} : { done: false }),
        },
        orderBy: [{ done: "asc" }, { createdAt: "desc" }],
        take: input.limit,
        select: {
          id: true,
          title: true,
          notes: true,
          done: true,
          createdAt: true,
          createdBy: { select: { id: true, name: true, image: true } },
        },
      }),
    ),

  create: orgProcedure
    .input(
      z.object({
        title: z.string().trim().min(1, "Title is required").max(200),
        notes: z.string().trim().max(2000).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        const item = await tx.item.create({
          data: {
            organizationId: ctx.organizationId,
            title: input.title,
            notes: input.notes,
            createdById: ctx.user.id,
          },
          select: {
            id: true,
            title: true,
            notes: true,
            done: true,
            createdAt: true,
          },
        });
        await ctx.audit(
          "item.create",
          { targetId: item.id, metadata: { title: item.title } },
          tx,
        );
        return item;
      }),
    ),

  setDone: orgProcedure
    .input(z.object({ id: z.string().min(1), done: z.boolean() }))
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        const { count } = await tx.item.updateMany({
          where: { id: input.id, organizationId: ctx.organizationId },
          data: { done: input.done },
        });
        if (count === 0) throw notFound();
        await ctx.audit(
          "item.update",
          { targetId: input.id, metadata: { done: input.done } },
          tx,
        );
        return { id: input.id, done: input.done };
      }),
    ),

  remove: orgProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        const { count } = await tx.item.deleteMany({
          where: { id: input.id, organizationId: ctx.organizationId },
        });
        if (count === 0) throw notFound();
        await ctx.audit("item.delete", { targetId: input.id }, tx);
        return { id: input.id };
      }),
    ),

  /**
   * Hand the tenant's open items to the background worker to summarise.
   * Throttled per user: each call can cost an LLM request.
   */
  queueSummary: orgProcedure
    .use(rateLimited({ limit: 10, windowSeconds: 60 }))
    .mutation(async ({ ctx }) => {
      const jobId = await enqueue("items.summarize", {
        organizationId: ctx.organizationId,
        userId: ctx.user.id,
      });
      return { jobId };
    }),

  /**
   * Latest background-job outcomes, so the UI can show that work happened.
   * Scoped to this tenant: system jobs (null owner) and other tenants' jobs are
   * never returned.
   */
  recentJobs: orgProcedure.query(({ ctx }) =>
    ctx.db.jobRun.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        name: true,
        status: true,
        error: true,
        createdAt: true,
        finishedAt: true,
      },
    }),
  ),
});

function notFound() {
  // Same error whether the row is absent or owned by another tenant — never
  // let a 404-vs-403 difference confirm that someone else's id exists.
  // A typed error, not a TRPCError: the API layer maps it to NOT_FOUND.
  return new NotFoundError("Item not found.");
}
