/**
 * Twilio: what happened to a text we sent (the `statusCallback` packages/sms
 * gives Twilio on every send from a public origin). Updates
 * outbound_message.deliveryStatus, never backwards; error 21610 (the number
 * had replied STOP) also suppresses the number.
 *
 * Same signature check as /api/webhooks/twilio. Answers 200 for a message we
 * do not know (sent before tracking, another app on the account): a non-2xx
 * only makes Twilio retry something a retry cannot fix.
 */
import { handleSmsStatus } from "@repo/inbound";
import { verifyTwilioWebhook } from "@repo/sms";

import {
  refuseUnsigned,
  WEBHOOK_LIMITS,
  webhookBody,
} from "@/lib/webhook-guard";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const raw = await webhookBody(req, WEBHOOK_LIMITS.small);
  if (raw instanceof Response) return raw;
  const params = Object.fromEntries(new URLSearchParams(raw));
  const url = new URL(req.url);
  const check = verifyTwilioWebhook({
    pathAndQuery: url.pathname + url.search,
    params,
    signature: req.headers.get("x-twilio-signature"),
  });
  if (!check.ok) return refuseUnsigned(req, "twilio-status", check);

  const result = await handleSmsStatus(params);
  if (!result.ok)
    return Response.json({ error: result.error }, { status: 400 });
  return Response.json({ ok: true, matched: result.matched });
}
