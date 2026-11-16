/**
 * The audit trail: one append-only row per meaningful action.
 *
 * In a tRPC resolver use `ctx.audit(...)` (packages/api), which fills in the
 * actor, tenant, IP and user agent from the request. This lower-level function
 * is for code outside a request (jobs, scripts) and for that helper.
 *
 * Pass a transaction client as `client` to make the audit row commit or roll
 * back WITH the change it describes. An audit row for a change that did not
 * happen, or a change with no audit row, are both lies.
 */
import type { Prisma, PrismaClient } from "../generated/client";

export type AuditActorType = "user" | "system" | "job";

export interface AuditInput {
  organizationId: string | null;
  actorType?: AuditActorType;
  actorId?: string | null;
  /** Dotted verb, `<target>.<verb>`: `item.create`, `item.delete`. */
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Prisma.InputJsonValue;
  ip?: string | null;
  userAgent?: string | null;
}

/** Anything with an `auditEvent` delegate: the client or a transaction. */
export type AuditWriter = Pick<PrismaClient, "auditEvent">;

export async function recordAudit(
  client: AuditWriter,
  input: AuditInput,
): Promise<void> {
  await client.auditEvent.create({
    data: {
      organizationId: input.organizationId,
      actorType: input.actorType ?? "user",
      actorId: input.actorId ?? null,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      metadata: input.metadata,
      ip: truncate(input.ip, 64),
      userAgent: truncate(input.userAgent, 512),
    },
  });
}

function truncate(value: string | null | undefined, max: number) {
  return value ? value.slice(0, max) : null;
}
