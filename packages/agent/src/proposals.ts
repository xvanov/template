/**
 * Proposals: write-tool calls waiting for a person.
 *
 *   pending ──approve──▶ applied   (apply ran and committed)
 *      │          └────▶ failed    (apply threw: the world changed, e.g. the
 *      │                            item is gone; the message says why)
 *      └────reject───▶ rejected
 *
 * Decided ONCE. Every transition is `updateMany` with `status: "pending"` (and
 * the tenant) in the `where`, so of two concurrent approvals exactly one
 * matches a row; the other gets ConflictError. Approve claims the row, runs
 * the tool's `apply` and writes the audit events in ONE transaction: a
 * proposal is never marked applied for a change that rolled back, nor a
 * change committed without its proposal saying so.
 *
 * The input applied is the reviewer's edit if there is one, re-validated
 * against the tool's schema here — an edit is untrusted input like any other.
 */
import type { AuditWriter, Prisma, PrismaClient } from "@repo/db";

import {
  ConflictError,
  DomainRuleError,
  isExpected,
  NotFoundError,
} from "./errors";
import { writeTool } from "./registry";
import { issuesLine, readOnly, type ToolContext, type WriteTool } from "./tool";

/** ctx.audit's shape in packages/api: (action, opts, client). */
export type Audit = (
  action: string,
  opts: {
    targetType?: string;
    targetId?: string | null;
    metadata?: Prisma.InputJsonValue;
  },
  client: AuditWriter,
) => Promise<void>;

export type ProposalSource = "agent" | "mcp" | "user";

/**
 * A write-tool call checked and described: validated against the tool's
 * schema and summarised from the database (read-only). Throws
 * DomainRuleError / NotFoundError when it makes no sense. Shared by
 * createProposal and the loop's unit tests.
 */
export async function prepareProposal(
  tool: WriteTool,
  ctx: ToolContext,
  input: unknown,
): Promise<{ input: unknown; summary: string; claim: string | null }> {
  const parsed = tool.input.safeParse(input);
  if (!parsed.success) {
    throw new DomainRuleError(`Invalid input: ${issuesLine(parsed.error)}`);
  }
  const summary = (await tool.summarize(ctx, parsed.data)).slice(0, 300);
  const claim = tool.claim?.(parsed.data)?.trim().slice(0, 500) || null;
  return { input: parsed.data, summary, claim };
}

/**
 * Validate a write-tool call and queue it, recording who proposed it (the
 * user the run or key acts for, and the API key if any). Throws
 * DomainRuleError for an unknown tool or an invalid input, and whatever the
 * tool's `summarize` throws (NotFoundError for an id not in this tenant).
 */
export async function createProposal(
  db: PrismaClient,
  args: {
    organizationId: string;
    userId: string | null;
    apiKeyId?: string | null;
    runId?: string | null;
    source: ProposalSource;
    tool: string;
    input: unknown;
    audit: Audit;
  },
): Promise<{ id: string; summary: string }> {
  const tool = writeTool(args.tool);
  if (!tool) throw new DomainRuleError(`Unknown write tool ${args.tool}.`);
  const prepared = await readOnly(db, (tx) =>
    prepareProposal(
      tool,
      { organizationId: args.organizationId, userId: args.userId, db: tx },
      args.input,
    ),
  );

  return db.$transaction(async (tx) => {
    const p = await tx.agentProposal.create({
      data: {
        organizationId: args.organizationId,
        runId: args.runId ?? null,
        source: args.source,
        proposedById: args.userId,
        apiKeyId: args.apiKeyId ?? null,
        tool: tool.name,
        input: prepared.input as Prisma.InputJsonValue,
        summary: prepared.summary,
        claim: prepared.claim,
      },
      select: { id: true },
    });
    await args.audit(
      "agent.proposal.create",
      {
        targetType: "agent_proposal",
        targetId: p.id,
        metadata: {
          tool: tool.name,
          source: args.source,
          runId: args.runId ?? null,
        },
      },
      tx,
    );
    return { id: p.id, summary: prepared.summary };
  });
}

export type ApproveResult =
  { status: "applied"; result: unknown } | { status: "failed"; error: string };

/** Thrown inside the transaction when another decision got there first. */
class LostRace extends Error {}

