/**
 * The two operator controls that live in the database rather than in env:
 * the runtime kill switch and the suppression list. Database, not Redis,
 * because both must survive a Redis restart: a kill switch that silently
 * resets is worse than none.
 */
import { db, type PrismaClient } from "@repo/db";

import { normalizeRecipient, type Channel } from "./policy";

const FREEZE_KEY = "outbound.freeze";

export type FreezeScope = Channel | "all";
type FreezeState = Partial<Record<FreezeScope, boolean>>;

type Db = Pick<PrismaClient, "appSetting" | "outboundSuppression">;

/** Is the runtime kill switch on for this channel (or for everything)? */
export async function isFrozen(
  channel: Channel,
  client: Db = db,
): Promise<boolean> {
  const row = await client.appSetting.findUnique({
    where: { key: FREEZE_KEY },
  });
  const state = (row?.value ?? {}) as FreezeState;
  return Boolean(state.all || state[channel]);
}

/**
 * Flip the runtime kill switch. Takes effect on the very next send, in every
 * process. For operators: `npm run outbound:freeze -- on [email|sms|push]`.
 */
export async function setFrozen(
  scope: FreezeScope,
  frozen: boolean,
  updatedBy: string,
  client: Db = db,
): Promise<FreezeState> {
  const row = await client.appSetting.findUnique({
    where: { key: FREEZE_KEY },
  });
  const value: FreezeState = {
    ...((row?.value ?? {}) as FreezeState),
    [scope]: frozen,
  };
  await client.appSetting.upsert({
    where: { key: FREEZE_KEY },
    create: { key: FREEZE_KEY, value, updatedBy },
    update: { value, updatedBy },
  });
  return value;
}

/**
 * Never message this recipient again: everywhere (organizationId null, e.g. a
 * hard bounce or a spam complaint) or for one tenant (an unsubscribe).
 */
export async function suppress(
  input: {
    channel: Channel;
    recipient: string;
    reason: string;
    organizationId?: string | null;
  },
  client: Db = db,
): Promise<void> {
  const recipient = normalizeRecipient(input.channel, input.recipient);
  const organizationId = input.organizationId ?? null;
  // findFirst + create, not upsert: Postgres treats NULLs as distinct in the
  // unique index, so an upsert on a null org could not find its own row.
  const existing = await client.outboundSuppression.findFirst({
    where: { channel: input.channel, recipient, organizationId },
    select: { id: true },
  });
  if (existing) return;
  await client.outboundSuppression.create({
    data: {
      channel: input.channel,
      recipient,
      organizationId,
      reason: input.reason,
    },
  });
}

/** The suppression that blocks this message, if any (global or this tenant's). */
export async function findSuppression(
  channel: Channel,
  recipient: string,
  organizationId: string | null | undefined,
  client: Db = db,
): Promise<{ reason: string; organizationId: string | null } | null> {
  return client.outboundSuppression.findFirst({
    where: {
      channel,
      recipient: normalizeRecipient(channel, recipient),
      OR: [
        { organizationId: null },
        ...(organizationId ? [{ organizationId }] : []),
      ],
    },
    select: { reason: true, organizationId: true },
  });
}
