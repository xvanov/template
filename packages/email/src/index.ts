/**
 * Outbound email: SMTP by default (no third-party account needed), or
 * Resend's API with EMAIL_TRANSPORT=resend (see ./transport.ts).
 *
 * Development: `docker compose up -d mailpit` runs a real SMTP server locally
 * and every message lands in its web inbox at http://localhost:8035. The
 * protocol path is exercised for real, so "does the email send" is testable
 * without an account anywhere.
 *
 * Production: point SMTP_* at any SMTP host. Two honest caveats —
 *   - Mailpit accepts and displays mail; it never delivers it onward. It is an
 *     inbox for you, not for your users.
 *   - Self-hosting an MTA that real inboxes accept is a deliverability project
 *     (SPF, DKIM, DMARC, reputation, and port 25 usually blocked outbound).
 *     For mail that must reach strangers, use an SMTP relay.
 *
 * With SMTP_HOST unset, messages are logged to the console instead of sent, so
 * a fresh clone still runs and you can copy the verification link out of the
 * terminal.
 *
 * Every message goes through @repo/outbound's guard. The raw transports live in
 * ./transport.ts and are not exported; do not add another way to reach a
 * mail provider.
 */
import { env } from "@repo/env";
import { deliver, type DeliveryResult } from "@repo/outbound";

import {
  downloadReceivedAttachment,
  fetchReceivedEmail,
  messageIdFor,
  smtpConfigured,
  transmit,
  useFakeResend,
  type FakeResend,
  type ReceivedEmail,
} from "./transport";

export {
  downloadReceivedAttachment,
  fetchReceivedEmail,
  messageIdFor,
  smtpConfigured,
  /** Tests only: Resend calls go to this fake (the real SDK is refused under test). */
  useFakeResend,
  type FakeResend,
  type ReceivedEmail,
};

export {
  handleResendDelivery,
  plainEmail,
  resendEvent,
  type ResendDeliveryOutcome,
  type ResendEvent,
} from "./events";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /**
   * Extra headers, e.g. In-Reply-To/References to answer an inbound message,
   * or List-Unsubscribe. To/From/Cc/Bcc/Reply-To/Message-ID are ignored: the
   * guard checked one recipient and that is who gets it.
   */
  headers?: Record<string, string>;
}

export interface MailContext {
  /** What is sending it, dotted: `items.digest`. Recorded on every attempt. */
  purpose: string;
  /** The tenant it is sent for. Required in practice for app mail: it drives
   *  the per-org volume caps, suppressions and who can read the log row. */
  organizationId?: string | null;
  actorUserId?: string | null;
  /**
   * Stable name of this one logical message (`invoice.42.reminder`). Set it
   * in anything that retries: a retry then never sends a second copy once
   * the first was sent (see `idempotencyKey` in @repo/outbound).
   */
  idempotencyKey?: string;
}

export type SendResult = DeliveryResult;

/**
 * Send an email. The ONLY way to: it passes the outbound guard (safe mode,
 * kill switch, suppression, volume caps) and is logged to outbound_message
 * whether it is sent or blocked.
 *
 * A BLOCKED message resolves with `status: "blocked"`; it does not throw.
 * Check the status where it matters. An SMTP failure throws.
 */
export function sendMail(mail: Mail, ctx: MailContext): Promise<SendResult> {
  return deliver(
    {
      channel: "email",
      recipient: mail.to,
      subject: mail.subject,
      purpose: ctx.purpose,
      organizationId: ctx.organizationId,
      actorUserId: ctx.actorUserId,
      idempotencyKey: ctx.idempotencyKey,
    },
    // The guard passes the address it checked; send to that, never mail.to.
    (to, meta) => transmit({ ...mail, to }, meta),
  );
}

/**
 * For better-auth's callbacks ONLY: mail the recipient just requested by
 * submitting this address (verification, password reset). Exempt from the
 * safe-mode allowlist, nothing else; see `authMail` in @repo/outbound.
 */
export function sendAuthMail(
  mail: Mail,
  purpose: `auth.${string}`,
): Promise<SendResult> {
  return deliver(
    {
      channel: "email",
      recipient: mail.to,
      subject: mail.subject,
      purpose,
      authMail: true,
    },
    // The guard passes the address it checked; send to that, never mail.to.
    (to, meta) => transmit({ ...mail, to }, meta),
  );
}

/**
 * For packages/notify ONLY: mail to the operator. There is no `to`: it always
 * goes to OPERATOR_EMAIL, so this cannot be pointed at anyone else. Exempt
 * from the safe-mode allowlist and the per-recipient cap because the guard
 * verifies that recipient (see `operator` in @repo/outbound). Never on behalf
 * of a tenant: no organizationId, so no tenant's activity log shows it. With
 * OPERATOR_EMAIL unset it is recorded as blocked (INVALID_RECIPIENT).
 */
export function sendOperatorMail(
  mail: Omit<Mail, "to">,
  purpose: `operator.${string}`,
): Promise<SendResult> {
  return deliver(
    {
      channel: "email",
      recipient: env().OPERATOR_EMAIL ?? "",
      subject: mail.subject,
      purpose,
      operator: true,
    },
    (to, meta) => transmit({ ...mail, to }, meta),
  );
}

/**
 * The verification email.
 *
 * Deliberately plain: a text part that stands on its own, and an HTML part with
 * the same content. The raw URL is always shown, because link-rewriting proxies
 * and text-only clients are common enough that a bare button is a support ticket.
 */
export function verificationEmail(
  url: string,
  appName = "App Template",
): Omit<Mail, "to"> {
  const text = [
    `Confirm your email address to finish setting up your ${appName} account.`,
    "",
    url,
    "",
    "The link expires in 1 hour. If you did not create an account, ignore this email.",
  ].join("\n");

  const html = `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;line-height:1.5;color:#1b1d26">
  <p>Confirm your email address to finish setting up your ${escapeHtml(appName)} account.</p>
  <p>
    <a href="${escapeAttr(url)}"
       style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px">
      Confirm email address
    </a>
  </p>
  <p style="color:#6b7280;font-size:14px">Or paste this into your browser:<br>
    <span style="word-break:break-all">${escapeHtml(url)}</span>
  </p>
  <p style="color:#6b7280;font-size:14px">
    The link expires in 1 hour. If you did not create an account, ignore this email.
  </p>
</body></html>`;

  return { subject: `Confirm your email address`, text, html };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Same as escapeHtml, plus single quotes, for use inside an attribute. */
function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}
