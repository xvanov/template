/**
 * Bounce and complaint events from the email provider → the suppression list,
 * so the outbound guard never mails a dead or complaining address again.
 *
 * Signed with HMAC-SHA256 over `${timestamp}.${rawBody}` using
 * EMAIL_WEBHOOK_SECRET, sent as:
 *
 *   x-webhook-timestamp: <unix seconds>       (refused if > 5 minutes off)
 *   x-webhook-signature: sha256=<hex>
 *   body: {"type":"bounce"|"complaint","email":"someone@example.com"}
 *
 * Every provider signs differently (Postmark, SES via SNS, Resend/Svix...);
 * adapt the header names and payload parsing, keep `verifyHmac` over the RAW
 * body. Read it with `req.text()` BEFORE parsing: re-serialised JSON will not
 * match the signature.
 *
 * A route handler, not tRPC: the caller is the provider, authenticated by a
 * signature, not a session. Fails closed in production when the secret is unset.
 */
import { z } from "zod";
import { db, recordAudit } from "@repo/db";
import { env } from "@repo/env";
import { parseRecipient, suppress } from "@repo/outbound";
import { authFailure, verifyHmac } from "@repo/security";

export const dynamic = "force-dynamic";

const event = z.object({
  type: z.enum(["bounce", "complaint"]),
  email: z.string().email(),
});

export async function POST(req: Request) {
  const e = env();
  const raw = await req.text();
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
