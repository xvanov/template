/**
 * Agents against real Postgres: a run's trace and proposals, the approval
 * queue (approve once, edits re-validated, apply failures recorded), API
 * keys, and org isolation for every new table. The model is SCRIPTED (no
 * network); the worker's job body (executeRun) runs for real.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  abandonStaleRuns,
  defineReadTool,
  executeRun,
  runCutoffMs,
  startRun,
  type Audit,
  type Model,
} from "@repo/agent";
import type { ConverseResult, ToolCall } from "@repo/ai";
import { db, recordAudit } from "@repo/db";
import { createTenant, type TestTenant } from "@repo/db/testing";
import { resetEnvCache } from "@repo/env";

import { callerFor } from "./caller";

function reply(calls: ToolCall[] = [], text = ""): ConverseResult {
  return {
    model: "anthropic/claude-opus-5-5",
    servedBy: "anthropic/claude-opus-5-5",
    provider: "anthropic",
    tier: "default",
    usage: {
      inputTokens: 50,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    costUsd: 0.001,
    costKnown: true,
    latencyMs: 1,
    text,
    toolCalls: calls,
    stop: calls.length ? "tool_use" : "end",
    assistant: { role: "assistant", text, toolCalls: calls },
  };
}

const scripted =
  (...turns: ConverseResult[]): Model =>
  async () => {
    const t = turns.shift();
    if (!t) throw new Error("model called more often than scripted");
    return t;
  };

/** What the API's ctx.audit does, for runs started outside a request. */
const auditAs =
  (t: TestTenant): Audit =>
  (action, opts, client) =>
    recordAudit(client, {
      organizationId: t.organizationId,
      actorId: t.userId,
      action,
      targetType: opts.targetType ?? "agent_run",
      targetId: opts.targetId,
    });

/** A finished run that proposed creating "Buy milk" and deleting `deleteId`. */
async function runThatProposes(
  t: TestTenant,
  deleteId: string,
  reason = "it is a duplicate",
) {
  const run = await startRun(db, {
    organizationId: t.organizationId,
    userId: t.userId,
    goal: "tidy up",
    audit: auditAs(t),
  });
  const outcome = await executeRun(
    { organizationId: t.organizationId, runId: run.id },
    {
      model: scripted(
        reply([{ id: "c1", name: "items_search", input: {} }]),
        reply([
          { id: "c2", name: "items_create", input: { title: "Buy milk" } },
          {
            id: "c3",
            name: "items_delete",
            input: { id: deleteId, reason },
          },
        ]),
        reply([], "Proposed two changes."),
      ),
      notify: async () => ({ id: null, status: "logged", channel: "console" }),
    },
  );
  return { runId: run.id, outcome };
}

