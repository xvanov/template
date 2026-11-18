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
 * anywhere else. It stops working when revoked, when it expires (default 30
 * days), or when its creator is no longer a member of the organization
 * (checked on every request).
 *
 * By default a link shows COUNTS only ("3 waiting for approval"), never who
 * or what: the display is see-through and the URL is a bearer secret that can
 * end up in proxy logs. Titles and senders are opt-in per link
 * (`showDetails`), the same principle as the push notifications.
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
  showDetails: boolean;
}

/**
 * The link's principal, or null for an unknown, malformed, revoked or expired
 * link, or one whose creator has left the organization. One answer for all.
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
      expiresAt: true,
      showDetails: true,
      lastUsedAt: true,
    },
  });
  if (!link || link.revokedAt) return null;
  if (link.expiresAt && link.expiresAt.getTime() <= Date.now()) return null;
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
    showDetails: link.showDetails,
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

/** One block of the page: a heading, a count, and (with details) its rows. */
export interface GlanceSection {
  key: string;
  /** The heading ("Open items"). */
  label: string;
  count: number;
  /** Counts-only wording: "3 open items" (`${count} ${noun}`). */
  noun: string;
  /** What an empty section says. */
  empty: string;
  /** Newest first; empty when the link is counts-only. */
  rows: GlanceRow[];
}

export interface GlanceSnapshot {
  /** ISO time the snapshot was taken (server clock). */
  at: string;
  /** False: counts only, and every `rows` is empty. */
  details: boolean;
  sections: GlanceSection[];
}

function clip(s: string | null | undefined, max = MAX_TEXT): string | null {
  if (!s) return null;
  const flat = s.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * What wants a human in this organization, as current state: open items,
 * proposals waiting for approval, the newest unhandled inbound messages
 * (whichever of those this app has). Org-scoped reads only; the same things
 * the desktop shell notifies about, as state rather than a change feed.
 */
export async function glanceSnapshot(
  db: PrismaClient,
  organizationId: string,
  opts: { details: boolean } = { details: true },
): Promise<GlanceSnapshot> {
  // Counts-only never even reads the rows.
  const take = opts.details ? MAX_ROWS : 0;
  const sections: GlanceSection[] = [];

  const openItems = { organizationId, done: false };
  const [itemCount, items] = await Promise.all([
    db.item.count({ where: openItems }),
    db.item.findMany({
      where: openItems,
      orderBy: { createdAt: "desc" },
      take,
      select: { id: true, title: true, createdAt: true },
    }),
  ]);
  sections.push({
    key: "items",
    label: "Open items",
    count: itemCount,
    noun: "open items",
    empty: "Nothing open.",
    rows: items.map((i) => ({
      id: i.id,
      title: clip(i.title) ?? "Item",
      detail: null,
      at: i.createdAt.toISOString(),
    })),
  });

  // @module:agent
  const pending = { organizationId, status: "pending" };
  const [approvalCount, approvals] = await Promise.all([
    db.agentProposal.count({ where: pending }),
    db.agentProposal.findMany({
      where: pending,
      orderBy: { createdAt: "desc" },
      take,
      select: { id: true, summary: true, createdAt: true },
    }),
  ]);
  sections.push({
    key: "approvals",
    label: "Approvals",
    count: approvalCount,
    noun: "waiting for your approval",
    empty: "Nothing waiting for you.",
    rows: approvals.map((p) => ({
      id: p.id,
      title: clip(p.summary) ?? "Proposal",
      detail: null,
      at: p.createdAt.toISOString(),
    })),
  });
  // @end

  // @module:inbound
  const unhandledWhere = { organizationId, handledAt: null };
  const [unhandled, inbound] = await Promise.all([
    db.inboundMessage.count({ where: unhandledWhere }),
    db.inboundMessage.findMany({
      where: unhandledWhere,
      orderBy: { createdAt: "desc" },
      take,
      select: {
        id: true,
        fromAddress: true,
        subject: true,
        snippet: true,
        createdAt: true,
      },
    }),
  ]);
  sections.push({
    key: "inbox",
    label: "Inbox",
    count: unhandled,
    noun: "unhandled messages",
    empty: "Inbox is clear.",
    rows: inbound.map((m) => ({
      id: m.id,
      title: clip(m.fromAddress, 40) ?? "Unknown sender",
      detail: clip(m.subject) ?? clip(m.snippet),
      at: m.createdAt.toISOString(),
    })),
  });
  // @end

  return { at: new Date().toISOString(), details: opts.details, sections };
}
