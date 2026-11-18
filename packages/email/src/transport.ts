/**
 * The RAW email transports. Internal to @repo/email and deliberately NOT
 * exported (package.json `exports` lists only the guarded entry point): the
 * only caller is ./index.ts, whose send functions go through the outbound
 * guard. A test fails if anything else in the repo imports a mail library or
 * this file, and ESLint refuses RESEND_API_KEY being read anywhere else.
 *
 * Two transports, chosen by EMAIL_TRANSPORT:
 *   smtp    (default) nodemailer → SMTP_*. Mailpit locally. SMTP_HOST unset =
 *           printed to the console, so a fresh clone runs with no mail setup.
 *   resend  Resend's HTTP API (the official SDK) with RESEND_API_KEY.
 *
 * Both stamp every message with `Message-ID: <obm.<row id>@<from domain>>`,
 * so a reply's In-Reply-To/References lead back to the outbound_message row
 * (packages/inbound threads on it). Resend also gets the row id as its
 * Idempotency-Key: a retry of the same row within 24 hours is not sent twice.
 *
 * This file also holds the read side of Resend's inbound mail (fetching a
 * received message and its attachments), because it needs the same key.
 */
import { createTransport, type Transporter } from "nodemailer";
import { Resend } from "resend";
import { env } from "@repo/env";
import {
  isLoopbackHost,
  type ProviderReceipt,
  type SendMeta,
} from "@repo/outbound";

export interface RawMail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Extra headers (In-Reply-To, List-Unsubscribe...). Never To/From/Message-ID. */
  headers?: Record<string, string>;
}

let transporter: Transporter | undefined;

export const SMTP_TIMEOUTS = {
  connectionTimeout: 30_000,
  greetingTimeout: 30_000,
  socketTimeout: 30_000,
} as const;

/** Will a send actually leave this process (vs. be printed)? */
export function smtpConfigured(): boolean {
  const e = env();
  return e.EMAIL_TRANSPORT === "resend" || Boolean(e.SMTP_HOST);
}

/** `Name <a@example.com>` or `a@example.com` → `example.com`. */
export function domainOf(from: string): string {
  const m = /@([^\s>]+)>?\s*$/.exec(from.trim());
  return m?.[1]?.toLowerCase() ?? "localhost";
}

/** The Message-ID every message carries; see the header comment. */
export function messageIdFor(rowId: string, from = env().SMTP_FROM): string {
  return `<obm.${rowId}@${domainOf(from)}>`;
}

/** Headers a caller may not set: the guard checked THIS recipient. */
const RESERVED = /^(to|cc|bcc|from|sender|message-id|reply-to)$/i;

function extraHeaders(mail: RawMail): Record<string, string> {
  return Object.fromEntries(
    Object.entries(mail.headers ?? {}).filter(
      ([k, v]) => !RESERVED.test(k) && !/[\r\n]/.test(k + v),
    ),
  );
}

/** Hand one message to the configured transport. */
export async function transmit(
  mail: RawMail,
  meta: SendMeta,
): Promise<ProviderReceipt> {
  return env().EMAIL_TRANSPORT === "resend"
    ? sendViaResend(mail, meta)
    : sendViaSmtp(mail, meta);
}

// ── SMTP ──────────────────────────────────────────────────────────────────

function smtp(): Transporter {
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
    // nodemailer's defaults are 2 min to connect and 10 min of socket
    // silence: a hung relay would hold a request, a job or an operator alert
    // for that long. Fail in 30s instead; jobs retry, the guard records it.
    ...SMTP_TIMEOUTS,
  });
  return transporter;
}

