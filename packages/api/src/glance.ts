/**
 * Glance links: read-only, revocable links to a tiny "what needs me" view
 * (/glance/<secret> in apps/web), made for screens where signing in is
 * impractical — a web app on Meta Ray-Ban Display glasses, whose only text
 * input is handwriting on the wristband.
 *
 *   gl_<43 chars of base64url>   256 random bits; shown ONCE, at creation
 *
 * Only the SHA-256 is stored, like API keys (./api-keys.ts): the secret is
 * random, so a fast hash is right and lookup is one indexed equality.
 *
 * A link can do exactly one thing: read `glanceSnapshot` for its
 * organization, as its creator. It is not an API key and is never accepted
 * anywhere else. It stops working when revoked, or when its creator is no
 * longer a member of the organization (checked on every request).
 */
import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@repo/db";

const PREFIX = "gl_";
const SECRET_RE = /^gl_[A-Za-z0-9_-]{43}$/;
/** lastUsedAt is written at most this often per link. */
const TOUCH_EVERY_MS = 60_000;

export function generateGlanceSecret(): {
  secret: string;
  prefix: string;
  hash: string;
} {
  const secret = `${PREFIX}${randomBytes(32).toString("base64url")}`;
  return { secret, prefix: secret.slice(0, 8), hash: hashGlanceSecret(secret) };
}

export function hashGlanceSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** Shape check before any database work (a URL segment is user input). */
export function isGlanceSecret(value: string): boolean {
  return SECRET_RE.test(value);
}

export interface GlancePrincipal {
  linkId: string;
  organizationId: string;
  userId: string;
}

/**
 * The link's principal, or null for an unknown, malformed or revoked link, or
 * one whose creator has left the organization. One answer for all of them.
 */
export async function authenticateGlanceLink(
  db: PrismaClient,
  secret: string,
): Promise<GlancePrincipal | null> {
  if (!isGlanceSecret(secret)) return null;
  const link = await db.glanceLink.findUnique({
    where: { hash: hashGlanceSecret(secret) },
    select: {
      id: true,
      organizationId: true,
      userId: true,
      revokedAt: true,
      lastUsedAt: true,
    },
  });
  if (!link || link.revokedAt) return null;
  const member = await db.member.findUnique({
    where: {
      organizationId_userId: {
        organizationId: link.organizationId,
        userId: link.userId,
      },
    },
    select: { id: true },
  });
  if (!member) return null;
  if (
    !link.lastUsedAt ||
    Date.now() - link.lastUsedAt.getTime() > TOUCH_EVERY_MS
  ) {
    await db.glanceLink
      .updateMany({ where: { id: link.id }, data: { lastUsedAt: new Date() } })
      .catch((err: unknown) =>
        console.warn("[glance] could not stamp lastUsedAt:", err),
      );
  }
  return {
    linkId: link.id,
    organizationId: link.organizationId,
    userId: link.userId,
  };
}

// ── the snapshot ─────────────────────────────────────────────────────────

/** Few, short lines: a 600×600 display read at a glance. */
const MAX_ROWS = 5;
const MAX_TEXT = 80;

export interface GlanceRow {
  id: string;
  title: string;
  detail: string | null;
  /** ISO time. */
  at: string;
}

export interface GlanceSnapshot {
  /** ISO time the snapshot was taken (server clock). */
  at: string;
  approvals: { count: number; rows: GlanceRow[] };
  inbox: { unhandled: number; rows: GlanceRow[] };
}

function clip(s: string | null | undefined, max = MAX_TEXT): string | null {
  if (!s) return null;
  const flat = s.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * What wants a human in this organization: proposals waiting for approval and
 * the newest unhandled inbound messages. Org-scoped reads only; the same data
 * the desktop shell notifies about (routers/desktop.ts), as current state
 * rather than a change feed.
 */
export async function glanceSnapshot(
  db: PrismaClient,
  organizationId: string,
): Promise<GlanceSnapshot> {
  const [approvalCount, approvals, unhandled, inbound] = await Promise.all([
    db.agentProposal.count({ where: { organizationId, status: "pending" } }),
    db.agentProposal.findMany({
      where: { organizationId, status: "pending" },
      orderBy: { createdAt: "desc" },
      take: MAX_ROWS,
      select: { id: true, summary: true, createdAt: true },
    }),
    db.inboundMessage.count({ where: { organizationId, handledAt: null } }),
    db.inboundMessage.findMany({
      where: { organizationId, handledAt: null },
      orderBy: { createdAt: "desc" },
      take: MAX_ROWS,
      select: {
        id: true,
        channel: true,
        fromAddress: true,
        subject: true,
        snippet: true,
        createdAt: true,
      },
    }),
  ]);
  return {
    at: new Date().toISOString(),
    approvals: {
      count: approvalCount,
      rows: approvals.map((p) => ({
        id: p.id,
        title: clip(p.summary) ?? "Proposal",
        detail: null,
        at: p.createdAt.toISOString(),
      })),
    },
    inbox: {
      unhandled,
      rows: inbound.map((m) => ({
        id: m.id,
        title: clip(m.fromAddress, 40) ?? "Unknown sender",
        detail: clip(m.subject) ?? clip(m.snippet),
        at: m.createdAt.toISOString(),
      })),
    },
  };
}
