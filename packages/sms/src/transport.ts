/**
 * The RAW Twilio transport: a small fetch-based client for the three things
 * this app needs (send a message, fetch a message's status, check a webhook
 * signature) instead of the `twilio` SDK, which is ~11 MB in the server bundle
 * and ~21 MB in the worker image for those three calls.
 *
 * Internal to @repo/sms and NOT exported (package.json `exports` lists only
 * the guarded entry point): the only sender is `sendSms` in ./index.ts, which
 * goes through the outbound guard. ESLint refuses, anywhere else, the Twilio
 * API host and reading TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN: with those, anything
 * could text anyone. (The `twilio` SDK is refused everywhere, here included.)
 *
 * Also here, because it needs the same credentials: downloading inbound MMS
 * media.
 */
import { createHmac } from "node:crypto";

import { env } from "@repo/env";
import type { ProviderReceipt, SendMeta } from "@repo/outbound";
import { constantTimeEqual } from "@repo/security";

const API = "https://api.twilio.com/2010-04-01";

/** What this file asks of Twilio; a test hands in a fake. */
export interface TwilioApi {
  createMessage(p: {
    To: string;
    From: string;
    Body: string;
    StatusCallback?: string;
  }): Promise<{ sid: string; status: string }>;
  fetchMessage(sid: string): Promise<{
    status: string;
    errorCode: string | null;
    errorMessage: string | null;
  }>;
}

/** A fake for tests: any part of the API, plus how to "download" a media URL. */
export type FakeTwilio = Partial<TwilioApi> & {
  download?: (
    url: string,
  ) => Promise<{ bytes: Uint8Array; contentType: string }>;
};

let fake: FakeTwilio | undefined;

/**
 * Tests only: route Twilio calls to a fake. Under NODE_ENV=test the real
 * client refuses to run (no network in `make test`, and a developer's real
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

function credentials(): { sid: string; auth: string } {
  const e = env();
  if (e.NODE_ENV === "test") {
    throw new Error(
      "Refusing to call Twilio under NODE_ENV=test: use useFakeTwilio().",
    );
  }
  if (!e.TWILIO_ACCOUNT_SID || !e.TWILIO_AUTH_TOKEN)
    throw new Error("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are unset");
  return {
    sid: e.TWILIO_ACCOUNT_SID,
    auth: `Basic ${Buffer.from(`${e.TWILIO_ACCOUNT_SID}:${e.TWILIO_AUTH_TOKEN}`).toString("base64")}`,
  };
}

/** One call to Twilio's REST API; a non-2xx becomes an Error with Twilio's code. */
async function call(
  method: "GET" | "POST",
  path: string,
  form?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const { sid, auth } = credentials();
  const res = await fetch(`${API}/Accounts/${encodeURIComponent(sid)}${path}`, {
    method,
    headers: {
      authorization: auth,
      ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(
      `Twilio ${res.status}${json.code ? ` (error ${String(json.code)})` : ""}: ${String(json.message ?? res.statusText)}`,
    );
  }
  return json;
}

const realApi: TwilioApi = {
  async createMessage(p) {
    const form: Record<string, string> = {
      To: p.To,
      From: p.From,
      Body: p.Body,
    };
    if (p.StatusCallback) form.StatusCallback = p.StatusCallback;
    const m = await call("POST", "/Messages.json", form);
    return { sid: String(m.sid), status: String(m.status) };
  },
  async fetchMessage(sid) {
    const m = await call("GET", `/Messages/${encodeURIComponent(sid)}.json`);
    return {
      status: String(m.status),
      errorCode: m.error_code != null ? String(m.error_code) : null,
      errorMessage: m.error_message != null ? String(m.error_message) : null,
    };
  },
};

function api(): TwilioApi {
  if (!fake) return realApi;
  const f = fake;
  const none = (name: string) =>
    Promise.reject(new Error(`The fake Twilio has no ${name}.`));
  return {
    createMessage: (p) => f.createMessage?.(p) ?? none("createMessage"),
    fetchMessage: (sid) => f.fetchMessage?.(sid) ?? none("fetchMessage"),
  };
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
  const msg = await api().createMessage({
    To: sms.to,
    From: env().TWILIO_FROM_NUMBER!,
    Body: sms.body,
    // Ask Twilio whether it actually ARRIVED. create() returns "queued",
    // which means "Twilio has it", not "the phone got it": the production app
    // this is ported from reported a dead number as delivered for months.
    ...(callback ? { StatusCallback: callback } : {}),
  });
  return { providerMessageId: msg.sid };
}

/** Twilio's current view of one message (the reconcile job). Read-only. */
export function fetchMessageStatus(
  sid: string,
): ReturnType<TwilioApi["fetchMessage"]> {
  return api().fetchMessage(sid);
}

/**
 * X-Twilio-Signature as Twilio computes it: HMAC-SHA1, keyed by the auth
 * token, over the full URL followed by every POST param as key+value, keys
 * sorted; base64. https://www.twilio.com/docs/usage/security
 */
export function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join("");
  return createHmac("sha1", authToken).update(data).digest("base64");
}

/**
 * The URL as given, and with the default port toggled: Twilio may sign
 * `https://host/path` or `https://host:443/path` depending on how the
 * webhook was configured, and its SDKs accept either.
 */
function urlVariants(url: string): string[] {
  const m = /^(https?):\/\/([^/:?#]+)(:\d+)?(.*)$/i.exec(url);
  if (!m) return [url];
  const [, scheme, host, port, rest] = m;
  const def = scheme!.toLowerCase() === "https" ? ":443" : ":80";
  if (port) return port === def ? [url, `${scheme}://${host}${rest}`] : [url];
  return [url, `${scheme}://${host}${def}${rest}`];
}

/**
 * Does X-Twilio-Signature match this public URL and these form params?
 * Null when TWILIO_AUTH_TOKEN is unset (the caller decides what that means).
 * Compared in constant time.
 */
export function checkTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string | null | undefined,
): boolean | null {
  const token = env().TWILIO_AUTH_TOKEN;
  if (!token) return null;
  if (!signature) return false;
  return urlVariants(url).some((u) =>
    constantTimeEqual(twilioSignature(token, u, params), signature),
  );
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
