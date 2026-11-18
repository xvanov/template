/**
 * The request half of an inbound message: route it to a tenant and store a
 * "received" row with what the provider sent, so a webhook answers fast and
 * the worker (`inbound.process`, ./process.ts) does the slow part: fetching
 * the body, attachments into storage, threading.
 *
 * Idempotent: providers retry webhooks, and the row is unique on
 * (provider, providerMessageId). A retry of one already stored reports
 * "duplicate", with `needsProcessing` still true while the worker has not
 * finished it, so the caller can enqueue again (Redis may have been down the
 * first time; the job id dedupes a job that is still queued).
 */
import { db as defaultDb, Prisma, type PrismaClient } from "@repo/db";

import { routeEmail, routeSms, type InboundChannel } from "./routing";

export type InboundProvider = "resend" | "generic" | "twilio";

export interface InboundEnvelope {
  channel: InboundChannel;
  provider: InboundProvider;
  providerMessageId: string;
  from: string;
  /** Every recipient the provider says it was for, envelope ones first. */
  to: readonly string[];
  subject?: string | null;
  /** What the worker needs to finish it (the provider's payload). */
  raw: Prisma.InputJsonValue;
  /** Stored as already handled (an SMS STOP/START keyword, say). */
  handled?: boolean;
}

export type IntakeResult =
  | { outcome: "unrouted" }
  | {
      outcome: "created" | "duplicate";
      id: string;
      organizationId: string;
      needsProcessing: boolean;
    };

type Db = Pick<
  PrismaClient,
  "inboundMessage" | "inboundRoute" | "outboundMessage"
>;

export async function intakeInbound(
  input: InboundEnvelope,
  client: Db = defaultDb,
): Promise<IntakeResult> {
  const providerMessageId = input.providerMessageId.slice(0, 200);
  const existing = await findExisting(
    input.provider,
    providerMessageId,
    client,
  );
  if (existing) return existing;

  const route =
    input.channel === "sms"
      ? await routeSms(input.from, input.to[0] ?? "", client)
      : await routeEmail(input.to, client);
  if (!route) return { outcome: "unrouted" };

  try {
    const row = await client.inboundMessage.create({
      data: {
        organizationId: route.organizationId,
        channel: input.channel,
        provider: input.provider,
        providerMessageId,
        fromAddress: input.from.trim().slice(0, 320),
        toAddress: route.address.slice(0, 320),
        subject: input.subject?.slice(0, 500) ?? null,
        raw: input.raw,
        ...(input.handled ? { handledAt: new Date() } : {}),
      },
      select: { id: true, organizationId: true },
    });
    return { outcome: "created", ...row, needsProcessing: true };
  } catch (err) {
    // A concurrent delivery of the same message won the insert.
    if ((err as { code?: string }).code === "P2002") {
      const raced = await findExisting(
        input.provider,
        providerMessageId,
        client,
      );
      if (raced) return raced;
    }
    throw err;
  }
}

async function findExisting(
  provider: InboundProvider,
  providerMessageId: string,
  client: Db,
): Promise<IntakeResult | null> {
  const row = await client.inboundMessage.findUnique({
    where: { provider_providerMessageId: { provider, providerMessageId } },
    select: { id: true, organizationId: true, status: true },
  });
  return row
    ? {
        outcome: "duplicate",
        id: row.id,
        organizationId: row.organizationId,
        needsProcessing: row.status === "received",
      }
    : null;
}
