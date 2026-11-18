/**
 * /glance/<secret> through the real route handler and real Postgres: a valid
 * link shows its own organization only, an unknown or revoked one gets the
 * same 404, and the secret is kept out of caches and referrers.
 */
import { describe, expect, it } from "vitest";
import { createCallerFactory, appRouter } from "@repo/api";
import { db } from "@repo/db";
import { createTenant, type TestTenant } from "@repo/db/testing";

import { GET } from "./route";

function caller(t: TestTenant) {
  const now = new Date();
  return createCallerFactory(appRouter)({
    db,
    headers: new Headers(),
    session: {
      user: {
        id: t.userId,
        email: t.email,
        name: t.name,
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      },
      session: {
        id: t.sessionId,
        userId: t.userId,
        token: "t",
        expiresAt: new Date(now.getTime() + 3_600_000),
        createdAt: now,
        updatedAt: now,
        ipAddress: null,
        userAgent: null,
        activeOrganizationId: t.organizationId,
      },
    } as never,
  });
}

const open = (token: string) =>
  GET(new Request(`http://localhost:3200/glance/${token}`), {
    params: Promise.resolve({ token }),
  });

describe("/glance/[token]", () => {
  it("renders the link's own organization, with no-store and no-referrer", async () => {
    const a = await createTenant("glance-route-a");
    const b = await createTenant("glance-route-b");
    await db.agentProposal.create({
      data: {
        organizationId: b.organizationId,
        tool: "items_create",
        input: {},
        summary: "secret plan of B",
      },
    });
    await db.agentProposal.create({
      data: {
        organizationId: a.organizationId,
        tool: "items_create",
        input: {},
        summary: "Approve the desk order",
      },
    });
    const link = await caller(a).glance.createLink({ name: "glasses" });

    const res = await open(link.secret);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    const html = await res.text();
    expect(html).toContain("Approve the desk order");
    expect(html).not.toContain("secret plan of B");
  });

  it("answers an unknown and a revoked link the same way", async () => {
    const a = await createTenant("glance-route-revoked");
    const link = await caller(a).glance.createLink({ name: "old" });
    await caller(a).glance.revokeLink({ id: link.id });

    const revoked = await open(link.secret);
    const unknown = await open(`gl_${"A".repeat(43)}`);
    expect(revoked.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await revoked.text()).toBe(await unknown.text());
  });
});
