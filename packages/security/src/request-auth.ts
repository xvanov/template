/**
 * Authenticating machine-to-machine requests: cron endpoints (a bearer
 * secret) and inbound webhooks (an HMAC signature over the raw body).
 *
 * Framework-agnostic: the checks take strings and return a verdict; the
 * `require*` wrappers take a standard `Request` and return a `Response` to send
 * back, or null to carry on. Use them from Next route handlers.
 *
 * FAIL CLOSED. An unset secret in production is a misconfiguration, and every
 * request is refused (500, so it pages someone instead of looking like an
 * attacker). The originals this was ported from failed OPEN: an unset secret
 * skipped the check and left the endpoint public. Outside production an unset
 * secret is allowed so a fresh clone can hit its own endpoints.
 */
import { createHmac } from "node:crypto";
import { env } from "@repo/env";

import { constantTimeEqual } from "./compare";

export type AuthCheck =
  { ok: true } | { ok: false; status: 401 | 500; error: string };

interface SecretPolicy {
  /** True in production: an unset secret refuses every request. */
  production: boolean;
}

function missingSecret(name: string, policy: SecretPolicy): AuthCheck {
  return policy.production
    ? { ok: false, status: 500, error: `${name} is not configured` }
    : { ok: true };
}

/** `Authorization: Bearer <secret>`, compared in constant time. */
export function verifyBearer(
  authorization: string | null | undefined,
  secret: string | undefined,
  policy: SecretPolicy & { secretName?: string },
): AuthCheck {
  if (!secret) return missingSecret(policy.secretName ?? "secret", policy);
  const given = authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  return constantTimeEqual(given, secret)
    ? { ok: true }
    : { ok: false, status: 401, error: "Unauthorized" };
}

export interface HmacOptions {
  /** The RAW request body, exactly as received. Re-serialised JSON will not match. */
  payload: string;
  /** The signature header's value. */
  signature: string | null | undefined;
  secret: string | undefined;
  secretName?: string;
  production: boolean;
  algorithm?: "sha256" | "sha1" | "sha512";
  encoding?: "hex" | "base64";
  /** Stripped from the header before comparing, e.g. GitHub's `sha256=`. */
  prefix?: string;
  /**
   * Replay protection, for providers that sign a timestamp: the signed string
   * becomes `${timestamp}.${payload}` and a timestamp further than
   * `toleranceSeconds` from now is refused.
   */
  timestamp?: string | null;
  toleranceSeconds?: number;
  now?: () => number;
}

/** An HMAC of the raw body under a shared secret, compared in constant time. */
export function verifyHmac(opts: HmacOptions): AuthCheck {
  if (!opts.secret)
    return missingSecret(opts.secretName ?? "webhook secret", opts);
  const deny: AuthCheck = { ok: false, status: 401, error: "Unauthorized" };

  let signed = opts.payload;
  if (opts.toleranceSeconds !== undefined) {
    const ts = Number(opts.timestamp);
    const nowSec = (opts.now?.() ?? Date.now()) / 1000;
    if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > opts.toleranceSeconds)
      return deny;
    signed = `${opts.timestamp}.${opts.payload}`;
  }

  let given = opts.signature?.trim() ?? "";
  if (opts.prefix) {
    if (!given.startsWith(opts.prefix)) return deny;
    given = given.slice(opts.prefix.length);
  }
  const expected = createHmac(opts.algorithm ?? "sha256", opts.secret)
    .update(signed)
    .digest(opts.encoding ?? "hex");
  return constantTimeEqual(given, expected) ? { ok: true } : deny;
}

export interface SvixOptions {
  /** The RAW request body, exactly as received. */
  payload: string;
  /** The `svix-id`, `svix-timestamp` and `svix-signature` headers. */
  id: string | null | undefined;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  /** `whsec_<base64>`, as the provider shows it. */
  secret: string | undefined;
  secretName?: string;
  production: boolean;
  /** Svix's own libraries allow 5 minutes either way. */
  toleranceSeconds?: number;
  now?: () => number;
}

/**
 * A Svix-signed webhook (Resend, Clerk and others sign this way): HMAC-SHA256,
 * keyed by the base64-decoded part of `whsec_...`, over
 * `${svix-id}.${svix-timestamp}.${rawBody}`, base64. The signature header is a
 * space-separated list of `v1,<sig>` (several during a secret rotation): any
 * match passes. A timestamp outside the tolerance is refused, so a captured
 * request cannot be replayed later. Fails closed in production without a secret.
 */
export function verifySvix(opts: SvixOptions): AuthCheck {
  if (!opts.secret)
    return missingSecret(opts.secretName ?? "webhook secret", opts);
  const deny: AuthCheck = { ok: false, status: 401, error: "Unauthorized" };
  if (!opts.id || !opts.timestamp || !opts.signature) return deny;

  const ts = Number(opts.timestamp);
  const nowSec = (opts.now?.() ?? Date.now()) / 1000;
  if (
    !/^\d+$/.test(opts.timestamp) ||
    Math.abs(nowSec - ts) > (opts.toleranceSeconds ?? 300)
  )
    return deny;

  const key = Buffer.from(opts.secret.replace(/^whsec_/, ""), "base64");
  if (key.length === 0) return deny;
  const expected = createHmac("sha256", key)
    .update(`${opts.id}.${opts.timestamp}.${opts.payload}`)
    .digest("base64");
  const match = opts.signature.split(" ").some((part) => {
    const [version, sig] = part.split(",", 2);
    return (
      version === "v1" && sig !== undefined && constantTimeEqual(sig, expected)
    );
  });
  return match ? { ok: true } : deny;
}

/** The `Response` for a failed check (JSON body, never the secret's name in a 401). */
export function authFailure(check: Extract<AuthCheck, { ok: false }>) {
  return Response.json({ error: check.error }, { status: check.status });
}

/**
 * For an HTTP cron endpoint: `Authorization: Bearer $CRON_SECRET`.
 *
 *   export async function POST(req: Request) {
 *     const denied = requireCronAuth(req);
 *     if (denied) return denied;
 *     ...
 *   }
 */
export function requireCronAuth(request: Request): Response | null {
  const e = env();
  const check = verifyBearer(
    request.headers.get("authorization"),
    e.CRON_SECRET,
    { production: e.NODE_ENV === "production", secretName: "CRON_SECRET" },
  );
  return check.ok ? null : authFailure(check);
}
