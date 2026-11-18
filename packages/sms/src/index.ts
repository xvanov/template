/**
 * Outbound SMS through Twilio, behind the outbound guard. OFF by default:
 * OUTBOUND_SMS_ENABLED=true turns the channel on; with TWILIO_* unset an
 * allowed text is printed to the console instead of sent.
 *
 * Safe mode for SMS: there is no SMS catcher, so OUTBOUND_SAFE_MODE=local
 * means STRICT for texts. Only exact E.164 numbers in OUTBOUND_SAFE_RECIPIENTS
 * receive anything outside production. Numbers must be international
 * (+447700900123): a national number is refused, never guessed.
 *
 * The raw transport lives in ./transport.ts and is not exported; do not add
 * another way to reach Twilio.
 */
import { db } from "@repo/db";
import { env } from "@repo/env";
import {
  deliver,
  recordDeliveryStatus,
  type DeliveryResult,
} from "@repo/outbound";
import type { AuthCheck } from "@repo/security";

import {
  checkTwilioSignature,
  downloadMedia,
  fetchMessageStatus,
  smsConfigured,
  statusCallbackUrl,
  transmit,
  useFakeTwilio,
  webhookBaseUrl,
  type FakeTwilio,
} from "./transport";

export {
  downloadMedia,
  fetchMessageStatus,
  smsConfigured,
  statusCallbackUrl,
  /** Tests only: Twilio calls go to this fake (the real SDK is refused under test). */
  useFakeTwilio,
  webhookBaseUrl,
  type FakeTwilio,
};

export interface Sms {
  /** One number, international form; normalised to E.164 by the guard. */
  to: string;
  body: string;
}

export interface SmsContext {
  /** What is sending it, dotted: `bookings.reminder`. */
  purpose: string;
  /** The tenant it is sent for: drives per-org caps, suppressions, the log. */
  organizationId?: string | null;
  actorUserId?: string | null;
  /** Stable name of this one logical text; see `idempotencyKey` in @repo/outbound. */
  idempotencyKey?: string;
}

/** Twilio's hard limit is 1600 characters (it splits into segments itself). */
export const MAX_SMS_CHARS = 1600;

/**
 * Send a text. The ONLY way to: it passes the outbound guard (channel switch,
 * kill switch, safe mode, STOP suppressions, volume caps) and is logged to
 * outbound_message whether sent or blocked. A block resolves with
 * `status: "blocked"`; a Twilio error throws (jobs retry it).
 *
 * The body is sent as given. Carrier rules (sender identification, "Reply
 * STOP to opt out" on the first message) are the app's to write into it.
 */
export function sendSms(sms: Sms, ctx: SmsContext): Promise<DeliveryResult> {
  return deliver(
    {
      channel: "sms",
      recipient: sms.to,
      purpose: ctx.purpose,
      organizationId: ctx.organizationId,
      actorUserId: ctx.actorUserId,
      idempotencyKey: ctx.idempotencyKey,
      // A text has no subject: the log shows the start of the body instead.
      subject: sms.body.slice(0, 80),
    },
    // The guard passes the number it checked; send to that, never sms.to.
    (to, meta) =>
      transmit({ to, body: sms.body.slice(0, MAX_SMS_CHARS) }, meta),
  );
}

/**
 * Check a Twilio webhook: X-Twilio-Signature over the PUBLIC URL Twilio
 * called (rebuilt from TWILIO_WEBHOOK_BASE_URL / APP_URL plus `pathAndQuery`,
 * never from the request, which behind a proxy carries an internal host) and
 * the form params. Fails closed in production without TWILIO_AUTH_TOKEN;
 * outside production an unset token lets the request through.
 */
export function verifyTwilioWebhook(input: {
  /** e.g. `/api/webhooks/twilio`, plus `?query` if Twilio was given one. */
  pathAndQuery: string;
  params: Record<string, string>;
  signature: string | null | undefined;
}): AuthCheck {
  const url = `${webhookBaseUrl()}${input.pathAndQuery}`;
  const ok = checkTwilioSignature(url, input.params, input.signature);
  if (ok === null) {
    return env().NODE_ENV === "production"
      ? { ok: false, status: 500, error: "TWILIO_AUTH_TOKEN is not configured" }
      : { ok: true };
  }
  if (!ok) {
    console.warn(
      `[sms] refused a webhook: X-Twilio-Signature does not match ${url} (is TWILIO_WEBHOOK_BASE_URL/APP_URL the public origin?)`,
    );
  }
  return ok ? { ok: true } : { ok: false, status: 401, error: "Unauthorized" };
}

