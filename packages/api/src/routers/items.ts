/**
 * The demo domain router — and the reference for how to write an org-scoped
 * resolver. Replace `Item` with your own model; keep the shape.
 *
 * Note every mutation filters by `organizationId` in its `where` clause and
 * uses `updateMany`/`deleteMany` rather than `update`/`delete` by id. That is
 * deliberate: a by-id write with a separate ownership check is two round trips
 * and one forgotten `if` away from a cross-tenant write.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { enqueue } from "@repo/jobs";

import { createTRPCRouter, orgProcedure } from "../trpc";

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
      ctx.db.item.create({
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
      }),
    ),

  setDone: orgProcedure
    .input(z.object({ id: z.string().min(1), done: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const { count } = await ctx.db.item.updateMany({
        where: { id: input.id, organizationId: ctx.organizationId },
        data: { done: input.done },
      });
      if (count === 0) throw notFound();
      return { id: input.id, done: input.done };
    }),

  remove: orgProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const { count } = await ctx.db.item.deleteMany({
        where: { id: input.id, organizationId: ctx.organizationId },
      });
      if (count === 0) throw notFound();
      return { id: input.id };
    }),

  /** Hand the tenant's open items to the background worker to summarise. */
  queueSummary: orgProcedure.mutation(async ({ ctx }) => {
    const jobId = await enqueue("items.summarize", {
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
    });
    return { jobId };
  }),

  /** Latest background-job outcomes, so the UI can show that work happened. */
  recentJobs: orgProcedure.query(({ ctx }) =>
    ctx.db.jobRun.findMany({
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
  return new TRPCError({ code: "NOT_FOUND", message: "Item not found." });
}
