/**
 * Email that ARRIVES, past the signature check (the route handlers do it):
 *
 *   Resend (Svix-signed) `email.received` → an inbound message (content
 *     fetched by the worker). Resend's delivery events are packages/email's.
 *   generic (HMAC-signed) — the provider-agnostic inbound format
 *     (`genericInboundEmail`), for any other provider or a self-hosted MTA.
 */
import type { ResendEvent } from "@repo/email";

import { intakeInbound, type IntakeResult } from "./intake";
import type { GenericInboundEmail } from "./process";

/**
 * Resend's `email.received`: store it for the worker to finish. Null for any
 * other event type, or one without the fields to store it by.
 */
export async function handleResendReceived(
  event: ResendEvent,
): Promise<IntakeResult | null> {
  const d = event.data;
  if (event.type !== "email.received" || !d.email_id || !d.from) return null;
  return intakeInbound({
    channel: "email",
    provider: "resend",
    providerMessageId: d.email_id,
    from: d.from,
    to: [...(d.received_for ?? []), ...(d.to ?? [])],
    subject: d.subject ?? null,
    raw: { emailId: d.email_id },
  });
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
