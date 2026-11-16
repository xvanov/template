/**
 * Call the real router as a given tenant: no HTTP, no cookies.
 *
 * The session mirrors what better-auth's `getSession` returns, so
 * `orgProcedure` runs unmodified: the tenant check under test is the real one.
 */
import { db } from "@repo/db";
import type { TestTenant } from "@repo/db/testing";

import { appRouter } from "../src/root";
import { createCallerFactory, type TRPCContext } from "../src/trpc";

const factory = createCallerFactory(appRouter);

export function callerFor(tenant: TestTenant) {
  const now = new Date();
  const session = {
    user: {
      id: tenant.userId,
      email: tenant.email,
      name: tenant.name,
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    },
    session: {
      id: tenant.sessionId,
      userId: tenant.userId,
      token: "test",
      expiresAt: new Date(now.getTime() + 3_600_000),
      createdAt: now,
      updatedAt: now,
      ipAddress: null,
      userAgent: null,
      activeOrganizationId: tenant.organizationId,
    },
  } as unknown as TRPCContext["session"];

  return factory({ db, session, headers: new Headers() });
}
