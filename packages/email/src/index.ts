/**
 * Outbound email over plain SMTP — no third-party API, no vendor SDK.
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
 */
import { createTransport, type Transporter } from "nodemailer";
import { env } from "@repo/env";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface SendResult {
  delivered: boolean;
  /** "smtp" when handed to a server, "console" when only logged. */
  via: "smtp" | "console";
  messageId?: string;
}

let transporter: Transporter | undefined;

export function smtpConfigured(): boolean {
  return Boolean(env().SMTP_HOST);
}

function transport(): Transporter {
  const e = env();
  transporter ??= createTransport({
    host: e.SMTP_HOST,
    port: e.SMTP_PORT,
    // Mailpit and most local relays speak plaintext on a high port; a real relay
    // on 465 needs `secure`. STARTTLS on 587 is negotiated automatically.
    secure: e.SMTP_SECURE,
    auth: e.SMTP_USER ? { user: e.SMTP_USER, pass: e.SMTP_PASS } : undefined,
  });
  return transporter;
}

export async function sendMail(mail: Mail): Promise<SendResult> {
  const e = env();

  if (!smtpConfigured()) {
    // Not an error: the template must run with no mail infrastructure at all.
    console.log(
      [
        "",
        "─".repeat(72),
        "  EMAIL NOT SENT — SMTP_HOST is unset, so here is the message.",
        `  to:      ${mail.to}`,
        `  subject: ${mail.subject}`,
        "",
        mail.text,
        "─".repeat(72),
        "",
      ].join("\n"),
    );
    return { delivered: false, via: "console" };
  }

  const info = await transport().sendMail({
    from: e.SMTP_FROM,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  });
  return { delivered: true, via: "smtp", messageId: info.messageId };
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
