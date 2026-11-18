/**
 * Agents: start a run, watch its trace, and work the approval queue.
 *
 * The run itself executes in the worker (`agent.run` job, packages/agent);
 * this router only writes the queued row and enqueues it. Write tools never
 * act inside a run: they queue proposals, which a member approves (optionally
 * with an edited input, re-validated), or rejects, here. Approving runs the
 * tool's `apply` in the same transaction as the proposal's status change and
 * the audit events; a proposal is decided once (see packages/agent/proposals).
 *
 * Any member may approve: approving a change is no more than making it, which
 * members can already do. Restrict it with adminOnlyProcedure if your tools
 * do more than that.
 */
import { z } from "zod";
import {
  approveProposal,
  createProposal,
  rejectProposal,
  runCutoffMs,
  startRun,
  TOOLS,
  toolSpec,
} from "@repo/agent";
import { enqueue } from "@repo/jobs";
import { queueAppPush } from "@repo/jobs"; // @module:push-mobile

import { ConflictError, NotFoundError } from "../errors";
import { createTRPCRouter, orgProcedure, rateLimited } from "../trpc";

const id = z.string().min(1).max(64);

const PROPOSAL_FIELDS = {
  id: true,
  runId: true,
  source: true,
  tool: true,
  input: true,
  editedInput: true,
  summary: true,
  claim: true,
  status: true,
  apiKeyId: true,
  proposedBy: { select: { id: true, name: true } },
  error: true,
  result: true,
  createdAt: true,
  decidedAt: true,
  reviewer: { select: { id: true, name: true } },
} as const;