export async function approveProposal(
  db: PrismaClient,
  args: {
    organizationId: string;
    proposalId: string;
    reviewerId: string;
    /** The reviewer's edit; validated against the tool's schema. */
    editedInput?: unknown;
    audit: Audit;
  },
): Promise<ApproveResult> {
  const where = { id: args.proposalId, organizationId: args.organizationId };
  const p = await db.agentProposal.findFirst({
    where,
    select: { tool: true, input: true, status: true },
  });
  // Same error whether it is absent or another tenant's.
  if (!p) throw new NotFoundError("Proposal not found.");
  if (p.status !== "pending") {
    throw new ConflictError(`This proposal was already ${p.status}.`);
  }
  const tool = writeTool(p.tool);
  if (!tool) {
    throw new DomainRuleError(
      `The tool ${p.tool} no longer exists. Reject this proposal.`,
    );
  }
  const edited = args.editedInput !== undefined;
  const parsed = tool.input.safeParse(edited ? args.editedInput : p.input);
  if (!parsed.success) {
    throw new DomainRuleError(`Invalid input: ${issuesLine(parsed.error)}`);
  }

  try {
    return await db.$transaction(async (tx) => {
      const claimed = await tx.agentProposal.updateMany({
        where: { ...where, status: "pending" },
        data: {
          status: "applied",
          reviewerId: args.reviewerId,
          decidedAt: new Date(),
          ...(edited
            ? { editedInput: parsed.data as Prisma.InputJsonValue }
            : {}),
        },
      });
      if (claimed.count === 0) throw new LostRace();
      const result = await tool.apply(
        {
          organizationId: args.organizationId,
          userId: args.reviewerId,
          tx,
          audit: (action, opts) => args.audit(action, opts, tx),
        },
        parsed.data,
      );
      await tx.agentProposal.updateMany({
        where,
        data: { result: toJson(result) },
      });
      await args.audit(
        "agent.proposal.approve",
        {
          targetType: "agent_proposal",
          targetId: args.proposalId,
          metadata: { tool: tool.name, edited },
        },
        tx,
      );
      return { status: "applied" as const, result };
    });
  } catch (err) {
    if (err instanceof LostRace) {
      throw new ConflictError("This proposal was already decided.");
    }
    // apply said no (or broke): the transaction rolled back, the proposal is
    // still pending. Record the failure, unless someone decided it meanwhile.
    const error = isExpected(err)
      ? err.message
      : "Applying this proposal failed unexpectedly.";
    if (!isExpected(err)) console.error("[agent] apply failed:", err);
    await db.$transaction(async (tx) => {
      const { count } = await tx.agentProposal.updateMany({
        where: { ...where, status: "pending" },
        data: {
          status: "failed",
          reviewerId: args.reviewerId,
          decidedAt: new Date(),
          error,
          ...(edited
            ? { editedInput: parsed.data as Prisma.InputJsonValue }
            : {}),
        },
      });
      if (count === 0) return;
      await args.audit(
        "agent.proposal.fail",
        {
          targetType: "agent_proposal",
          targetId: args.proposalId,
          metadata: { tool: tool.name, error },
        },
        tx,
      );
    });
    return { status: "failed", error };
  }
}

export async function rejectProposal(
  db: PrismaClient,
  args: {
    organizationId: string;
    proposalId: string;
    reviewerId: string;
    reason?: string;
    audit: Audit;
  },
): Promise<void> {
  const where = { id: args.proposalId, organizationId: args.organizationId };
  await db.$transaction(async (tx) => {
    const { count } = await tx.agentProposal.updateMany({
      where: { ...where, status: "pending" },
      data: {
        status: "rejected",
        reviewerId: args.reviewerId,
        decidedAt: new Date(),
        error: args.reason ?? null,
      },
    });
    if (count === 0) {
      const p = await tx.agentProposal.findFirst({
        where,
        select: { status: true },
      });
      if (!p) throw new NotFoundError("Proposal not found.");
      throw new ConflictError(`This proposal was already ${p.status}.`);
    }
    await args.audit(
      "agent.proposal.reject",
      {
        targetType: "agent_proposal",
        targetId: args.proposalId,
        metadata: args.reason ? { reason: args.reason } : {},
      },
      tx,
    );
  });
}

function toJson(value: unknown): Prisma.InputJsonValue {
  try {
    return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
  } catch {
    return String(value);
  }
}