async function sendViaSmtp(
  mail: RawMail,
  meta: SendMeta,
): Promise<ProviderReceipt> {
  if (!env().SMTP_HOST) {
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
  const info = await smtp().sendMail({
    from: env().SMTP_FROM,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    messageId: messageIdFor(meta.messageId),
    headers: extraHeaders(mail),
  });
  return { providerMessageId: info.messageId };
}

// ── Resend ────────────────────────────────────────────────────────────────

/** The part of the SDK this file uses; a test hands in a fake. */
export type ResendClient = Pick<Resend, "emails">;

/** A fake for tests: the SDK surface, plus how to "download" a signed URL. */
export type FakeResend = ResendClient & {
  download?: (url: string) => Promise<Uint8Array>;
};

let resendClient: ResendClient | undefined;
let fakeResend: FakeResend | undefined;

/**
 * Tests only: route Resend calls to a fake. Under NODE_ENV=test the real SDK
 * is never constructed: `make test` must not reach the network, and a key in a
 * developer's .env must not turn a unit test into real mail.
 */
export function useFakeResend(client: FakeResend | undefined): void {
  fakeResend = client;
}

function resend(): ResendClient {
  if (fakeResend) return fakeResend;
  const e = env();
  if (e.NODE_ENV === "test") {
    throw new Error(
      "Refusing to call Resend under NODE_ENV=test: use useFakeResend().",
    );
  }
  if (!e.RESEND_API_KEY) throw new Error("RESEND_API_KEY is unset");
  return (resendClient ??= new Resend(e.RESEND_API_KEY));
}

async function sendViaResend(
  mail: RawMail,
  meta: SendMeta,
): Promise<ProviderReceipt> {
  const from = env().SMTP_FROM;
  const { data, error } = await resend().emails.send(
    {
      from,
      to: [mail.to],
      subject: mail.subject,
      text: mail.text,
      ...(mail.html ? { html: mail.html } : {}),
      headers: {
        ...extraHeaders(mail),
        "Message-ID": messageIdFor(meta.messageId, from),
      },
    },
    // The row id: stable across retries of one logical message (see
    // `idempotencyKey` in @repo/outbound), so Resend drops a repeat.
    { idempotencyKey: `outbound-message/${meta.messageId}` },
  );
  if (error || !data) {
    throw new Error(
      `Resend refused the message: ${error?.name ?? "unknown"}: ${error?.message ?? "no data"}`,
    );
  }
  return { providerMessageId: data.id };
}

// ── Resend inbound (read side) ────────────────────────────────────────────

export interface ReceivedEmail {
  from: string;
  to: string[];
  subject: string | null;
  text: string | null;
  html: string | null;
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string[];
  attachments: {
    filename: string;
    contentType: string;
    sizeBytes: number;
    /** Short-lived signed URL; fetched by downloadReceivedAttachment. */
    downloadUrl: string | null;
  }[];
}

function header(
  headers: Record<string, string> | null | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  const hit = Object.entries(headers).find(
    ([k]) => k.toLowerCase() === name.toLowerCase(),
  );
  return hit?.[1] ?? null;
}

/** A received email's full content, by the id in Resend's `email.received` event. */
export async function fetchReceivedEmail(id: string): Promise<ReceivedEmail> {
  const client = resend();
  const got = await client.emails.receiving.get(id);
  if (got.error || !got.data) {
    throw new Error(
      `Resend: could not fetch received email ${id}: ${got.error?.message ?? "no data"}`,
    );
  }
  const m = got.data;
  // Download URLs come from the attachments endpoint, not the email itself.
  const urls = new Map<string, string>();
  if (m.attachments.length > 0) {
    const list = await client.emails.receiving.attachments.list({
      emailId: id,
    });
    for (const a of list.data?.data ?? []) urls.set(a.id, a.download_url);
  }
  return {
    from: m.from,
    to: m.received_for?.length ? m.received_for : m.to,
    subject: m.subject ?? null,
    text: m.text,
    html: m.html,
    messageIdHeader: m.message_id ?? header(m.headers, "message-id"),
    inReplyTo: header(m.headers, "in-reply-to"),
    references: (header(m.headers, "references") ?? "")
      .split(/\s+/)
      .filter(Boolean),
    attachments: m.attachments.map((a) => ({
      filename: a.filename ?? "attachment",
      contentType: a.content_type,
      sizeBytes: a.size,
      downloadUrl: urls.get(a.id) ?? null,
    })),
  };
}

/**
 * Fetch one attachment's bytes from its signed URL, refusing anything larger
 * than `maxBytes` (by header, then by what actually arrived) and anything
 * not on https.
 */
export async function downloadReceivedAttachment(
  url: string,
  maxBytes: number,
): Promise<Uint8Array> {
  if (fakeResend?.download) return fakeResend.download(url);
  if (env().NODE_ENV === "test")
    throw new Error("Refusing to download from Resend under NODE_ENV=test.");
  if (!url.startsWith("https://")) throw new Error("Not an https URL.");
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Attachment download failed: ${res.status}`);
  if (Number(res.headers.get("content-length") ?? 0) > maxBytes)
    throw new Error("Attachment too large.");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error("Attachment too large.");
  return bytes;
}
