/**
 * Resend webhook events about mail WE sent, past the signature check (the
 * route handler, /api/webhooks/email-events, does it):
 *
 *   delivery events → outbound_message.deliveryStatus, matched on the id
 *     Resend returned when it accepted the message;
 *   a permanent bounce or a complaint → also the global suppression list.
 *
 * Mail that ARRIVES (`email.received`) is packages/inbound's, not this file's.
 */
import { z } from "zod";
import { db, recordAudit } from "@repo/db";
import { parseRecipient, recordDeliveryStatus, suppress } from "@repo/outbound";

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

/** `Name <a@x>` or `a@x` → the normalised address, else null. */
export function plainEmail(raw: string): string | null {
  const inner = /<([^<>]+)>\s*$/.exec(raw.trim())?.[1] ?? raw;
  return parseRecipient("email", inner);
}

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

export type ResendDeliveryOutcome =
  | { kind: "delivery"; status: string; matched: number; suppressed: boolean }
  | { kind: "ignored"; type: string };

export async function handleResendDelivery(
  event: ResendEvent,
): Promise<ResendDeliveryOutcome> {
  const d = event.data;
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
