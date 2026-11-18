/**
 * Which tenant does an inbound message belong to?
 *
 * The scheme: an explicit address → tenant table (`inbound_route`), and
 * nothing guessed from the content.
 *
 *   email  Each tenant gets ONE random address on INBOUND_EMAIL_DOMAIN
 *          (`acme-k3x9p2mq@in.example.com`), created on first ask
 *          (`ensureEmailAddress`, the inbox page shows it). Random rather than
 *          the org slug: a slug is public and can be renamed, and a guessable
 *          address is a spam magnet. Plus-addressing works on top:
 *          `acme-k3x9p2mq+billing@...` routes like the bare address. Any other
 *          address can be routed by adding a row (e.g. support@yourdomain).
 *   sms    The number texted (To) if it has a row; otherwise the tenant that
 *          last texted the sender from this app (within 30 days): with one
 *          shared Twilio number that is who the person is replying to.
 *
 * No match = the message is not stored (no tenant to show it to); the
 * webhook logs it and answers 200 so the provider does not retry forever.
 */
import { randomBytes } from "node:crypto";

import { db as defaultDb, type PrismaClient } from "@repo/db";
import { env } from "@repo/env";
import { parseRecipient } from "@repo/outbound";

type Db = Pick<PrismaClient, "inboundRoute" | "outboundMessage">;

export type InboundChannel = "email" | "sms";

/** `Name <a@x>` / `a@x` → `a@x`, lowercased; null if not one plain address. */
export function plainEmail(raw: string): string | null {
  const inner = /<([^<>]+)>\s*$/.exec(raw.trim())?.[1] ?? raw;
  return parseRecipient("email", inner);
}

/** `a+tag@x` → `a@x`; unchanged when there is no tag. */
export function withoutPlusTag(address: string): string {
  return address.replace(/^([^+@]+)\+[^@]*@/, "$1@");
}

export interface Route {
  organizationId: string;
  /** The address (or number) that matched. */
  address: string;
}

/** The tenant for an email sent to any of `to` (the envelope recipients first). */
export async function routeEmail(
  to: readonly string[],
  client: Db = defaultDb,
): Promise<Route | null> {
  const candidates: string[] = [];
  for (const raw of to) {
    const a = plainEmail(raw);
    if (!a) continue;
    candidates.push(a);
    const bare = withoutPlusTag(a);
    if (bare !== a) candidates.push(bare);
  }
  if (candidates.length === 0) return null;
  const rows = await client.inboundRoute.findMany({
    where: { channel: "email", address: { in: candidates } },
    select: { organizationId: true, address: true },
  });
  // In the order the addresses were given, not the database's.
  for (const c of candidates) {
    const hit = rows.find((r) => r.address === c);
    if (hit) return hit;
  }
  return null;
}

/** How far back "the tenant that last texted this number" may reach. */
export const SMS_REPLY_WINDOW_DAYS = 30;

/** The tenant for a text from `from` to `to` (both raw; normalised here). */
export async function routeSms(
  from: string,
  to: string,
  client: Db = defaultDb,
): Promise<Route | null> {
  const toNumber = parseRecipient("sms", to);
  if (toNumber) {
    const row = await client.inboundRoute.findUnique({
      where: { channel_address: { channel: "sms", address: toNumber } },
      select: { organizationId: true, address: true },
    });
    if (row) return row;
  }
  const fromNumber = parseRecipient("sms", from);
  if (!fromNumber) return null;
  const last = await client.outboundMessage.findFirst({
    where: {
      channel: "sms",
      recipient: fromNumber,
      status: "sent",
      organizationId: { not: null },
      createdAt: {
        gte: new Date(Date.now() - SMS_REPLY_WINDOW_DAYS * 86_400_000),
      },
    },
    orderBy: { createdAt: "desc" },
    select: { organizationId: true },
  });
  return last?.organizationId
    ? { organizationId: last.organizationId, address: toNumber ?? to }
    : null;
}

/** `Acme Inc.` → `acme-inc`, at most 20 characters. */
function slugPart(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 20)
      .replace(/-+$/, "") || "inbox"
  );
}

const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // no 0/o, 1/l

function randomTag(length = 8): string {
  const bytes = randomBytes(length);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

/**
 * The tenant's inbound email address, created on first call. Null when
 * INBOUND_EMAIL_DOMAIN is unset (inbound email is off).
 */
export async function ensureEmailAddress(
  organizationId: string,
  client: Pick<PrismaClient, "inboundRoute" | "organization"> = defaultDb,
): Promise<string | null> {
  const domain = env().INBOUND_EMAIL_DOMAIN;
  if (!domain) return null;
  const existing = await client.inboundRoute.findFirst({
    where: {
      organizationId,
      channel: "email",
      address: { endsWith: `@${domain}` },
    },
    orderBy: { createdAt: "asc" },
    select: { address: true },
  });
  if (existing) return existing.address;
  const org = await client.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { name: true },
  });
  // A collision on 8 random characters is not going to happen, but a unique
  // violation is retried rather than shown to the user.
  for (let attempt = 0; attempt < 3; attempt++) {
    const address = `${slugPart(org.name)}-${randomTag()}@${domain}`;
    try {
      await client.inboundRoute.create({
        data: { organizationId, channel: "email", address },
      });
      return address;
    } catch (err) {
      if ((err as { code?: string }).code !== "P2002") throw err;
      // Maybe a concurrent first call won: use its address.
      const raced = await client.inboundRoute.findFirst({
        where: {
          organizationId,
          channel: "email",
          address: { endsWith: `@${domain}` },
        },
        select: { address: true },
      });
      if (raced) return raced.address;
    }
  }
  throw new Error("Could not allocate an inbound address.");
}
