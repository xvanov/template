/**
 * Twilio's two webhooks, past the signature check (the route handlers do that):
 *
 *   inbound   a text arrived. STOP/START act on the suppression list RIGHT
 *             HERE, not in the worker: an opt-out must hold even when the
 *             worker is down. Then the message is stored for its tenant.
 *   status    Twilio's verdict on a text we sent → outbound_message.
 *
 * No auto-replies are sent: Twilio's own Advanced Opt-Out answers STOP/HELP on
 * the number by default, and a reply from here would be one more outbound
 * message to get right.
 */
import { db, recordAudit } from "@repo/db";
import {
  parseRecipient,
  recordDeliveryStatus,
  suppress,
  unsuppress,
} from "@repo/outbound";
import {
  deliveryStatusOf,
  explainTwilioError,
  smsKeyword,
  STOP_REASON,
} from "@repo/sms";

import { intakeInbound, type IntakeResult } from "./intake";

export type SmsIntake =
  | { ok: false; error: string }
  | ({ ok: true; keyword: "stop" | "start" | "help" | null } & IntakeResult);

export async function handleInboundSms(
  params: Record<string, string>,
): Promise<SmsIntake> {
  const from = parseRecipient("sms", params.From ?? "");
  const sid = params.MessageSid ?? params.SmsSid;
  if (!from || !sid) return { ok: false, error: "Missing From or MessageSid" };
  const body = params.Body ?? "";
  const keyword = smsKeyword(body);

  // Global, like the carrier's own block: the number asked to hear nothing
  // more from this sender, whichever tenant was writing.
  if (keyword === "stop") {
    await suppress({ channel: "sms", recipient: from, reason: STOP_REASON });
    await audit("outbound.suppress", from, { keyword: body.trim() });
  } else if (keyword === "start") {
    const lifted = await unsuppress({
      channel: "sms",
      recipient: from,
      reasonPrefix: STOP_REASON,
    });
    if (lifted)
      await audit("outbound.unsuppress", from, { keyword: body.trim() });
  }

  const result = await intakeInbound({
    channel: "sms",
    provider: "twilio",
    providerMessageId: sid,
    from,
    to: [params.To ?? ""],
    raw: { params: pick(params) },
    // An opt-out is recorded, not left in the inbox as work to do.
    handled: keyword === "stop" || keyword === "start",
  });
  return { ok: true, keyword, ...result };
}

/** Only what processing needs: not the account SID and the rest. */
function pick(params: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params).filter(([k]) =>
      /^(Body|From|To|MessageSid|SmsSid|NumMedia|MediaUrl\d+|MediaContentType\d+)$/.test(
        k,
      ),
    ),
  );
}

function audit(
  action: string,
  number: string,
  metadata: Record<string, string>,
) {
  return recordAudit(db, {
    organizationId: null,
    actorType: "system",
    actorId: "webhook:twilio",
    action,
    targetType: "recipient",
    targetId: number,
    metadata,
  });
}

export async function handleSmsStatus(
  params: Record<string, string>,
): Promise<{ ok: false; error: string } | { ok: true; matched: number }> {
  const sid = params.MessageSid ?? params.SmsSid;
  const twilioStatus = params.MessageStatus ?? params.SmsStatus;
  if (!sid || !twilioStatus)
    return { ok: false, error: "Missing MessageSid or MessageStatus" };
  const status = deliveryStatusOf(twilioStatus);
  if (!status) return { ok: true, matched: 0 };
  // 21610: the number had already replied STOP to our sender. Twilio will
  // refuse every future text too: suppress it here so the guard stops trying.
  if (params.ErrorCode === "21610") {
    const sent = await db.outboundMessage.findFirst({
      where: { channel: "sms", providerMessageId: sid },
      select: { recipient: true },
    });
    if (sent) {
      await suppress({
        channel: "sms",
        recipient: sent.recipient,
        reason: `${STOP_REASON} (Twilio 21610)`,
      });
    }
  }
  const { matched } = await recordDeliveryStatus({
    channel: "sms",
    providerMessageId: sid,
    status,
    detail: explainTwilioError(params.ErrorCode) ?? params.ErrorMessage ?? null,
  });
  return { ok: true, matched };
}
