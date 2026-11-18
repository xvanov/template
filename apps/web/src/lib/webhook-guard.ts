/**
 * The two checks every provider webhook makes before it looks at a
 * signature: a per-IP rate limit and a hard cap on the body size. Both run
 * before any HMAC work, so an unauthenticated flood costs us a counter
 * increment, not a buffered body and a hash.
 *
 * The rate limit protects OUR capacity, so it fails OPEN (like the tRPC and
 * MCP limits): a Redis blip must not drop a provider's real callbacks.
 * Providers send from many IPs and in bursts; the default is generous.
 */
import {
  clientIp,
  rateLimit,
  readBodyLimited,
  tooManyRequests,
} from "@repo/security";

export const WEBHOOK_LIMITS = {
  /** Resend events and Twilio callbacks are a few KB. */
  small: 256 * 1024,
  /** Generic inbound email, base64 attachments included. */
  inboundEmail: 15 * 1024 * 1024,
} as const;

/** The raw body, or the Response (413/429) to send instead. */
export async function webhookBody(
  req: Request,
  opts: { name: string; maxBytes: number; perMinute?: number },
): Promise<string | Response> {
  const ip = clientIp(req.headers) ?? "unknown";
  try {
    const r = await rateLimit({
      key: `webhook:${opts.name}:${ip}`,
      limit: opts.perMinute ?? 600,
      windowSeconds: 60,
    });
    if (!r.allowed) return tooManyRequests(r);
  } catch (err) {
    console.warn(
      `[webhook] rate limiter unavailable for ${opts.name}, allowing:`,
      err,
    );
  }
  const body = await readBodyLimited(req, opts.maxBytes);
  return body.ok
    ? body.text
    : Response.json({ error: body.error }, { status: body.status });
}
