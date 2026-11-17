/**
 * What an agent tool is. (Interface members use method syntax on purpose:
 * it lets a ReadTool<ZodObject<...>> sit in a list of ReadTool.)
 *
 *   read   runs as soon as the model calls it, inside the run (in the worker).
 *          Must not change anything.
 *   write  NEVER runs inside the run. A call becomes an agent_proposal row; a
 *          person approves (optionally editing the input), and only then does
 *          `apply` run — inside the approve mutation's transaction, with the
 *          reviewer as the actor, next to the proposal's own status change
 *          and audit events. Approve is all-or-nothing.
 *
 * Every input is a zod schema: it is the JSON Schema the model sees, and it
 * is checked again on every path that could run the tool (the model's call,
 * a reviewer's edit, an MCP client).
 *
 * Every database access takes the tenant from the context, never from the
 * input: `where: { organizationId: ctx.organizationId, ... }` always.
 */
import type { AuditWriter, Prisma, PrismaClient } from "@repo/db";
import { z } from "zod";

/** Anthropic and OpenAI both require this (no dots). */
export const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export interface ToolContext {
  organizationId: string;
  /** Who the run (or the MCP key) acts for. Null if that user was deleted. */
  userId: string | null;
  db: PrismaClient;
}

/** Writes an audit event as the reviewer, in the approve transaction. */
export type ApplyAudit = (
  action: string,
  opts: {
    targetType?: string;
    targetId?: string | null;
    metadata?: Prisma.InputJsonValue;
  },
) => Promise<void>;

export interface ApplyContext {
  organizationId: string;
  /** The reviewer who approved: the actor of whatever apply changes. */
  userId: string;
  /** The approve transaction. Use it for every write. */
  tx: Prisma.TransactionClient;
  audit: ApplyAudit;
}

interface ToolBase<S extends z.ZodType> {
  name: string;
  /** What the model reads to decide when to call it. */
  description: string;
  input: S;
}

export interface ReadTool<S extends z.ZodType = z.ZodType> extends ToolBase<S> {
  effect: "read";
  /** The result goes back to the model as JSON. Throw a typed error for "no". */
  run(ctx: ToolContext, input: z.infer<S>): Promise<unknown>;
}

export interface WriteTool<
  S extends z.ZodType = z.ZodType,
> extends ToolBase<S> {
  effect: "write";
  /** One line for the approval queue: what applying this would do. */
  describe(input: z.infer<S>): string;
  /**
   * Optional, at proposal time: why this proposal makes no sense (an id that
   * does not exist in this tenant). The model gets the message back as a
   * tool error instead of a proposal. Return null when fine.
   */
  check?(ctx: ToolContext, input: z.infer<S>): Promise<string | null>;
  /**
   * Do it. Runs only on approval, in the approve transaction: database writes
   * only, through `ctx.tx`, with an audit event per change. For a side
   * effect outside the database (email, a third-party API), enqueue a job
   * from here instead, and have the job re-check the proposal is `applied`.
   * Throw NotFoundError / DomainRuleError when the world changed since the
   * proposal (the item is gone): the proposal is marked failed with that
   * message.
   */
  apply(ctx: ApplyContext, input: z.infer<S>): Promise<unknown>;
}

export type AgentTool = ReadTool | WriteTool;

export function defineReadTool<S extends z.ZodType>(
  tool: Omit<ReadTool<S>, "effect">,
): ReadTool<S> {
  return { ...tool, effect: "read" };
}

export function defineWriteTool<S extends z.ZodType>(
  tool: Omit<WriteTool<S>, "effect">,
): WriteTool<S> {
  return { ...tool, effect: "write" };
}

/** The model's view of a tool: name, description, JSON Schema. */
export function toolSpec(tool: AgentTool) {
  // `$schema` names draft 2020-12, which some validators reject; the body is
  // plain enough for every provider without it.
  const { $schema: _draft, ...inputSchema } = z.toJSONSchema(tool.input, {
    io: "input",
  }) as Record<string, unknown>;
  return {
    name: tool.name,
    description:
      tool.effect === "write"
        ? `${tool.description} This does NOT act: it queues a proposal that a person approves or rejects later.`
        : tool.description,
    inputSchema,
  };
}

/** Zod issues as one line the model (or a reviewer) can act on. */
export function issuesLine(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`)
    .join("; ");
}

export type { AuditWriter };
