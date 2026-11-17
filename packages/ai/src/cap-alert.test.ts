/**
 * The default cap alert: once per tenant per UTC day from this process, so a
 * tenant hammering a capped feature does not write a "deduped" notification
 * row per refused call. notify itself is mocked (no database here).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const notifyOperator = vi.fn(async () => ({ status: "sent" }));
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
const flush = () => new Promise((r) => setTimeout(r, 0));
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
      await flush();
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

  it("concurrent refusals send one alert while it is in flight", async () => {
    notifyOperator.mockClear();
    await Promise.allSettled([ask("org_c"), ask("org_c"), ask("org_c")]);
    await flush();
    expect(notifyOperator).toHaveBeenCalledTimes(1);
  });

  it("memoises only once notify reports the alert recorded: a failed one is retried", async () => {
    notifyOperator.mockClear();
    notifyOperator
      .mockResolvedValueOnce({ status: "failed" })
      .mockResolvedValueOnce({ status: "blocked" })
      .mockResolvedValueOnce({ status: "held" });
    for (let i = 0; i < 5; i++) {
      await expect(ask("org_d")).rejects.toBeInstanceOf(LlmBudgetExceededError);
      await flush();
    }
    // failed → retry, blocked → retry, held → recorded; then silence.
    expect(notifyOperator).toHaveBeenCalledTimes(3);
  });

  it("a rejected notify (should not happen) also clears the memo", async () => {
    notifyOperator.mockClear();
    notifyOperator.mockRejectedValueOnce(new Error("boom"));
    for (let i = 0; i < 2; i++) {
      await expect(ask("org_e")).rejects.toBeInstanceOf(LlmBudgetExceededError);
      await flush();
    }
    expect(notifyOperator).toHaveBeenCalledTimes(2);
  });
});
