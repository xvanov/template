/**
 * Seed a demo workspace with realistic sample data: a user who can sign in
 * straight away, items, a document indexed for search, an inbox message.
 * Run by `make demo` (scripts/demo.sh); on its own:
 *
 *   npm run demo:seed -w worker -- [--email demo@example.com] [--password demo-password]
 *
 * Deterministic and idempotent: every run converges on the same rows (and
 * resets the demo user's password to the one given). Needs no AI and no
 * running worker: the document is indexed here, keyword-only, so search
 * works with the AI off; "Re-index" in the app adds embeddings later.
 *
 * Refuses NODE_ENV=production: a known password in production is a hole.
 */
import "@repo/env/load";

import { hashPassword } from "better-auth/crypto";
import { db } from "@repo/db";
import { env } from "@repo/env";
import { documentHash, ingestDocument } from "@repo/rag";

import { DEMO_DOC, DEMO_INBOX, DEMO_ITEMS, DEMO_ORG } from "./data";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

async function main() {
  if (env().NODE_ENV === "production") {
    throw new Error(
      "refusing to seed demo credentials with NODE_ENV=production",
    );
  }
  const email = arg("email", "demo@example.com").toLowerCase();
  const password = arg("password", "demo-password");
  if (password.length < 8) throw new Error("--password must be 8+ characters");

  const org = await db.organization.upsert({
    where: { slug: DEMO_ORG.slug },
    update: { name: DEMO_ORG.name },
    create: { name: DEMO_ORG.name, slug: DEMO_ORG.slug },
  });

  // A credential account the way better-auth writes one (its own hasher), with
  // the email already verified, so sign-in works without the mail round trip.
  const user = await db.user.upsert({
    where: { email },
    update: { emailVerified: true },
    create: { email, name: "Demo User", emailVerified: true },
  });
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

  for (const item of DEMO_ITEMS) {
    const existing = await db.item.findFirst({
      where: { organizationId: org.id, title: item.title },
      select: { id: true },
    });
    if (existing) {
      await db.item.updateMany({
        where: { id: existing.id, organizationId: org.id },
        data: { notes: item.notes, done: item.done },
      });
    } else {
      await db.item.create({
        data: { ...item, organizationId: org.id, createdById: user.id },
      });
    }
  }

  let doc = await db.document.findFirst({
    where: { organizationId: org.id, title: DEMO_DOC.title },
    select: { id: true },
  });
  if (!doc) {
    doc = await db.document.create({
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
  }
  // Indexed here, not by the worker: deterministic, and no embedding spend.
  const indexed = await ingestDocument(
    { organizationId: org.id, documentId: doc.id },
    { embeddingModel: () => null },
  );

  await db.inboundMessage.upsert({
    where: {
      provider_providerMessageId: {
        provider: "generic",
        providerMessageId: DEMO_INBOX.providerMessageId,
      },
    },
    update: {},
    create: {
      ...DEMO_INBOX,
      organizationId: org.id,
      provider: "generic",
      channel: "email",
      snippet: DEMO_INBOX.text.slice(0, 200),
      status: "processed",
      processedAt: new Date(),
    },
  });

  console.log(
    `[demo] org=${org.slug} user=${email} items=${DEMO_ITEMS.length} doc=${indexed.status} inbox=1`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error("[demo] seed failed:", err);
    process.exit(1);
  });
