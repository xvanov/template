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
 *
 * The writes and their input rules live in @repo/domain (domain functions),
 * because the agent's item tools make the same changes: one definition, two
 * callers. A resolver here is then just: input schema, transaction, actor
 * from the context, audit bound to the transaction.
 */
import { z } from "zod";
import {
  createItem,
  createItemInput,
  removeItem,
  removeItemInput,
  setItemDone,
  setItemDoneInput,
} from "@repo/domain";
import { enqueue } from "@repo/jobs";

import { afterItemCreated } from "../item-events";
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
    .input(createItemInput)
    .mutation(async ({ ctx, input }) => {
      const item = await ctx.db.$transaction((tx) =>
        createItem(tx, actor(ctx), input, (a, o) => ctx.audit(a, o, tx)),
      );
      await afterItemCreated(ctx.organizationId, item.id);
      return item;
    }),

  setDone: orgProcedure
    .input(setItemDoneInput)
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction((tx) =>
        setItemDone(tx, actor(ctx), input, (a, o) => ctx.audit(a, o, tx)),
      ),
    ),

  remove: orgProcedure
    .input(removeItemInput)
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction((tx) =>
        removeItem(tx, actor(ctx), input, (a, o) => ctx.audit(a, o, tx)),
      ),
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

function actor(ctx: { organizationId: string; user: { id: string } }) {
  return { organizationId: ctx.organizationId, userId: ctx.user.id };
}
