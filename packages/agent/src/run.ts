/**
 * Agent runs: start one (from the API), execute it (in the worker).
 *
 * startRun writes the `agent_run` row (queued) and its audit event; the
 * caller enqueues the `agent.run` job. executeRun is that job's body:
 *
 *  1. claim the run: `updateMany` queued → running. A redelivered or retried
 *     job finds it already claimed and does nothing, so a run never executes
 *     twice (which would duplicate proposals and spend).
 *  2. run the loop with the real model (`converse`, discretionary, capped by
 *     the tenant's daily cap) and a recorder that writes the trace
 *     (`agent_step`) and proposals (`agent_proposal`) as they happen.
 *  3. settle the run: completed / failed / cancelled, with the stop reason.
 *
 * It does NOT throw for a run that went wrong — that is the run's outcome,
 * recorded on its row — so BullMQ does not retry it. Only an unexpected
 * failure ("error": a provider outage, a bug) tells the operator, at LOW
 * priority (the digest), deduped per tenant per day.
 *
 * A run left "running" by a dead worker is marked failed by the nightly
 * maintenance job (abandonStaleRuns).
 */
import { converse } from "@repo/ai";
import {
  db as defaultDb,
  recordAudit,
  type Prisma,
  type PrismaClient,
} from "@repo/db";
import { env } from "@repo/env";
import { notifyOperator } from "@repo/notify";

import { runLoop, type LoopResult, type Model, type Recorder } from "./loop";
import { createProposal, type Audit } from "./proposals";
import { TOOLS } from "./registry";
import type { AgentTool } from "./tool";

/** How often a running run looks for a cancel request (and aborts the turn). */
const CANCEL_POLL_MS = 2_000;

export async function startRun(
  db: PrismaClient,
  args: {
    organizationId: string;
    userId: string;
    goal: string;
    audit: Audit;
  },
): Promise<{ id: string }> {
  return db.$transaction(async (tx) => {
    const run = await tx.agentRun.create({
      data: {
        organizationId: args.organizationId,
        createdById: args.userId,
        goal: args.goal,
      },
      select: { id: true },
    });
    await args.audit(
      "agent.run.start",
      { targetType: "agent_run", targetId: run.id },
      tx,
    );
    return run;
  });
}

export interface ExecuteDeps {
  db?: PrismaClient;
  model?: Model;
  tools?: readonly AgentTool[];
  notify?: typeof notifyOperator;
}

export type ExecuteOutcome =
  | { runId: string; skipped: string }
  | ({ runId: string; status: string } & Omit<LoopResult, "text">);

export async function executeRun(
  payload: { organizationId: string; runId: string },
  deps: ExecuteDeps = {},
): Promise<ExecuteOutcome> {
  const db = deps.db ?? defaultDb;
  const { organizationId, runId } = payload;
  const where = { id: runId, organizationId };

  const claimed = await db.agentRun.updateMany({
    where: { ...where, status: "queued" },
    data: { status: "running", startedAt: new Date() },
  });
  if (claimed.count === 0) {
    return { runId, skipped: "not queued (already run, cancelled, or gone)" };
  }
  const run = await db.agentRun.findFirstOrThrow({
    where,
    select: { goal: true, createdById: true },
  });

  const e = env();
  const model: Model =
    deps.model ??
    ((opts) =>
      converse({
        ...opts,
        purpose: "agent.run",
        // An agent run is optional work: it stops at the tenant's daily cap.
        priority: "discretionary",
        organizationId,
        userId: run.createdById,
        tier: e.AGENT_TIER,
        maxOutputTokens: 8_000,
      }));

  const abort = new AbortController();
  const recorder = dbRecorder(db, {
    organizationId,
    runId,
    userId: run.createdById,
  });
  const poll = setInterval(() => {
    void recorder.cancelled().then(
      (yes) => yes && abort.abort(),
      () => {},
    );
  }, CANCEL_POLL_MS);

  let result: LoopResult;
  try {
    result = await runLoop({
      goal: run.goal,
      tools: deps.tools ?? TOOLS,
      model,
      recorder,
      context: { organizationId, userId: run.createdById, db },
      maxSteps: e.AGENT_MAX_STEPS,
      maxCostUsd: e.AGENT_MAX_COST_USD,
      signal: abort.signal,
    });
  } catch (err) {
    // A bug or the database going away mid-run (the loop handles the model's
    // and the tools' failures itself).
    console.error(`[agent] run ${runId} crashed:`, err);
    result = {
      stopReason: "error",
      text: "",
      error: "The run failed unexpectedly.",
      turns: 0,
      costUsd: 0,
      model: null,
    };
  } finally {
    clearInterval(poll);
  }

  const status =
    result.stopReason === "done"
      ? "completed"
      : result.stopReason === "cancelled"
        ? "cancelled"
        : "failed";
  await db.agentRun.updateMany({
    where,
    data: {
      status,
      stopReason: result.stopReason,
      result: result.text ? result.text.slice(0, 8_000) : null,
      error: result.error,
      model: result.model,
      turns: result.turns,
      costUsd: result.costUsd,
      finishedAt: new Date(),
    },
  });

  if (result.stopReason === "error") {
    // NO CUSTOMER DATA (the goal, the model's text): ids and the class only.
    const day = new Date().toISOString().slice(0, 10);
    await (deps.notify ?? notifyOperator)({
      title: "An agent run failed",
      body: `${result.error ?? "error"}\nrun ${runId} · org ${organizationId} · trace in agent_step`,
      priority: "low",
      dedupeKey: `agent-run-failed:${organizationId}:${day}`,
      dedupeWindowMinutes: 24 * 60,
      organizationId,
      tags: ["robot"],
    });
  }
  const { text: _text, ...rest } = result;
  return { runId, status, ...rest };
}

/** The production recorder: the trace and the proposals, in Postgres. */
export function dbRecorder(
  db: PrismaClient,
  run: { organizationId: string; runId: string; userId: string | null },
): Recorder {
  let index = 0;
  const audit: Audit = (action, opts, client) =>
    recordAudit(client, {
      organizationId: run.organizationId,
      actorType: "job",
      actorId: `agent.run:${run.runId}`,
      action,
      targetType: opts.targetType ?? action.split(".")[0] ?? action,
      targetId: opts.targetId,
      metadata: opts.metadata,
    });
  return {
    async step(kind, payload, usage) {
      await db.agentStep.create({
        data: {
          runId: run.runId,
          organizationId: run.organizationId,
          index: index++,
          kind,
          payload: payload as Prisma.InputJsonValue,
          ...(usage ?? {}),
        },
      });
    },
    async propose(p) {
      const { id } = await createProposal(db, {
        organizationId: run.organizationId,
        userId: run.userId,
        runId: run.runId,
        source: "agent",
        tool: p.tool,
        input: p.input,
        audit,
      });
      return id;
    },
    async cancelled() {
      const r = await db.agentRun.findFirst({
        where: { id: run.runId, organizationId: run.organizationId },
        select: { cancelRequestedAt: true },
      });
      return !r || r.cancelRequestedAt !== null;
    },
  };
}

/** Runs a dead worker left "running": failed, so nobody waits on them. */
export async function abandonStaleRuns(
  db: PrismaClient = defaultDb,
  olderThanMs = 60 * 60 * 1000,
): Promise<number> {
  const { count } = await db.agentRun.updateMany({
    where: {
      status: "running",
      startedAt: { lt: new Date(Date.now() - olderThanMs) },
    },
    data: {
      status: "failed",
      stopReason: "error",
      error: "The run was abandoned (the worker stopped mid-run).",
      finishedAt: new Date(),
    },
  });
  return count;
}
