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
 * A run left "running" by a dead worker is marked failed by the 15-minute
 * operator tick (abandonStaleRuns), once past runCutoffMs().
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
import { readOnly, type AgentTool } from "./tool";

/** How often a running run looks for a cancel request (and aborts the turn). */
const CANCEL_POLL_MS = 2_000;

/** The longest one model turn may take; the turn is aborted after it. */
export const TURN_TIMEOUT_MS = 120_000;

/**
 * The longest a run can legitimately stay "running": every turn at its time
 * limit, plus slack for tools and the database. A "running" run older than
 * this has no live worker behind it: the operator tick marks it failed
 * (abandonStaleRuns), and Cancel ends it at once.
 */
export function runCutoffMs(): number {
  return env().AGENT_MAX_STEPS * TURN_TIMEOUT_MS + 5 * 60_000;
}

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
  turnTimeoutMs?: number;
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

  // The run acts for whoever started it. If they have left the workspace (or
  // were deleted) since, it must not act at all.
  const member = run.createdById
    ? await db.member.findUnique({
        where: {
          organizationId_userId: { organizationId, userId: run.createdById },
        },
        select: { id: true },
      })
    : null;
  if (!member) {
    await db.agentRun.updateMany({
      where: { ...where, status: "running" },
      data: {
        status: "failed",
        stopReason: "forbidden",
        error:
          "The person who started this run is no longer a member of this workspace.",
        finishedAt: new Date(),
      },
    });
    return { runId, skipped: "starter is no longer a member" };
  }

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
        timeoutMs: TURN_TIMEOUT_MS,
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
      read: (fn) =>
        readOnly(db, (tx) =>
          fn({ organizationId, userId: run.createdById, db: tx }),
        ),
      maxSteps: e.AGENT_MAX_STEPS,
      maxCostUsd: e.AGENT_MAX_COST_USD,
      turnTimeoutMs: deps.turnTimeoutMs ?? TURN_TIMEOUT_MS,
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
  // Only a run still "running": if the stale-run sweep (or a cancel of a run
  // presumed dead) settled it meanwhile, that outcome stands.
  const saved = await db.agentRun.updateMany({
    where: { ...where, status: "running" },
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
  if (saved.count === 0) {
    return {
      runId,
      skipped: "settled elsewhere while running (swept or cancelled)",
    };
  }
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
    propose(p) {
      return createProposal(db, {
        organizationId: run.organizationId,
        userId: run.userId,
        runId: run.runId,
        source: "agent",
        tool: p.tool,
        input: p.input,
        audit,
      });
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

/**
 * Runs a dead worker left "running": failed, so nobody waits on them. Called
 * from the 15-minute operator tick (packages/jobs).
 */
export async function abandonStaleRuns(
  db: PrismaClient = defaultDb,
  olderThanMs = runCutoffMs(),
  /** Only this tenant's runs (tests); default every tenant. */
  organizationId?: string,
): Promise<number> {
  const { count } = await db.agentRun.updateMany({
    where: {
      ...(organizationId ? { organizationId } : {}),
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
