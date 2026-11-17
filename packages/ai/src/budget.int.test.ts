/**
 * The spend cap against REAL Postgres: concurrent calls reserve under a
 * per-tenant advisory lock, so they cannot all read the same total and all go.
 * The provider is a fake (no network); the ledger is the real one.
 */
import { randomBytes } from "node:crypto";

import { db } from "@repo/db";
import { beforeEach, describe, expect, it } from "vitest";

import { createLlm, LlmBudgetExceededError } from "./index";
import type { ProviderResult } from "./providers/types";
import { setLlmEnv } from "./test-env";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Each call really costs $0.20 on Opus 5.5 (10K output tokens at $20/M). */
const reply: ProviderResult = {
  text: "ok",
  usage: {
    inputTokens: 0,
    outputTokens: 10_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  stop: "end",
  servedBy: "anthropic/claude-opus-5-5",
};

const llm = createLlm({
  call: async () => {
    await sleep(50); // long enough for every call to be in flight at once
    return reply;
  },
  warn: () => undefined,
});

const org = () => `org_${randomBytes(4).toString("hex")}`;
const ask = (organizationId: string) =>
  llm.ask({
    purpose: "test.cap",
    priority: "discretionary",
    organizationId,
    prompt: "x",
    maxOutputTokens: 10_000, // reserves ~$0.20
  });

async function spent(organizationId: string) {
  const rows = await db.llmCall.findMany({ where: { organizationId } });
  return {
    usd: rows.reduce((s, r) => s + r.costUsd, 0),
    pending: rows.filter((r) => r.status === "pending").length,
  };
}

beforeEach(() =>
  setLlmEnv({ ANTHROPIC_API_KEY: "test", LLM_DAILY_CAP_USD: "1" }),
);

describe("the cap under concurrency", () => {
  it("lets exactly as many concurrent calls through as the cap pays for", async () => {
    const tenant = org();
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => ask(tenant)),
    );
    const ran = results.filter((r) => r.status === "fulfilled").length;
    const refused = results.filter(
      (r) =>
        r.status === "rejected" && r.reason instanceof LlmBudgetExceededError,
    ).length;
    expect(ran).toBe(4); // 4 × ~$0.2000002 fits under $1; a 5th would cross it
    expect(refused).toBe(16);
    const s = await spent(tenant);
    expect(s.usd).toBeLessThanOrEqual(1);
    expect(s.pending).toBe(0); // every reservation settled
  });

  it("counts another process's in-flight reservation against the cap", async () => {
    const tenant = org();
    await db.llmCall.create({
      data: {
        organizationId: tenant,
        purpose: "elsewhere",
        model: "anthropic/claude-opus-5-5",
        costUsd: 0.9,
        status: "pending",
      },
    });
    await expect(ask(tenant)).rejects.toBeInstanceOf(LlmBudgetExceededError);
  });

  it("caps each tenant separately", async () => {
    const [a, b] = [org(), org()];
    const results = await Promise.allSettled(
      [...Array(6)].flatMap(() => [ask(a), ask(b)]),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(8);
  });
});