export const agentRouter = createTRPCRouter({
  /** The tools an agent can use, with the JSON Schema of their input. */
  tools: orgProcedure.query(() =>
    TOOLS.map((t) => ({
      name: t.name,
      effect: t.effect,
      description: t.description,
      inputSchema: toolSpec(t).inputSchema,
    })),
  ),

  /** Queue a run for the worker. Each run can cost several LLM calls. */
  start: orgProcedure
    .use(rateLimited({ limit: 10, windowSeconds: 60 }))
    .input(z.object({ goal: z.string().trim().min(1).max(2000) }))
    .mutation(async ({ ctx, input }) => {
      const run = await startRun(ctx.db, {
        organizationId: ctx.organizationId,
        userId: ctx.user.id,
        goal: input.goal,
        audit: ctx.audit,
      });
      try {
        await enqueue("agent.run", {
          organizationId: ctx.organizationId,
          runId: run.id,
        });
      } catch (err) {
        // Redis is down: say so on the run instead of leaving it queued forever.
        await ctx.db.agentRun.updateMany({
          where: { id: run.id, organizationId: ctx.organizationId },
          data: {
            status: "failed",
            stopReason: "error",
            error: "The run could not be queued.",
            finishedAt: new Date(),
          },
        });
        throw err;
      }
      return run;
    }),

  /**
   * Stop a run. A queued run is cancelled at once; a running one at its next
   * turn (the worker polls, and aborts the model call in flight). A run still
   * "running" past runCutoffMs() has no live worker behind it, so it is
   * cancelled at once too rather than waiting for the stale-run sweep.
   */
  cancel: orgProcedure.input(z.object({ id })).mutation(({ ctx, input }) =>
    ctx.db.$transaction(async (tx) => {
      const where = { id: input.id, organizationId: ctx.organizationId };
      const now = new Date();
      let { count } = await tx.agentRun.updateMany({
        where: { ...where, status: "queued" },
        data: {
          status: "cancelled",
          stopReason: "cancelled",
          cancelRequestedAt: now,
          finishedAt: now,
        },
      });
      if (count === 0) {
        ({ count } = await tx.agentRun.updateMany({
          where: {
            ...where,
            status: "running",
            startedAt: { lt: new Date(now.getTime() - runCutoffMs()) },
          },
          data: {
            status: "cancelled",
            stopReason: "cancelled",
            error: "Cancelled (no worker was running it).",
            cancelRequestedAt: now,
            finishedAt: now,
          },
        }));
      }
      if (count === 0) {
        ({ count } = await tx.agentRun.updateMany({
          where: { ...where, status: "running", cancelRequestedAt: null },
          data: { cancelRequestedAt: now },
        }));
      }
      if (count === 0) {
        const run = await tx.agentRun.findFirst({
          where,
          select: { status: true },
        });
        if (!run) throw new NotFoundError("Run not found.");
        throw new ConflictError(`This run is already ${run.status}.`);
      }
      await ctx.audit(
        "agent.run.cancel",
        { targetType: "agent_run", targetId: input.id },
        tx,
      );
      return { id: input.id };
    }),
  ),

  runs: orgProcedure
    .input(
      z
        .object({ limit: z.number().int().min(1).max(100).default(20) })
        .default({ limit: 20 }),
    )
    .query(({ ctx, input }) =>
      ctx.db.agentRun.findMany({
        where: { organizationId: ctx.organizationId },
        orderBy: { createdAt: "desc" },
        take: input.limit,
        select: {
          id: true,
          goal: true,
          status: true,
          stopReason: true,
          error: true,
          turns: true,
          costUsd: true,
          createdAt: true,
          finishedAt: true,
          cancelRequestedAt: true,
        },
      }),
    ),

  /** One run with its trace and the proposals it made. */
  run: orgProcedure.input(z.object({ id })).query(async ({ ctx, input }) => {
    const run = await ctx.db.agentRun.findFirst({
      where: { id: input.id, organizationId: ctx.organizationId },
      select: {
        id: true,
        goal: true,
        status: true,
        stopReason: true,
        model: true,
        result: true,
        error: true,
        turns: true,
        costUsd: true,
        createdAt: true,
        startedAt: true,
        finishedAt: true,
        cancelRequestedAt: true,
        createdBy: { select: { id: true, name: true } },
        steps: {
          where: { organizationId: ctx.organizationId },
          orderBy: { index: "asc" },
          take: 500,
          select: {
            index: true,
            kind: true,
            payload: true,
            inputTokens: true,
            outputTokens: true,
            costUsd: true,
            createdAt: true,
          },
        },
        proposals: {
          where: { organizationId: ctx.organizationId },
          orderBy: { createdAt: "asc" },
          select: PROPOSAL_FIELDS,
        },
      },
    });
    if (!run) throw new NotFoundError("Run not found.");
    return run;
  }),

  /** The approval queue (or its history, by status). */
  proposals: orgProcedure
    .input(
      z
        .object({
          status: z
            .enum(["pending", "applied", "failed", "rejected"])
            .default("pending"),
          limit: z.number().int().min(1).max(200).default(50),
        })
        .default({ status: "pending", limit: 50 }),
    )
    .query(({ ctx, input }) =>
      ctx.db.agentProposal.findMany({
        where: { organizationId: ctx.organizationId, status: input.status },
        orderBy: { createdAt: input.status === "pending" ? "asc" : "desc" },
        take: input.limit,
        select: PROPOSAL_FIELDS,
      }),
    ),

  /** One proposal (what a push notification about it opens). */
  proposal: orgProcedure
    .input(z.object({ id }))
    .query(async ({ ctx, input }) => {
      const p = await ctx.db.agentProposal.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
        select: PROPOSAL_FIELDS,
      });
      if (!p) throw new NotFoundError("Proposal not found.");
      return p;
    }),

  /**
   * Queue a write-tool call for review without a run: what an MCP client
   * without write access does instead of acting.
   */
  propose: orgProcedure
    .use(rateLimited({ limit: 60, windowSeconds: 60 }))
    .input(z.object({ tool: z.string().min(1).max(64), input: z.unknown() }))
    .mutation(async ({ ctx, input }) => {
      const p = await createProposal(ctx.db, {
        organizationId: ctx.organizationId,
        userId: ctx.user.id,
        apiKeyId: ctx.apiKey?.id ?? null,
        source: ctx.apiKey ? "mcp" : "user",
        tool: input.tool,
        input: input.input,
        audit: ctx.audit,
      });
      // @module:push-mobile
      // From an MCP client, the key's owner is not looking at the app: push.
      // (A proposal you just made yourself in the app needs no push.)
      if (ctx.apiKey) {
        await queueAppPush(ctx.organizationId, { kind: "proposal", id: p.id });
      }
      // @end
      return p;
    }),

  /** Apply a proposal, optionally with an edited input (re-validated). */
  approve: orgProcedure
    .input(z.object({ id, input: z.unknown().optional() }))
    .mutation(({ ctx, input }) =>
      approveProposal(ctx.db, {
        organizationId: ctx.organizationId,
        proposalId: input.id,
        reviewerId: ctx.user.id,
        ...(input.input !== undefined ? { editedInput: input.input } : {}),
        audit: ctx.audit,
      }),
    ),

  reject: orgProcedure
    .input(z.object({ id, reason: z.string().trim().max(500).optional() }))
    .mutation(async ({ ctx, input }) => {
      await rejectProposal(ctx.db, {
        organizationId: ctx.organizationId,
        proposalId: input.id,
        reviewerId: ctx.user.id,
        ...(input.reason ? { reason: input.reason } : {}),
        audit: ctx.audit,
      });
      return { id: input.id };
    }),
});