describe("agent runs", () => {
  it("records the trace and turns write calls into pending proposals — nothing is applied", async () => {
    const a = await createTenant("agent-run");
    const old = await callerFor(a).items.create({ title: "old thing" });

    const { runId, outcome } = await runThatProposes(a, old.id);
    expect(outcome).toMatchObject({
      status: "completed",
      stopReason: "done",
      turns: 3,
    });

    const run = await callerFor(a).agent.run({ id: runId });
    expect(run).toMatchObject({
      status: "completed",
      result: "Proposed two changes.",
      turns: 3,
    });
    expect(run.steps.map((s) => s.kind)).toEqual([
      "model",
      "tool_call",
      "tool_result",
      "model",
      "tool_call",
      "proposal",
      "tool_result",
      "tool_call",
      "proposal",
      "tool_result",
      "model",
    ]);
    // The read tool saw this tenant's item.
    expect(JSON.stringify(run.steps[2]!.payload)).toContain("old thing");
    expect(
      run.proposals.map((p) => [p.tool, p.status, p.summary, p.claim]),
    ).toEqual([
      ["items_create", "pending", 'Create item "Buy milk"', null],
      // The summary is the REAL title from the database; the model's reason
      // is kept apart, as its claim.
      [
        "items_delete",
        "pending",
        'Delete item "old thing"',
        "it is a duplicate",
      ],
    ]);
    // Who it was proposed for.
    expect(run.proposals.every((p) => p.proposedBy?.id === a.userId)).toBe(
      true,
    );
    // Nothing changed yet.
    expect((await callerFor(a).items.list()).map((i) => i.title)).toEqual([
      "old thing",
    ]);
    // A second delivery of the same job does not run it again.
    expect(
      await executeRun({ organizationId: a.organizationId, runId }),
    ).toMatchObject({ skipped: expect.any(String) });
  });

  it("a write call for another tenant's item is refused at proposal time", async () => {
    const a = await createTenant("agent-xa");
    const b = await createTenant("agent-xb");
    const bItem = await callerFor(b).items.create({ title: "B's" });

    const { runId } = await runThatProposes(a, bItem.id);
    const run = await callerFor(a).agent.run({ id: runId });
    expect(run.proposals.map((p) => p.tool)).toEqual(["items_create"]);
    expect(JSON.stringify(run.steps)).toContain(`No item ${bItem.id}`);
  });

  it("with AI off, a run fails fast with a clear reason and costs nothing", async () => {
    const a = await createTenant("agent-off");
    process.env.LLM_ENABLED = "false";
    resetEnvCache();
    try {
      const run = await startRun(db, {
        organizationId: a.organizationId,
        userId: a.userId,
        goal: "anything",
        audit: auditAs(a),
      });
      await executeRun({ organizationId: a.organizationId, runId: run.id });
      expect(await callerFor(a).agent.run({ id: run.id })).toMatchObject({
        status: "failed",
        stopReason: "disabled",
        error: expect.stringMatching(/^AI is not available/),
        turns: 0,
        costUsd: 0,
      });
    } finally {
      delete process.env.LLM_ENABLED;
      resetEnvCache();
    }
  });

  it("a model that lies in its reason cannot change what the reviewer is told is deleted", async () => {
    const a = await createTenant("agent-lie");
    const precious = await callerFor(a).items.create({ title: "Q3 contract" });
    const { runId } = await runThatProposes(
      a,
      precious.id,
      'this is just the empty "test" item',
    );
    const [, del] = (await callerFor(a).agent.run({ id: runId })).proposals;
    expect(del).toMatchObject({
      summary: 'Delete item "Q3 contract"',
      claim: 'this is just the empty "test" item',
    });
  });

  it("read tools run in a READ-ONLY transaction: one that tries to write fails", async () => {
    const a = await createTenant("agent-ro");
    const sneaky = defineReadTool({
      name: "sneaky",
      description: "pretends to read",
      input: z.object({}),
      run: (ctx) =>
        ctx.db.item.create({
          data: {
            organizationId: ctx.organizationId,
            createdById: ctx.userId!,
            title: "written by a read tool",
          },
        }),
    });
    const run = await startRun(db, {
      organizationId: a.organizationId,
      userId: a.userId,
      goal: "x",
      audit: auditAs(a),
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await executeRun(
      { organizationId: a.organizationId, runId: run.id },
      {
        tools: [sneaky],
        model: scripted(
          reply([{ id: "s", name: "sneaky", input: {} }]),
          reply([], "done"),
        ),
      },
    );
    spy.mockRestore();
    expect(
      await db.item.count({ where: { organizationId: a.organizationId } }),
    ).toBe(0);
    const trace = (await callerFor(a).agent.run({ id: run.id })).steps;
    expect(trace.find((s) => s.kind === "tool_result")!.payload).toMatchObject({
      isError: true,
      content: "The tool sneaky failed unexpectedly.",
    });
  });

  it("a run whose starter left the workspace fails at pickup and never calls the model", async () => {
    const a = await createTenant("agent-left");
    const run = await startRun(db, {
      organizationId: a.organizationId,
      userId: a.userId,
      goal: "x",
      audit: auditAs(a),
    });
    await db.member.deleteMany({
      where: { organizationId: a.organizationId, userId: a.userId },
    });
    const model = vi.fn<Model>();
    await executeRun(
      { organizationId: a.organizationId, runId: run.id },
      { model },
    );
    expect(model).not.toHaveBeenCalled();
    expect(
      await db.agentRun.findUniqueOrThrow({ where: { id: run.id } }),
    ).toMatchObject({ status: "failed", stopReason: "forbidden" });
  });

  it("a finished run does not overwrite the stale-run sweep's verdict", async () => {
    const a = await createTenant("agent-swept");
    const run = await startRun(db, {
      organizationId: a.organizationId,
      userId: a.userId,
      goal: "x",
      audit: auditAs(a),
    });
    // The sweep settles the run while the (slow) model turn is in flight.
    const model: Model = async () => {
      await abandonStaleRuns(db, -60_000, a.organizationId);
      return reply([], "too late");
    };
    const outcome = await executeRun(
      { organizationId: a.organizationId, runId: run.id },
      { model },
    );
    expect(outcome).toMatchObject({
      skipped: expect.stringMatching(/settled elsewhere/),
    });
    expect(
      await db.agentRun.findUniqueOrThrow({ where: { id: run.id } }),
    ).toMatchObject({ status: "failed", result: null });
  });

  it("the sweep fails only runs past the cutoff; Cancel ends a presumed-dead run at once", async () => {
    const a = await createTenant("agent-stale");
    const mk = async (startedAgoMs: number) => {
      const r = await startRun(db, {
        organizationId: a.organizationId,
        userId: a.userId,
        goal: "x",
        audit: auditAs(a),
      });
      await db.agentRun.update({
        where: { id: r.id },
        data: {
          status: "running",
          startedAt: new Date(Date.now() - startedAgoMs),
        },
      });
      return r.id;
    };
    const fresh = await mk(60_000);
    const dead = await mk(runCutoffMs() + 60_000);
    const deadToo = await mk(runCutoffMs() + 60_000);

    await callerFor(a).agent.cancel({ id: deadToo });
    expect(
      await db.agentRun.findUniqueOrThrow({ where: { id: deadToo } }),
    ).toMatchObject({ status: "cancelled" });
    await callerFor(a).agent.cancel({ id: fresh });
    // A live run only gets the request; its worker stops it.
    expect(
      await db.agentRun.findUniqueOrThrow({ where: { id: fresh } }),
    ).toMatchObject({ status: "running", cancelRequestedAt: expect.any(Date) });

    await abandonStaleRuns(db, undefined, a.organizationId);
    const status = async (id: string) =>
      (await db.agentRun.findUniqueOrThrow({ where: { id } })).status;
    expect(await status(dead)).toBe("failed");
    expect(await status(fresh)).toBe("running");
  });

  it("cancel: a queued run is cancelled at once and never runs", async () => {
    const a = await createTenant("agent-cancel");
    const run = await startRun(db, {
      organizationId: a.organizationId,
      userId: a.userId,
      goal: "x",
      audit: auditAs(a),
    });
    await callerFor(a).agent.cancel({ id: run.id });
    expect(
      await executeRun({ organizationId: a.organizationId, runId: run.id }),
    ).toMatchObject({ skipped: expect.any(String) });
    await expect(
      callerFor(a).agent.cancel({ id: run.id }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("the approval queue", () => {
  it("approve applies the change, as the reviewer, with audit events in the same transaction", async () => {
    const a = await createTenant("approve");
    const old = await callerFor(a).items.create({ title: "old thing" });
    await runThatProposes(a, old.id);
    const [create, remove] = await callerFor(a).agent.proposals();

    expect(await callerFor(a).agent.approve({ id: create!.id })).toMatchObject({
      status: "applied",
    });
    expect(await callerFor(a).agent.approve({ id: remove!.id })).toMatchObject({
      status: "applied",
    });
    expect((await callerFor(a).items.list()).map((i) => i.title)).toEqual([
      "Buy milk",
    ]);
    expect(await callerFor(a).agent.proposals()).toEqual([]);
    const applied = await callerFor(a).agent.proposals({
      status: "applied",
      limit: 10,
    });
    expect(applied.every((p) => p.reviewer?.id === a.userId)).toBe(true);

    const actions = (await callerFor(a).activity.audit()).map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "agent.proposal.approve",
        "item.create",
        "item.delete",
      ]),
    );
  });

  it("a proposal is decided once: two concurrent approvals apply it exactly once", async () => {
    const a = await createTenant("race");
    const p = await callerFor(a).agent.propose({
      tool: "items_create",
      input: { title: "only once" },
    });
    const results = await Promise.allSettled([
      callerFor(a).agent.approve({ id: p.id }),
      callerFor(a).agent.approve({ id: p.id }),
      callerFor(a).agent.reject({ id: p.id }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((r) => r.status === "rejected")) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({
        code: "CONFLICT",
      });
    }
    const made = await db.item.count({
      where: { organizationId: a.organizationId, title: "only once" },
    });
    const status = (
      await db.agentProposal.findUniqueOrThrow({ where: { id: p.id } })
    ).status;
    expect(made).toBe(status === "applied" ? 1 : 0);
  });

  it("an edited input is re-validated; a valid edit is what gets applied", async () => {
    const a = await createTenant("edit");
    const p = await callerFor(a).agent.propose({
      tool: "items_create",
      input: { title: "Buy mlik" },
    });
    await expect(
      callerFor(a).agent.approve({ id: p.id, input: { title: "" } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // Still pending after a bad edit.
    expect((await callerFor(a).agent.proposals()).map((x) => x.id)).toEqual([
      p.id,
    ]);

    await callerFor(a).agent.approve({
      id: p.id,
      input: { title: "Buy milk" },
    });
    expect((await callerFor(a).items.list()).map((i) => i.title)).toEqual([
      "Buy milk",
    ]);
    const done = await callerFor(a).agent.proposals({
      status: "applied",
      limit: 5,
    });
    expect(done[0]).toMatchObject({
      input: { title: "Buy mlik" },
      editedInput: { title: "Buy milk" },
    });
  });

  it("when the world changed since the proposal, approve records a failure and changes nothing", async () => {
    const a = await createTenant("stale");
    const item = await callerFor(a).items.create({ title: "doomed" });
    const p = await callerFor(a).agent.propose({
      tool: "items_delete",
      input: { id: item.id },
    });
    await callerFor(a).items.remove({ id: item.id });

    expect(await callerFor(a).agent.approve({ id: p.id })).toEqual({
      status: "failed",
      error: "Item not found.",
    });
    const [failed] = await callerFor(a).agent.proposals({
      status: "failed",
      limit: 5,
    });
    expect(failed).toMatchObject({
      id: p.id,
      error: "Item not found.",
    });
    // The failed apply's own audit row, not an "approve" one.
    const actions = (await callerFor(a).activity.audit()).map((e) => e.action);
    expect(actions).toContain("agent.proposal.fail");
    expect(actions).not.toContain("agent.proposal.approve");
  });

  it("propose refuses unknown tools and invalid input", async () => {
    const a = await createTenant("propose-bad");
    await expect(
      callerFor(a).agent.propose({ tool: "items_search", input: {} }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      callerFor(a).agent.propose({ tool: "items_create", input: { title: 5 } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("org isolation: agent runs, steps, proposals, API keys", () => {
  it("another tenant can neither see nor act on any of them", async () => {
    const a = await createTenant("iso-a");
    const b = await createTenant("iso-b");
    const old = await callerFor(a).items.create({ title: "A's" });
    const { runId } = await runThatProposes(a, old.id);
    const [proposal] = await callerFor(a).agent.proposals();
    const key = await callerFor(a).apiKeys.create({ name: "ci" });

    expect(await callerFor(b).agent.runs()).toEqual([]);
    expect(await callerFor(b).agent.proposals()).toEqual([]);
    expect(await callerFor(b).apiKeys.list()).toEqual([]);
    for (const attempt of [
      () => callerFor(b).agent.run({ id: runId }),
      () => callerFor(b).agent.cancel({ id: runId }),
      () => callerFor(b).agent.approve({ id: proposal!.id }),
      () => callerFor(b).agent.reject({ id: proposal!.id }),
      () => callerFor(b).apiKeys.revoke({ id: key.id }),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    // Nothing of A's moved.
    expect((await callerFor(a).agent.proposals()).length).toBe(2);
    expect((await callerFor(a).apiKeys.list())[0]).toMatchObject({
      id: key.id,
      revokedAt: null,
    });
  });
});

describe("API keys", () => {
  it("owners create (secret shown once, only its hash stored) and revoke; members cannot", async () => {
    const a = await createTenant("keys");
    const key = await callerFor(a).apiKeys.create({ name: "laptop" });
    expect(key.secret).toMatch(/^tk_[A-Za-z0-9_-]{43}$/);
    const row = await db.apiKey.findUniqueOrThrow({ where: { id: key.id } });
    expect(JSON.stringify(row)).not.toContain(key.secret);
    expect(await callerFor(a).apiKeys.list()).toEqual([
      expect.not.objectContaining({ secret: expect.anything() }),
    ]);

    await callerFor(a).apiKeys.revoke({ id: key.id });
    await expect(
      callerFor(a).apiKeys.revoke({ id: key.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const actions = (await callerFor(a).activity.audit()).map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(["api_key.create", "api_key.revoke"]),
    );

    await db.member.updateMany({
      where: { organizationId: a.organizationId, userId: a.userId },
      data: { role: "member" },
    });
    await expect(callerFor(a).apiKeys.list()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
