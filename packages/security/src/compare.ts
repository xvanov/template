import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison, for secrets.
 *
 * Both sides are hashed first so the comparison runs over two equal-length
 * digests: a plain `timingSafeEqual` throws on unequal lengths, and the usual
 * "return false if lengths differ" guard leaks the secret's length.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db) && a.length === b.length;
}
