/**
 * Twilio: a text ARRIVED at our number (set this URL as the number's
 * "A message comes in" webhook, HTTP POST).
 *
 * Verified with X-Twilio-Signature against the PUBLIC URL
 * (TWILIO_WEBHOOK_BASE_URL, else APP_URL, + this path): behind a proxy the
 * request itself carries an internal host Twilio never signed. Fails closed in
 * production without TWILIO_AUTH_TOKEN.
 *
 * STOP / START change the suppression list here and now (an opt-out must not
 * wait for the worker); the message itself is stored for its tenant and
 * finished by the worker (MMS media into storage). Answers with empty TwiML:
 * no auto-reply (Twilio's Advanced Opt-Out answers STOP/HELP itself).
 */
import { handleInboundSms } from "@repo/inbound";
import { authFailure } from "@repo/security";
import { verifyTwilioWebhook } from "@repo/sms";

import { logUnrouted, queueInbound } from "@/lib/inbound-queue";
import { WEBHOOK_LIMITS, webhookBody } from "@/lib/webhook-guard";

export const dynamic = "force-dynamic";

const EMPTY_TWIML =
  '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export async function POST(req: Request) {
  const raw = await webhookBody(req, {
    name: "twilio",
    maxBytes: WEBHOOK_LIMITS.small,
  });
  if (raw instanceof Response) return raw;
  const params = Object.fromEntries(new URLSearchParams(raw));
  const url = new URL(req.url);
  const check = verifyTwilioWebhook({
    pathAndQuery: url.pathname + url.search,
    params,
    signature: req.headers.get("x-twilio-signature"),
  });
  if (!check.ok) return authFailure(check);

  const result = await handleInboundSms(params);
  if (!result.ok)
    return Response.json({ error: result.error }, { status: 400 });
  if (result.outcome === "unrouted") logUnrouted("sms", [params.To ?? ""]);
  else await queueInbound(result);

  return new Response(EMPTY_TWIML, {
    headers: { "content-type": "text/xml" },
  });
}
