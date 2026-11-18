/**
 * The two operator controls that live in the database rather than in env:
 * the runtime kill switch and the suppression list. Database, not Redis,
 * because both must survive a Redis restart: a kill switch that silently
 * resets is worse than none.
 */
import { db, type PrismaClient } from "@repo/db";

import { parseRecipient, type Channel } from "./policy";

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
 * process. For operators: `npm run outbound:freeze -- on [email]`.
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
  const recipient = parseRecipient(input.channel, input.recipient);
  if (!recipient)
    throw new Error(`suppress: not a plain address: ${input.recipient}`);
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
      recipient: parseRecipient(channel, recipient) ?? recipient,
      OR: [
        { organizationId: null },
        ...(organizationId ? [{ organizationId }] : []),
      ],
    },
    select: { reason: true, organizationId: true },
  });
}

/**
 * Lift a suppression the RECIPIENT asked for and has now taken back (an SMS
 * "START" after "STOP"). Only rows whose reason starts with `reasonPrefix` go:
 * a hard bounce or a complaint is not the recipient's to undo by text.
 */
export async function unsuppress(
  input: {
    channel: Channel;
    recipient: string;
    reasonPrefix: string;
    organizationId?: string | null;
  },
  client: Db = db,
): Promise<number> {
  const recipient = parseRecipient(input.channel, input.recipient);
  if (!recipient) return 0;
  const { count } = await client.outboundSuppression.deleteMany({
    where: {
      channel: input.channel,
      recipient,
      organizationId: input.organizationId ?? null,
      reason: { startsWith: input.reasonPrefix },
    },
  });
  return count;
}

/**
 * Delivery states a provider reports after accepting a message, ranked so a
 * late or repeated callback cannot move a message backwards: Twilio may post
 * "sent" after "delivered", and every provider retries its webhooks.
 */
const DELIVERY_RANK: Record<string, number> = {
  queued: 0,
  accepted: 0,
  sending: 1,
  sent: 1,
  delayed: 2,
  // We stopped asking: the provider gave no final word in the time it keeps
  // one (Expo push receipts, about a day). A later real answer still wins.
  unconfirmed: 2,
  delivered: 3,
  undelivered: 3,
  failed: 3,
  bounced: 3,
  suppressed: 3,
  // Above delivered: a complaint arrives after delivery and is the worst news.
  complained: 4,
};

export const DELIVERY_STATUSES = Object.keys(DELIVERY_RANK);

/** Would moving from `prior` to `next` be progress (or the same state)? */
export function deliveryAdvances(
  prior: string | null | undefined,
  next: string,
): boolean {
  const n = DELIVERY_RANK[next];
  if (n === undefined) return false;
  if (!prior) return true;
  return n >= (DELIVERY_RANK[prior] ?? -1);
}

/**
 * Record what the provider says happened to a message it accepted, by the
 * provider's message id. Idempotent, and never moves a message backwards
 * (see DELIVERY_RANK). Returns how many outbound_message rows matched: zero
 * is normal for a message sent before tracking, or by another app sharing
 * the provider account.
 */
export async function recordDeliveryStatus(
  input: {
    channel: Channel;
    providerMessageId: string;
    status: string;
    detail?: string | null;
  },
  client: Pick<PrismaClient, "outboundMessage"> = db,
): Promise<{ matched: number; updated: number }> {
  const rows = await client.outboundMessage.findMany({
    where: {
      channel: input.channel,
      providerMessageId: input.providerMessageId,
    },
    select: { id: true, deliveryStatus: true },
  });
  let updated = 0;
  for (const row of rows) {
    if (!deliveryAdvances(row.deliveryStatus, input.status)) continue;
    // Compare-and-set on the status we read, so two concurrent callbacks
    // cannot interleave into a regression.
    const r = await client.outboundMessage.updateMany({
      where: { id: row.id, deliveryStatus: row.deliveryStatus },
      data: {
        deliveryStatus: input.status,
        ...(input.detail !== undefined
          ? { deliveryDetail: input.detail?.slice(0, 1000) ?? null }
          : {}),
        deliveryUpdatedAt: new Date(),
      },
    });
    updated += r.count;
  }
  return { matched: rows.length, updated };
}
