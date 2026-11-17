/**
 * The default cap alert: once per tenant per UTC day from this process, so a
 * tenant hammering a capped feature does not write a "deduped" notification
 * row per refused call. notify itself is mocked (no database here).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const notifyOperator = vi.fn(async () => ({}));
vi.mock("@repo/notify", () => ({ notifyOperator }));

const { createLlm, LlmBudgetExceededError } = await import("./index");
const { setLlmEnv } = await import("./test-env");

const llm = createLlm({
  call: async () => {
    throw new Error("must not be called");
  },
  ledger: {
    reserve: async (_row, _capped, check) => ({
      id: null,
      decision: check(5),
      spentUsd: 5,
    }),
    settle: async () => undefined,
  },
  warn: () => undefined,
});
const ask = (organizationId: string) =>
  llm.ask({
    purpose: "test.cap-alert",
    priority: "discretionary",
    organizationId,
    prompt: "x",
    maxOutputTokens: 100,
  });

beforeEach(() =>
  setLlmEnv({ ANTHROPIC_API_KEY: "test", LLM_DAILY_CAP_USD: "1" }),
);

describe("cap alert", () => {
  it("alerts once per org per day, however many calls are refused", async () => {
    for (const org of ["org_a", "org_a", "org_a", "org_b"]) {
      await expect(ask(org)).rejects.toBeInstanceOf(LlmBudgetExceededError);
    }
    expect(notifyOperator).toHaveBeenCalledTimes(2);
    expect(notifyOperator).toHaveBeenCalledWith(
      expect.objectContaining({
        priority: "normal",
        organizationId: "org_a",
        dedupeKey: expect.stringMatching(/^ai-cap:org_a:\d{4}-\d{2}-\d{2}$/),
        dedupeWindowMinutes: 1440,
      }),
    );
  });
});
