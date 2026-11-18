/**
 * Inbound messages: email (Resend, or the generic signed webhook) and SMS
 * (Twilio), routed to a tenant by recipient address, stored in
 * `inbound_message`, finished by the worker (`inbound.process`).
 *
 * The webhooks (apps/web/src/app/api/webhooks/*) verify signatures and call
 * the handlers here; nothing here trusts a request on its own.
 */
export { handleResendReceived, intakeGenericEmail } from "./email";
export { intakeInbound } from "./intake";
export type { InboundEnvelope, InboundProvider, IntakeResult } from "./intake";
export {
  genericInboundEmail,
  markInboundFailed,
  MAX_ATTACHMENTS,
  processInbound,
} from "./process";
export type { AttachmentRecord, GenericInboundEmail } from "./process";
export {
  ensureEmailAddress,
  plainEmail,
  routeEmail,
  routeSms,
  SMS_REPLY_WINDOW_DAYS,
  withoutPlusTag,
} from "./routing";
export type { InboundChannel, Route } from "./routing";
export { handleInboundSms, handleSmsStatus } from "./sms";
export type { SmsIntake } from "./sms";
export { cleanFilename, htmlToText, messageIds, outboundIdsIn } from "./text";
