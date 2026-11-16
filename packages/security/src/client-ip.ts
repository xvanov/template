/**
 * The caller's IP, for rate-limit keys and the audit trail.
 *
 * Takes the FIRST `x-forwarded-for` entry (the client, as told to the first
 * proxy). That header is client-controlled when there is no proxy in front, so
 * never use the result for anything stronger than rate limiting and logging.
 */
export function clientIp(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || headers.get("x-real-ip")?.trim() || null;
}
