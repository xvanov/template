/**
 * /api/mcp against real Postgres, through the real route handler and the
 * official MCP transport: authentication by API key, tenant isolation (a key
 * for org A never sees org B), proposals vs direct writes, revocation, and a
 * key whose creator left the organization.
 */
import { describe, expect, it } from "vitest";
import { db } from "@repo/db";
import { createTenant, type TestTenant } from "@repo/db/testing";

import { POST } from "./route";

let rpcId = 0;

async function rpc(
  key: string | null,
  method: string,
  params: Record<string, unknown> = {},
) {
  return POST(
    new Request("http://localhost:3200/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    }),
  );
}

/** tools/call → the tool's JSON result (or its error text). */
async function call(
  key: string,
  name: string,
  args: Record<string, unknown> = {},
) {
  const res = await rpc(key, "tools/call", { name, arguments: args });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    result: { isError?: boolean; content: { text: string }[] };
  };
  const text = body.result.content[0]!.text;
  return body.result.isError
    ? { error: text }
    : { ok: JSON.parse(text) as unknown };
}

/** An API key straight in the database, as apiKeys.create would make it. */
async function keyFor(t: TestTenant, canWrite = false) {
  const { generateApiKey } = await import("@repo/api");
  const k = generateApiKey();
  const row = await db.apiKey.create({
    data: {
      organizationId: t.organizationId,
      createdById: t.userId,
      name: "test",
      prefix: k.prefix,
      hash: k.hash,
      canWrite,
    },
  });
  return { secret: k.secret, id: row.id };
}

async function item(t: TestTenant, title: string) {
  return db.item.create({
    data: { organizationId: t.organizationId, createdById: t.userId, title },
  });
}

describe("/api/mcp", () => {
  it("refuses a missing, malformed or unknown key", async () => {
    expect((await rpc(null, "tools/list")).status).toBe(401);
    expect((await rpc("not-a-key", "tools/list")).status).toBe(401);
    expect((await rpc(`tk_${"x".repeat(43)}`, "tools/list")).status).toBe(401);
  });

  it("lists the tools over the official transport", async () => {
    const a = await createTenant("mcp-list");
    const { secret } = await keyFor(a);
    const res = await rpc(secret, "tools/list");
    const body = (await res.json()) as {
      result: { tools: { name: string }[] };
    };
    expect(body.result.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "items_list",
        "items_create",
        "items_delete",
        "agent_start",
        "agent_runs",
        "agent_run",
        "proposals_pending",
      ]),
    );
  });

  it("a key for org A sees only org A — never org B", async () => {
    const a = await createTenant("mcp-a");
    const b = await createTenant("mcp-b");
    await item(a, "A's item");
    const bItem = await item(b, "B's item");
    const { secret } = await keyFor(a, true);

    const listed = (await call(secret, "items_list")).ok as { title: string }[];
    expect(listed.map((i) => i.title)).toEqual(["A's item"]);

    // Even a WRITE key cannot touch B's row by id.
    expect(await call(secret, "items_delete", { id: bItem.id })).toEqual({
      error: "Item not found.",
    });
    expect(await db.item.count({ where: { id: bItem.id } })).toBe(1);
  });

  it("without write access, a write tool queues a proposal and changes nothing", async () => {
    const a = await createTenant("mcp-propose");
    const { secret, id } = await keyFor(a);

    const r = (await call(secret, "items_create", { title: "from claude" }))
      .ok as { applied: boolean; proposalId: string };
    expect(r.applied).toBe(false);
    expect(
      await db.item.count({ where: { organizationId: a.organizationId } }),
    ).toBe(0);
    const p = await db.agentProposal.findUniqueOrThrow({
      where: { id: r.proposalId },
    });
    expect(p).toMatchObject({
      organizationId: a.organizationId,
      source: "mcp",
      tool: "items_create",
      status: "pending",
    });
    // The audit row says which key did it.
    const audit = await db.auditEvent.findFirstOrThrow({
      where: {
        organizationId: a.organizationId,
        action: "agent.proposal.create",
      },
    });
    expect(audit).toMatchObject({
      actorId: a.userId,
      metadata: { apiKeyId: id },
    });

    const pending = (await call(secret, "proposals_pending")).ok as {
      id: string;
    }[];
    expect(pending.map((x) => x.id)).toEqual([r.proposalId]);
  });

  it("with write access, a write tool calls the mutation itself", async () => {
    const a = await createTenant("mcp-write");
    const { secret } = await keyFor(a, true);
    const r = (await call(secret, "items_create", { title: "direct" })).ok as {
      applied: boolean;
    };
    expect(r.applied).toBe(true);
    expect(
      (
        await db.item.findMany({ where: { organizationId: a.organizationId } })
      ).map((i) => i.title),
    ).toEqual(["direct"]);
  });

  it("a revoked key stops working", async () => {
    const a = await createTenant("mcp-revoked");
    const { secret, id } = await keyFor(a);
    await db.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
    expect((await rpc(secret, "tools/list")).status).toBe(401);
  });

  it("a key whose creator left the org cannot fall through to their other org", async () => {
    const a = await createTenant("mcp-left-a");
    const b = await createTenant("mcp-left-b");
    // A's user also belongs to B, then is removed from A.
    await db.member.create({
      data: {
        organizationId: b.organizationId,
        userId: a.userId,
        role: "member",
      },
    });
    await item(b, "B's item");
    const { secret } = await keyFor(a);
    await db.member.deleteMany({
      where: { organizationId: a.organizationId, userId: a.userId },
    });

    const r = await call(secret, "items_list");
    expect(r).toEqual({ error: expect.stringMatching(/no longer a member/) });
  });
});
