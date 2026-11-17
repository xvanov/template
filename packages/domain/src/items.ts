/**
 * The Item domain: the input rules and the writes, defined ONCE and called by
 * both the tRPC items router and the agent's item tools (packages/agent), so
 * a title limit or an audit action cannot drift between the two.
 *
 * Each write takes the transaction, the actor (tenant + user, from the
 * caller's context — never from the input) and an audit function already
 * bound to that transaction, so the audit row commits with the change.
 * Writes use updateMany/deleteMany with the org in the `where`, and throw
 * NotFoundError for a row that is absent OR another tenant's (the same error
 * for both, so an id's existence is never confirmed).
 */
import type { Prisma } from "@repo/db";
import { z } from "zod";

import { NotFoundError } from "./errors";

export const itemTitle = z.string().trim().min(1, "Title is required").max(200);
export const itemNotes = z.string().trim().max(2000);
export const itemId = z.string().min(1).max(64);

export const createItemInput = z.object({
  title: itemTitle,
  notes: itemNotes.optional(),
});
export const setItemDoneInput = z.object({ id: itemId, done: z.boolean() });
export const removeItemInput = z.object({ id: itemId });

export interface Actor {
  organizationId: string;
  userId: string;
}

/** Writes one audit event in the caller's transaction, as the caller. */
export type DomainAudit = (
  action: string,
  opts: { targetId?: string | null; metadata?: Prisma.InputJsonValue },
) => Promise<void>;

type Tx = Prisma.TransactionClient;

const NOT_FOUND = "Item not found.";

export async function createItem(
  tx: Tx,
  actor: Actor,
  input: z.infer<typeof createItemInput>,
  audit: DomainAudit,
) {
  const item = await tx.item.create({
    data: {
      organizationId: actor.organizationId,
      title: input.title,
      notes: input.notes,
      createdById: actor.userId,
    },
    select: { id: true, title: true, notes: true, done: true, createdAt: true },
  });
  await audit("item.create", {
    targetId: item.id,
    metadata: { title: item.title },
  });
  return item;
}

export async function setItemDone(
  tx: Tx,
  actor: Actor,
  input: z.infer<typeof setItemDoneInput>,
  audit: DomainAudit,
) {
  const { count } = await tx.item.updateMany({
    where: { id: input.id, organizationId: actor.organizationId },
    data: { done: input.done },
  });
  if (count === 0) throw new NotFoundError(NOT_FOUND);
  await audit("item.update", {
    targetId: input.id,
    metadata: { done: input.done },
  });
  return { id: input.id, done: input.done };
}

export async function removeItem(
  tx: Tx,
  actor: Actor,
  input: z.infer<typeof removeItemInput>,
  audit: DomainAudit,
) {
  const { count } = await tx.item.deleteMany({
    where: { id: input.id, organizationId: actor.organizationId },
  });
  if (count === 0) throw new NotFoundError(NOT_FOUND);
  await audit("item.delete", { targetId: input.id });
  return { id: input.id };
}

/** One item of this tenant, or null (absent or another tenant's). */
export function findItem(
  db: Tx,
  organizationId: string,
  id: string,
): Promise<{ id: string; title: string; done: boolean } | null> {
  return db.item.findFirst({
    where: { id, organizationId },
    select: { id: true, title: true, done: true },
  });
}
