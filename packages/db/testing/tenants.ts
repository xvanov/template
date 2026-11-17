/**
 * Test fixtures. A tenant is a user, an organization, the membership joining
 * them, and a session acting in that organization: what sign-up produces.
 * Every call makes a fresh, uniquely named tenant, so test files can run in
 * parallel against the one shared schema without seeing each other's rows.
 */
import { randomBytes } from "node:crypto";

import { db } from "../src/index";

export interface TestTenant {
  userId: string;
  organizationId: string;
  sessionId: string;
  /** The session's token, for building a real signed session cookie. */
  sessionToken: string;
  email: string;
  name: string;
}

export async function createTenant(label = "tenant"): Promise<TestTenant> {
  const tag = `${label}-${randomBytes(4).toString("hex")}`;
  const email = `${tag}@example.test`;
  const user = await db.user.create({
    data: {
      name: tag,
      email,
      emailVerified: true,
      members: {
        create: {
          role: "owner",
          organization: { create: { name: `${tag} workspace`, slug: tag } },
        },
      },
    },
    select: { id: true, members: { select: { organizationId: true } } },
  });
  const organizationId = user.members[0]!.organizationId;
  const sessionToken = randomBytes(16).toString("hex");
  const session = await db.session.create({
    data: {
      userId: user.id,
      token: sessionToken,
      expiresAt: new Date(Date.now() + 3_600_000),
      activeOrganizationId: organizationId,
    },
    select: { id: true },
  });
  return {
    userId: user.id,
    organizationId,
    sessionId: session.id,
    sessionToken,
    email,
    name: tag,
  };
}
