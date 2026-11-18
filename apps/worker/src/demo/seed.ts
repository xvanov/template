/**
 * Seed a demo workspace with realistic sample data: a user who can sign in
 * straight away, items, a document indexed for search, an inbox message.
 * Run by `make demo` (scripts/demo.sh); on its own:
 *
 *   npm run demo:seed -w worker -- [--email demo@example.com] [--password demo-password] [--allow-remote-db]
 *
 * Every run RESETS the demo workspace to the same content (its items,
 * documents and inbox are replaced) and the demo user's password to the one
 * given. Needs no AI and no running worker: the document is indexed here,
 * keyword-only, so search works with the AI off.
 *
 * It writes a known password, so it refuses (guard.ts):
 *   - NODE_ENV=production;
 *   - a DATABASE_URL that is not on this machine, without --allow-remote-db;
 *   - an organization or an account it did not create itself (it marks its
 *     own organization's metadata with the id of the user it created).
 */
import "@repo/env/load";

import { hashPassword } from "better-auth/crypto";
import { db } from "@repo/db";
import { env } from "@repo/env";
import { documentHash, ingestDocument } from "@repo/rag";

import { DEMO_DOC, DEMO_INBOX, DEMO_ITEMS, DEMO_ORG } from "./data";
import {
  isLocalDatabaseUrl,
  ownershipProblem,
  readMark,
  writeMark,
} from "./guard";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

class Refused extends Error {}

async function main() {
  const e = env();
  if (e.NODE_ENV === "production") {
    throw new Refused(
      "refusing to seed demo credentials with NODE_ENV=production",
    );
  }
  if (
    !isLocalDatabaseUrl(e.DATABASE_URL) &&
    !process.argv.includes("--allow-remote-db")
  ) {
    throw new Refused(
      "DATABASE_URL is not on this machine; refusing to write a known password there. " +
        "If that database really is a throwaway, run with DEMO_ALLOW_REMOTE_DB=1.",
    );
  }
  const email = arg("email", "demo@example.com").toLowerCase();
  const password = arg("password", "demo-password");
  if (password.length < 8)
    throw new Refused("--password must be 8+ characters");

  const existingOrg = await db.organization.findUnique({
    where: { slug: DEMO_ORG.slug },
    select: { id: true, metadata: true },
  });
  const existingUser = await db.user.findUnique({
    where: { email },
    select: { id: true },
  });
  const problem = ownershipProblem({
    slug: DEMO_ORG.slug,
    email,
    org: existingOrg,
    user: existingUser,
  });
  if (problem) throw new Refused(problem);

  // From here on, every row touched is the seed's own (or new).
  const user =
    existingUser ??
    (await db.user.create({
      data: { email, name: "Demo User", emailVerified: true },
      select: { id: true },
    }));
  const org = existingOrg
    ? await db.organization.update({
        where: { id: existingOrg.id },
        data: { name: DEMO_ORG.name, metadata: writeMark(user.id) },
        select: { id: true, slug: true, metadata: true },
      })
    : await db.organization.create({
        data: {
          name: DEMO_ORG.name,
          slug: DEMO_ORG.slug,
          metadata: writeMark(user.id),
        },
        select: { id: true, slug: true, metadata: true },
      });
  if (readMark(org.metadata)?.userId !== user.id) {
    throw new Error("demo marker was not written"); // cannot happen; belt and braces
  }

  // A credential account the way better-auth writes one (its own hasher), with
  // the email already verified, so sign-in works without the mail round trip.
  const hash = await hashPassword(password);
  const updated = await db.account.updateMany({
    where: { userId: user.id, providerId: "credential" },
    data: { password: hash },
  });
  if (updated.count === 0) {
    await db.account.create({
      data: {
        userId: user.id,
        accountId: user.id,
        providerId: "credential",
        password: hash,
      },
    });
  }
  await db.member.upsert({
    where: {
      organizationId_userId: { organizationId: org.id, userId: user.id },
    },
    update: { role: "owner" },
    create: { organizationId: org.id, userId: user.id, role: "owner" },
  });

  // Reset the workspace's content: a demo that someone clicked through
  // yesterday starts clean today.
  const inOrg = { organizationId: org.id };
  await db.$transaction([
    db.item.deleteMany({ where: inOrg }),
    db.document.deleteMany({ where: inOrg }), // chunks cascade
    db.inboundMessage.deleteMany({ where: inOrg }),
    db.item.createMany({
      data: DEMO_ITEMS.map((item) => ({
        ...item,
        organizationId: org.id,
        createdById: user.id,
      })),
    }),
    db.inboundMessage.create({
      data: {
        ...DEMO_INBOX,
        organizationId: org.id,
        provider: "generic",
        channel: "email",
        snippet: DEMO_INBOX.text.slice(0, 200),
        status: "processed",
        processedAt: new Date(),
      },
    }),
  ]);
  const doc = await db.document.create({
    data: {
      organizationId: org.id,
      title: DEMO_DOC.title,
      source: "upload",
      contentType: "text/markdown",
      content: DEMO_DOC.content,
      contentHash: documentHash(DEMO_DOC.title, DEMO_DOC.content),
      createdById: user.id,
    },
    select: { id: true },
  });
  // Indexed here, not by the worker: deterministic, and no embedding spend.
  const indexed = await ingestDocument(
    { organizationId: org.id, documentId: doc.id },
    { embeddingModel: () => null },
  );

  console.log(
    `[demo] org=${org.slug} user=${email} items=${DEMO_ITEMS.length} doc=${indexed.status} inbox=1 (reset)`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    if (err instanceof Refused) console.error(`[demo] ${err.message}`);
    else console.error("[demo] seed failed:", err);
    process.exit(1);
  });
