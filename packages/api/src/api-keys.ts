/**
 * Organization API keys: how a machine (an MCP client) authenticates.
 *
 *   tk_<43 chars of base64url>   256 random bits; shown ONCE, at creation
 *
 * Only the SHA-256 of the secret is stored (unique index). A fast hash is
 * right here, unlike for passwords: the secret is 256 random bits, so there is
 * nothing to brute-force, and lookup must be one indexed equality.
 *
 * A key acts AS the member who created it, in the key's organization, through
 * the same `orgProcedure` checks as a browser session — so a key whose
 * creator has left the organization stops working, and a revoked key is
 * refused. `canWrite` decides whether MCP write tools act directly or queue a
 * proposal (see ./mcp.ts) — and it holds only while the creator is STILL an
 * owner or admin of the key's organization, checked on every request: a
 * demoted admin's write key quietly becomes a proposals-only key.
 */
import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@repo/db";

import type { ApiKeyIdentity } from "./trpc";

const PREFIX = "tk_";

export function generateApiKey(): {
  secret: string;
  prefix: string;
  hash: string;
} {
  const secret = `${PREFIX}${randomBytes(32).toString("base64url")}`;
  return { secret, prefix: secret.slice(0, 10), hash: hashApiKey(secret) };
}

export function hashApiKey(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** `Authorization: Bearer tk_...`, or null. */
export function bearerApiKey(authorization: string | null): string | null {
  const m = authorization?.match(/^Bearer\s+(tk_[A-Za-z0-9_-]{20,100})\s*$/);
  return m?.[1] ?? null;
}

export interface ApiKeyPrincipal extends ApiKeyIdentity {
  organizationId: string;
  userId: string;
  user: { id: string; name: string; email: string; emailVerified: boolean };
}

/** lastUsedAt is written at most this often per key. */
const TOUCH_EVERY_MS = 60_000;

/**
 * The key's principal, or null for an unknown or revoked key (one answer for
 * both: never confirm that a revoked key once existed).
 */
export async function authenticateApiKey(
  db: PrismaClient,
  secret: string,
): Promise<ApiKeyPrincipal | null> {
  const key = await db.apiKey.findUnique({
    where: { hash: hashApiKey(secret) },
    select: {
      id: true,
      organizationId: true,
      canWrite: true,
      revokedAt: true,
      lastUsedAt: true,
      createdBy: {
        select: { id: true, name: true, email: true, emailVerified: true },
      },
    },
  });
  if (!key || key.revokedAt) return null;
  const member = key.canWrite
    ? await db.member.findUnique({
        where: {
          organizationId_userId: {
            organizationId: key.organizationId,
            userId: key.createdBy.id,
          },
        },
        select: { role: true },
      })
    : null;
  // better-auth stores multiple roles comma-separated ("owner,admin").
  const roles = (member?.role ?? "").split(",").map((r) => r.trim());
  const canWrite =
    key.canWrite && (roles.includes("owner") || roles.includes("admin"));
  if (
    !key.lastUsedAt ||
    Date.now() - key.lastUsedAt.getTime() > TOUCH_EVERY_MS
  ) {
    // Bookkeeping must never fail the request.
    await db.apiKey
      .updateMany({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
      .catch((err: unknown) =>
        console.warn("[api-keys] could not stamp lastUsedAt:", err),
      );
  }
  return {
    id: key.id,
    canWrite,
    organizationId: key.organizationId,
    userId: key.createdBy.id,
    user: key.createdBy,
  };
}
