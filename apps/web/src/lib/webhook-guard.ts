/**
 * What every provider webhook does around its signature check:
 *
 *   1. `webhookBody`: read the body with a hard byte cap, streaming, before
 *      any HMAC work, so an unauthenticated caller cannot make us buffer and
 *      hash hundreds of megabytes.
 *   2. verify the signature (the route).
 *   3. `refuseUnsigned`: only a request whose signature FAILED counts against
 *      a per-IP limit. A correctly signed request is never throttled: the IP
 *      comes from X-Forwarded-For, which an attacker sets at will, so a limit
 *      on all traffic would let anyone 429 Twilio's real callbacks (a STOP
 *      Twilio does not retry would be lost).
 *
 * The limit protects our capacity, so it fails OPEN (like the tRPC and MCP
 * limits): a Redis blip changes nothing for anyone.
 */
import {
  authFailure,
  clientIp,
  rateLimit,
  readBodyLimited,
  tooManyRequests,
  type AuthCheck,
} from "@repo/security";

export const WEBHOOK_LIMITS = {
  /** Provider events and callbacks are a few KB. */
  small: 256 * 1024,
  /** Generic inbound email, base64 attachments included. */ // @module:inbound
  inboundEmail: 15 * 1024 * 1024, // @module:inbound
} as const;

/** Failed signatures one IP may send per minute per webhook before 429s. */
export const FAILED_SIGNATURES_PER_MINUTE = 30;

/** The raw body, or the 413 Response to send instead. */
export async function webhookBody(
  req: Request,
  maxBytes: number,
): Promise<string | Response> {
  const body = await readBodyLimited(req, maxBytes);
  return body.ok
    ? body.text
    : Response.json({ error: body.error }, { status: body.status });
}

/** The response for a failed signature check: its 401/500, or a 429. */
export async function refuseUnsigned(
  req: Request,
  name: string,
  check: Extract<AuthCheck, { ok: false }>,
): Promise<Response> {
  const ip = clientIp(req.headers) ?? "unknown";
  try {
    const r = await rateLimit({
      key: `webhook:${name}:badsig:${ip}`,
      limit: FAILED_SIGNATURES_PER_MINUTE,
      windowSeconds: 60,
    });
    if (!r.allowed) return tooManyRequests(r);
  } catch (err) {
    console.warn(`[webhook] rate limiter unavailable for ${name}:`, err);
  }
  return authFailure(check);
}
