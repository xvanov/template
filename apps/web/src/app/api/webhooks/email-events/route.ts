/**
 * Events from the email provider. Two signature schemes, picked by header:
 *
 * 1. Resend (Svix): `svix-id`, `svix-timestamp`, `svix-signature`, verified
 *    with RESEND_WEBHOOK_SECRET (`whsec_...`), 5 minutes' tolerance either way
 *    (replays refused). Point ONE Resend webhook here with the email.* events:
 *      email.delivered / delivery_delayed / bounced / complained / failed /
 *      suppressed → outbound_message.deliveryStatus, matched on the id Resend
 *        returned when it accepted the message;
 *      a permanent bounce or a complaint → the global suppression list;
 *      email.received → an inbound message (packages/inbound), content
 *        fetched by the worker.
 *
 * 2. Generic HMAC, for any other provider: HMAC-SHA256 over
 *    `${timestamp}.${rawBody}` with EMAIL_WEBHOOK_SECRET, sent as
 *      x-webhook-timestamp: <unix seconds>   (refused if > 5 minutes off)
 *      x-webhook-signature: sha256=<hex>
 *      body: {"type":"bounce"|"complaint","email":"someone@example.com"}
 *
 * Both verify the RAW body: read with `req.text()` BEFORE parsing, since
 * re-serialised JSON will not match the signature. Each scheme fails closed in
 * production when its secret is unset.
 *
 * A route handler, not tRPC: the caller is the provider, authenticated by a
 * signature, not a session.
 */
import { z } from "zod";
import { db, recordAudit } from "@repo/db";
import { env } from "@repo/env";
import { handleResendEvent, resendEvent } from "@repo/inbound";
import { parseRecipient, suppress } from "@repo/outbound";
import { authFailure, verifyHmac, verifySvix } from "@repo/security";

import { logUnrouted, queueInbound } from "@/lib/inbound-queue";
import { WEBHOOK_LIMITS, webhookBody } from "@/lib/webhook-guard";

export const dynamic = "force-dynamic";

const event = z.object({
  type: z.enum(["bounce", "complaint"]),
  email: z.string().email(),
});

export async function POST(req: Request) {
  const raw = await webhookBody(req, {
    name: "email-events",
    maxBytes: WEBHOOK_LIMITS.small,
  });
  if (raw instanceof Response) return raw;
  return req.headers.has("svix-id") ? resend(req, raw) : generic(req, raw);
}

async function resend(req: Request, raw: string) {
  const e = env();
  const check = verifySvix({
    payload: raw,
    id: req.headers.get("svix-id"),
    timestamp: req.headers.get("svix-timestamp"),
    signature: req.headers.get("svix-signature"),
    secret: e.RESEND_WEBHOOK_SECRET,
    secretName: "RESEND_WEBHOOK_SECRET",
    production: e.NODE_ENV === "production",
  });
  if (!check.ok) return authFailure(check);

  let parsed;
  try {
    parsed = resendEvent.safeParse(JSON.parse(raw));
  } catch {
    return Response.json({ error: "Body is not JSON" }, { status: 400 });
  }
  if (!parsed.success)
    return Response.json({ error: "Unrecognised event" }, { status: 400 });

  const outcome = await handleResendEvent(parsed.data);
  if (outcome.kind === "inbound") {
    if (outcome.intake.outcome === "unrouted")
      logUnrouted("email", parsed.data.data.to ?? []);
    else await queueInbound(outcome.intake);
  }
  // 200 for events we do not act on too (opened, clicked, contact.*): an
  // error would only make Resend retry something nothing can fix.
  return Response.json({ ok: true, ...summary(outcome) });
}

function summary(outcome: Awaited<ReturnType<typeof handleResendEvent>>) {
  switch (outcome.kind) {
    case "inbound":
      return { inbound: outcome.intake.outcome };
    case "delivery":
      return { status: outcome.status, matched: outcome.matched };
    default:
      return { ignored: outcome.type };
  }
}

async function generic(req: Request, raw: string) {
  const e = env();
  const check = verifyHmac({
    payload: raw,
    signature: req.headers.get("x-webhook-signature"),
    prefix: "sha256=",
    timestamp: req.headers.get("x-webhook-timestamp"),
    toleranceSeconds: 300,
    secret: e.EMAIL_WEBHOOK_SECRET,
    secretName: "EMAIL_WEBHOOK_SECRET",
    production: e.NODE_ENV === "production",
  });
  if (!check.ok) return authFailure(check);

  let parsed;
  try {
    parsed = event.safeParse(JSON.parse(raw));
  } catch {
    return Response.json({ error: "Body is not JSON" }, { status: 400 });
  }
  if (!parsed.success || !parseRecipient("email", parsed.data.email)) {
    return Response.json({ error: "Unrecognised event" }, { status: 400 });
  }

  // Global (no organizationId): a bounce or complaint is about the address,
  // not about which tenant last mailed it.
  await suppress({
    channel: "email",
    recipient: parsed.data.email,
    reason: `provider ${parsed.data.type}`,
  });
  await recordAudit(db, {
    organizationId: null,
    actorType: "system",
    actorId: "webhook:email-events",
    action: "outbound.suppress",
    targetType: "recipient",
    targetId: parsed.data.email.toLowerCase(),
    metadata: { type: parsed.data.type },
  });
  return Response.json({ ok: true });
}
