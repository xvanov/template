/**
 * Email provider events, past the signature check (the route handler does it):
 *
 *   Resend (Svix-signed) — delivery events → outbound_message.deliveryStatus;
 *     a permanent bounce or a complaint also → the global suppression list;
 *     `email.received` → an inbound message (content fetched by the worker).
 *   generic (HMAC-signed) — the provider-agnostic inbound format
 *     (`genericInboundEmail`), for any other provider or a self-hosted MTA.
 */
import { z } from "zod";
import { db, recordAudit } from "@repo/db";
import { parseRecipient, recordDeliveryStatus, suppress } from "@repo/outbound";

import { intakeInbound, type IntakeResult } from "./intake";
import type { GenericInboundEmail } from "./process";
import { plainEmail } from "./routing";

/** The fields of a Resend webhook event this app reads. */
export const resendEvent = z.object({
  type: z.string(),
  created_at: z.string().optional(),
  data: z
    .object({
      email_id: z.string().optional(),
      from: z.string().optional(),
      to: z.array(z.string()).optional(),
      received_for: z.array(z.string()).optional(),
      subject: z.string().optional(),
      bounce: z
        .object({
          type: z.string().optional(),
          subType: z.string().optional(),
          message: z.string().optional(),
        })
        .optional(),
      failed: z.object({ reason: z.string().optional() }).optional(),
    })
    .passthrough(),
});
export type ResendEvent = z.infer<typeof resendEvent>;

/** Resend event type → outbound_message.deliveryStatus. */
const DELIVERY: Record<string, string> = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.delivery_delayed": "delayed",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.failed": "failed",
  "email.suppressed": "suppressed",
};

export type ResendOutcome =
  | { kind: "delivery"; status: string; matched: number; suppressed: boolean }
  | { kind: "inbound"; intake: IntakeResult }
  | { kind: "ignored"; type: string };

export async function handleResendEvent(
  event: ResendEvent,
): Promise<ResendOutcome> {
  const d = event.data;
  if (event.type === "email.received") {
    if (!d.email_id || !d.from) return { kind: "ignored", type: event.type };
    return {
      kind: "inbound",
      intake: await intakeInbound({
        channel: "email",
        provider: "resend",
        providerMessageId: d.email_id,
        from: d.from,
        to: [...(d.received_for ?? []), ...(d.to ?? [])],
        subject: d.subject ?? null,
        raw: { emailId: d.email_id },
      }),
    };
  }

  const status = DELIVERY[event.type];
  if (!status || !d.email_id) return { kind: "ignored", type: event.type };
  const detail =
    event.type === "email.bounced"
      ? [d.bounce?.type, d.bounce?.subType, d.bounce?.message]
          .filter(Boolean)
          .join(": ")
      : event.type === "email.failed"
        ? (d.failed?.reason ?? null)
        : undefined;
  const { matched } = await recordDeliveryStatus({
    channel: "email",
    providerMessageId: d.email_id,
    status,
    detail,
  });

  // Never mail this address again: a PERMANENT bounce (a transient one, a
  // full mailbox, is not a reason) or a spam complaint. Global: it is about
  // the address, not about which tenant last wrote to it.
  const permanent =
    event.type === "email.bounced" &&
    (d.bounce?.type ?? "").toLowerCase() === "permanent";
  const shouldSuppress = permanent || event.type === "email.complained";
  let suppressed = false;
  if (shouldSuppress) {
    for (const raw of d.to ?? []) {
      const address = plainEmail(raw);
      if (!address || !parseRecipient("email", address)) continue;
      await suppress({
        channel: "email",
        recipient: address,
        reason: `provider ${permanent ? "bounce" : "complaint"} (resend)`,
      });
      await recordAudit(db, {
        organizationId: null,
        actorType: "system",
        actorId: "webhook:email-events",
        action: "outbound.suppress",
        targetType: "recipient",
        targetId: address,
        metadata: { type: event.type, provider: "resend" },
      });
      suppressed = true;
    }
  }
  return { kind: "delivery", status, matched, suppressed };
}

/** The generic inbound webhook (already parsed with `genericInboundEmail`). */
export function intakeGenericEmail(
  message: GenericInboundEmail,
): Promise<IntakeResult> {
  return intakeInbound({
    channel: "email",
    provider: "generic",
    providerMessageId: message.id,
    from: message.from,
    to: message.to,
    subject: message.subject ?? null,
    raw: message,
  });
}
