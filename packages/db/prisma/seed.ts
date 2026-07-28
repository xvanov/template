/**
 * Seed a demo tenant so a fresh clone has something to look at — and so the
 * smoke test has a known-good login.
 *
 * Idempotent: safe to run repeatedly.
 *
 * The demo password hash is produced by better-auth's own hasher via its
 * sign-up API rather than written here, so we never hard-code a hash format
 * that better-auth might change. Run `npm run db:seed` AFTER the web app is
 * reachable, or just use the sign-up form.
 */
import { db } from "../src/index";

const DEMO_ORG_SLUG = "demo";

async function main() {
  const org = await db.organization.upsert({
    where: { slug: DEMO_ORG_SLUG },
    update: {},
    create: { name: "Demo Org", slug: DEMO_ORG_SLUG },
  });

  // Attach any existing users to the demo org so a freshly signed-up account
  // lands somewhere useful instead of an empty state.
  const users = await db.user.findMany({ take: 50 });
  for (const user of users) {
    await db.member.upsert({
      where: {
        organizationId_userId: { organizationId: org.id, userId: user.id },
      },
      update: {},
      create: { organizationId: org.id, userId: user.id, role: "owner" },
    });
  }

  const seedTitles = [
    "Read the README",
    "Run `make smoke`",
    "Replace Item with your own model",
  ];

  const owner = users[0];
  if (owner) {
    for (const title of seedTitles) {
      const existing = await db.item.findFirst({
        where: { organizationId: org.id, title },
      });
      if (!existing) {
        await db.item.create({
          data: { organizationId: org.id, title, createdById: owner.id },
        });
      }
    }
  }

  console.log(
    `seeded org=${org.slug} users=${users.length} items=${owner ? seedTitles.length : 0}` +
      (owner ? "" : " (no users yet — sign up, then re-run `npm run db:seed`)"),
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