/**
 * The opt-out keywords carriers and Twilio act on (CTIA). Matched on the whole
 * message, trimmed and case-folded: "Stop" is an opt-out, "stop by later" is
 * not.
 */
const KEYWORDS: Record<string, "stop" | "start" | "help"> = {
  stop: "stop",
  stopall: "stop",
  unsubscribe: "stop",
  cancel: "stop",
  end: "stop",
  quit: "stop",
  revoke: "stop",
  optout: "stop",
  start: "start",
  unstop: "start",
  yes: "start",
  subscribe: "start",
  help: "help",
  info: "help",
};

export function smsKeyword(body: string): "stop" | "start" | "help" | null {
  return (
    KEYWORDS[
      body
        .trim()
        .toLowerCase()
        .replace(/[.!]+$/, "")
    ] ?? null
  );
}

/** The suppression reason a STOP writes, and the only one START lifts. */
export const STOP_REASON = "sms STOP";

/**
 * Twilio's MessageStatus → outbound_message.deliveryStatus (see
 * DELIVERY_STATUSES in @repo/outbound). Null for states that say nothing
 * about an outbound message's fate.
 */
export function deliveryStatusOf(twilioStatus: string): string | null {
  switch (twilioStatus.toLowerCase()) {
    case "accepted":
    case "scheduled":
    case "queued":
      return "queued";
    case "sending":
    case "sent":
      return "sent";
    case "delivered":
    case "read":
      return "delivered";
    case "undelivered":
    case "partially_delivered":
      return "undelivered";
    case "failed":
    case "canceled":
      return "failed";
    default:
      return null;
  }
}

/**
 * Twilio error codes in plain words: "30005" on a dashboard tells nobody what
 * to do next. https://www.twilio.com/docs/api/errors
 */
const ERRORS: Record<string, string> = {
  "30003":
    "the handset was unreachable (off, out of coverage, or no longer in service)",
  "30004": "the number has blocked messages from us",
  "30005":
    "the number does not exist or is no longer a mobile handset; it probably needs replacing",
  "30006": "the number is a landline or otherwise cannot receive texts",
  "30007": "the carrier filtered the message as spam",
  "30008": "the carrier gave no reason (unknown error)",
  "21610": "the recipient replied STOP and is unsubscribed",
  "21211": "the number is not a valid phone number",
};

export function explainTwilioError(
  code: string | null | undefined,
): string | null {
  if (!code) return null;
  return ERRORS[code] ? `Twilio ${code}: ${ERRORS[code]}` : `Twilio ${code}`;
}

/**
 * The backstop for status callbacks: ask Twilio about texts still without a
 * final delivery status 15 minutes to 3 days after sending, and record the
 * answer. Callbacks can be lost (a deploy, a wrong TWILIO_WEBHOOK_BASE_URL,
 * local dev where none are requested at all); without this a dead number
 * looks like a delivered one forever. Read-only against Twilio. A no-op
 * unless SMS is enabled and configured.
 */
export async function reconcileSmsDelivery(
  opts: { limit?: number; now?: Date } = {},
): Promise<{ checked: number; updated: number; errors: number }> {
  const result = { checked: 0, updated: 0, errors: 0 };
  if (!env().OUTBOUND_SMS_ENABLED || !smsConfigured()) return result;
  const now = opts.now ?? new Date();
  const rows = await db.outboundMessage.findMany({
    where: {
      channel: "sms",
      status: "sent",
      providerMessageId: { not: null },
      OR: [
        { deliveryStatus: null },
        { deliveryStatus: { in: ["queued", "sent", "delayed"] } },
      ],
      createdAt: {
        gte: new Date(now.getTime() - 3 * 86_400_000),
        lte: new Date(now.getTime() - 15 * 60_000),
      },
    },
    orderBy: { createdAt: "asc" },
    take: opts.limit ?? 100,
    select: { providerMessageId: true },
  });
  for (const row of rows) {
    const sid = row.providerMessageId!;
    try {
      const m = await fetchMessageStatus(sid);
      result.checked++;
      const status = deliveryStatusOf(m.status);
      if (!status) continue;
      const r = await recordDeliveryStatus({
        channel: "sms",
        providerMessageId: sid,
        status,
        detail: explainTwilioError(m.errorCode) ?? m.errorMessage,
      });
      result.updated += r.updated;
    } catch (err) {
      result.errors++;
      console.warn(`[sms] reconcile: could not fetch ${sid}:`, err);
    }
  }
  return result;
}
