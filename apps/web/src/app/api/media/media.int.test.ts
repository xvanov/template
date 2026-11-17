/**
 * The /api/media route handlers against real Postgres, called with a REAL
 * signed better-auth session cookie: the tenant check under test is the one
 * production runs (requireTenant → resolveOrganizationId), not a mock.
 */
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@repo/db";
import { createTenant, type TestTenant } from "@repo/db/testing";
import { env } from "@repo/env";

import { GET } from "./blob/route";
import { POST } from "./upload/route";

beforeAll(() => {
  process.env.STORAGE_DRIVER = "local";
  process.env.STORAGE_LOCAL_DIR = mkdtempSync(join(tmpdir(), "media-int-"));
});

/** better-auth's signed cookie: `<token>.<base64 HMAC-SHA256>`, URI-encoded. */
function cookieFor(t: TestTenant): string {
  const sig = createHmac("sha256", env().BETTER_AUTH_SECRET)
    .update(t.sessionToken)
    .digest("base64");
  return `better-auth.session_token=${encodeURIComponent(`${t.sessionToken}.${sig}`)}`;
}

async function upload(t: TestTenant, name = "note.txt") {
  const form = new FormData();
  form.set("file", new File(["hello"], name, { type: "text/plain" }));
  return POST(
    new Request("http://localhost:3200/api/media/upload", {
      method: "POST",
      headers: { cookie: cookieFor(t) },
      body: form,
    }),
  );
}

function download(t: TestTenant | null, key: string) {
  return GET(
    new Request(
      `http://localhost:3200/api/media/blob?key=${encodeURIComponent(key)}`,
      { headers: t ? { cookie: cookieFor(t) } : {} },
    ),
  );
}

async function uploadedKey(t: TestTenant): Promise<string> {
  const res = await upload(t);
  expect(res.status).toBe(201);
  return ((await res.json()) as { key: string }).key;
}

describe("/api/media", () => {
  it("serves a tenant its own file", async () => {
    const a = await createTenant("media-own");
    const key = await uploadedKey(a);
    const res = await download(a, key);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
  });

  it("refuses a request with no session", async () => {
    const a = await createTenant("media-anon");
    const key = await uploadedKey(a);
    expect((await download(null, key)).status).toBe(401);
  });

  it("404s another org's key", async () => {
    const a = await createTenant("media-a");
    const b = await createTenant("media-b");
    const key = await uploadedKey(a);
    expect((await download(b, key)).status).toBe(404);
  });

  it("404s a member removed from the org, though their session still names it", async () => {
    const a = await createTenant("media-removed");
    const key = await uploadedKey(a);
    await db.member.deleteMany({
      where: { userId: a.userId, organizationId: a.organizationId },
    });
    expect((await download(a, key)).status).toBe(404);
    // ...and the stale stamp is cleared, so the session no longer claims it.
    const s = await db.session.findUnique({ where: { id: a.sessionId } });
    expect(s?.activeOrganizationId).toBeNull();
    expect((await upload(a)).status).toBe(403);
  });

  it("repairs a first session with no active org (sign-up) and uploads into the user's org", async () => {
    const a = await createTenant("media-first");
    await db.session.update({
      where: { id: a.sessionId },
      data: { activeOrganizationId: null },
    });
    const key = await uploadedKey(a);
    expect(key.startsWith(`org/${a.organizationId}/`)).toBe(true);
    const s = await db.session.findUnique({ where: { id: a.sessionId } });
    expect(s?.activeOrganizationId).toBe(a.organizationId);
    expect((await download(a, key)).status).toBe(200);
  });
});
