/**
 * Inbound email from any provider or MTA that can POST JSON: the
 * provider-agnostic alternative to Resend's `email.received` (which arrives on
 * /api/webhooks/email-events). Signed exactly like the generic events webhook:
 *
 *   x-webhook-timestamp: <unix seconds>       (refused if > 5 minutes off)
 *   x-webhook-signature: sha256=<hex HMAC-SHA256 of `${timestamp}.${rawBody}`
 *                        with EMAIL_WEBHOOK_SECRET>
 *   body: genericInboundEmail in packages/inbound/src/process.ts:
 *     { id, from, to[], subject?, text?, html?, messageId?, inReplyTo?,
 *       references?[], attachments?[{ filename?, contentType, content (base64) }] }
 *
 * The message is routed to a tenant by its `to` addresses (inbound_route),
 * stored, and finished by the worker. `id` is the dedupe key: send the same
 * one when retrying. Answers 200 with `routed: false` for an address no tenant
 * owns (nothing is stored), so a sender does not retry it forever.
 */
import { env } from "@repo/env";
import { genericInboundEmail, intakeGenericEmail } from "@repo/inbound";
import { verifyHmac } from "@repo/security";

import { logUnrouted, queueInbound } from "@/lib/inbound-queue";
import {
  refuseUnsigned,
  WEBHOOK_LIMITS,
  webhookBody,
} from "@/lib/webhook-guard";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const e = env();
  // Base64 attachments included; larger mail belongs in object storage first.
  const raw = await webhookBody(req, WEBHOOK_LIMITS.inboundEmail);
  if (raw instanceof Response) return raw;

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
  if (!check.ok) return refuseUnsigned(req, "email-inbound", check);

  let parsed;
  try {
    parsed = genericInboundEmail.safeParse(JSON.parse(raw));
  } catch {
    return Response.json({ error: "Body is not JSON" }, { status: 400 });
  }
  if (!parsed.success)
    return Response.json(
      {
        error: "Not an inbound email",
        issues: parsed.error.issues.slice(0, 5),
      },
      { status: 400 },
    );

  const result = await intakeGenericEmail(parsed.data);
  if (result.outcome === "unrouted") {
    logUnrouted("email", parsed.data.to);
    return Response.json({ ok: true, routed: false });
  }
  await queueInbound(result);
  return Response.json({
    ok: true,
    routed: true,
    id: result.id,
    duplicate: result.outcome === "duplicate",
  });
}
