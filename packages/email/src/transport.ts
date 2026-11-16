/**
 * The RAW SMTP transport. Internal to @repo/email and deliberately NOT
 * exported (package.json `exports` lists only the guarded entry point): the
 * only caller is `sendMail` in ./index.ts, which goes through the outbound
 * guard. A test fails if anything else in the repo imports nodemailer.
 */
import { createTransport, type Transporter } from "nodemailer";
import { env } from "@repo/env";
import { isLoopbackHost, type ProviderReceipt } from "@repo/outbound";

export interface RawMail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

let transporter: Transporter | undefined;

export function smtpConfigured(): boolean {
  return Boolean(env().SMTP_HOST);
}

function transport(): Transporter {
  const e = env();
  // Under a test runner, mail may only go to a catcher on this machine. Ported
  // from the production apps' "no real providers under test" guard: a unit
  // test that reaches a real relay mails a real person.
  if (e.NODE_ENV === "test" && !isLoopbackHost(e.SMTP_HOST)) {
    throw new Error(
      `Refusing to send mail to SMTP host "${e.SMTP_HOST}" under NODE_ENV=test: only a loopback mail catcher is allowed.`,
    );
  }
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

/** Hand one message to SMTP, or print it when SMTP_HOST is unset. */
export async function transmit(mail: RawMail): Promise<ProviderReceipt> {
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
    return { detail: "logged to console (SMTP_HOST unset)" };
  }
  const info = await transport().sendMail({
    from: env().SMTP_FROM,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  });
  return { providerMessageId: info.messageId };
}
