/**
 * The RAW Twilio transport. Internal to @repo/sms and NOT exported (package.json
 * `exports` lists only the guarded entry point): the only sender is `sendSms`
 * in ./index.ts, which goes through the outbound guard. ESLint refuses the
 * `twilio` SDK anywhere else, and reading TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN
 * outside this file: with those two, anything could text anyone.
 *
 * Also here, because they need the same credentials: checking a webhook's
 * X-Twilio-Signature, asking Twilio for a message's status (the reconcile job)
 * and downloading inbound MMS media.
 */
import twilio from "twilio";
import { env } from "@repo/env";
import type { ProviderReceipt, SendMeta } from "@repo/outbound";

/** The part of the SDK this file uses; a test hands in a fake. */
export type TwilioClient = Pick<ReturnType<typeof twilio>, "messages">;

/** A fake for tests: the SDK surface, plus how to "download" a media URL. */
export type FakeTwilio = TwilioClient & {
  download?: (
    url: string,
  ) => Promise<{ bytes: Uint8Array; contentType: string }>;
};

let client: TwilioClient | undefined;
let fake: FakeTwilio | undefined;

/**
 * Tests only: route Twilio calls to a fake. Under NODE_ENV=test the real SDK
 * is never constructed (no network in `make test`, and a developer's real
 * credentials in .env must not turn a test into a real text).
 */
export function useFakeTwilio(c: FakeTwilio | undefined): void {
  fake = c;
}

/** Credentials and a From number are all set. */
export function smsConfigured(): boolean {
  const e = env();
  return Boolean(
    e.TWILIO_ACCOUNT_SID && e.TWILIO_AUTH_TOKEN && e.TWILIO_FROM_NUMBER,
  );
}

function twilioClient(): TwilioClient {
  if (fake) return fake;
  const e = env();
  if (e.NODE_ENV === "test") {
    throw new Error(
      "Refusing to call Twilio under NODE_ENV=test: use useFakeTwilio().",
    );
  }
  if (!e.TWILIO_ACCOUNT_SID || !e.TWILIO_AUTH_TOKEN)
    throw new Error("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are unset");
  return (client ??= twilio(e.TWILIO_ACCOUNT_SID, e.TWILIO_AUTH_TOKEN));
}

const LOOPBACK_OR_PRIVATE =
  /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i;

/**
 * The public origin Twilio reaches us on: TWILIO_WEBHOOK_BASE_URL, else
 * APP_URL. NEVER the request's own URL: behind a proxy or in a container the
 * app sees an internal host, and Twilio signed the public one.
 */
export function webhookBaseUrl(): string {
  const e = env();
  return (e.TWILIO_WEBHOOK_BASE_URL ?? e.APP_URL).replace(/\/+$/, "");
}

/**
 * Where Twilio posts delivery updates, or null when that origin is not
 * reachable from the internet (local dev): then we do not ask for callbacks,
 * and the reconcile job asks Twilio instead.
 */
export function statusCallbackUrl(): string | null {
  const base = webhookBaseUrl();
  const host = new URL(base).hostname;
  return LOOPBACK_OR_PRIVATE.test(host)
    ? null
    : `${base}/api/webhooks/twilio/status`;
}

/** Hand one text to Twilio, or print it when Twilio is not configured. */
export async function transmit(
  sms: { to: string; body: string },
  meta: SendMeta,
): Promise<ProviderReceipt> {
  if (!smsConfigured() && !fake) {
    // Same as email without SMTP_HOST: the template runs with no account.
    console.log(
      [
        "",
        "─".repeat(72),
        "  SMS NOT SENT — TWILIO_* is unset, so here is the message.",
        `  to: ${sms.to}  (outbound_message ${meta.messageId})`,
        "",
        sms.body,
        "─".repeat(72),
        "",
      ].join("\n"),
    );
    return { detail: "logged to console (TWILIO_* unset)" };
  }
  const callback = statusCallbackUrl();
  const msg = await twilioClient().messages.create({
    to: sms.to,
    from: env().TWILIO_FROM_NUMBER!,
    body: sms.body,
    // Ask Twilio whether it actually ARRIVED. create() returns "queued",
    // which means "Twilio has it", not "the phone got it": the production app
    // this is ported from reported a dead number as delivered for months.
    ...(callback ? { statusCallback: callback } : {}),
  });
  return { providerMessageId: msg.sid };
}

/** Twilio's current view of one message (the reconcile job). Read-only. */
export async function fetchMessageStatus(sid: string): Promise<{
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
}> {
  const m = await twilioClient().messages(sid).fetch();
  return {
    status: m.status,
    errorCode: m.errorCode != null ? String(m.errorCode) : null,
    errorMessage: m.errorMessage ?? null,
  };
}

/**
 * Does X-Twilio-Signature match this public URL and these form params?
 * Null when TWILIO_AUTH_TOKEN is unset (the caller decides what that means).
 * Uses the SDK's own check: HMAC-SHA1 over the URL plus the sorted params,
 * tried with and without the port, as Twilio documents.
 */
export function checkTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string | null | undefined,
): boolean | null {
  const token = env().TWILIO_AUTH_TOKEN;
  if (!token) return null;
  if (!signature) return false;
  return twilio.validateRequest(token, signature, url, params);
}

const MEDIA_HOSTS = /(^|\.)twilio\.com$/i;

/**
 * Download one inbound MMS attachment. Twilio media URLs need the account's
 * basic auth, so the URL is checked against Twilio's own hosts first: a forged
 * webhook must not be able to point this credentialed fetch at any other host.
 */
export async function downloadMedia(
  url: string,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  if (fake?.download) return fake.download(url);
  const e = env();
  if (e.NODE_ENV === "test")
    throw new Error("Refusing to download from Twilio under NODE_ENV=test.");
  const u = new URL(url);
  if (u.protocol !== "https:" || !MEDIA_HOSTS.test(u.hostname))
    throw new Error(`Not a Twilio media URL: ${u.hostname}`);
  if (!e.TWILIO_ACCOUNT_SID || !e.TWILIO_AUTH_TOKEN)
    throw new Error("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are unset");
  const auth = Buffer.from(
    `${e.TWILIO_ACCOUNT_SID}:${e.TWILIO_AUTH_TOKEN}`,
  ).toString("base64");
  // Twilio redirects to a signed CDN URL; fetch drops the Authorization
  // header on that cross-origin hop, as it should.
  const res = await fetch(u, {
    headers: { authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Media download failed: ${res.status}`);
  if (Number(res.headers.get("content-length") ?? 0) > maxBytes)
    throw new Error("Media too large.");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error("Media too large.");
  return {
    bytes,
    contentType: res.headers.get("content-type") ?? "application/octet-stream",
  };
}
