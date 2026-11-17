/**
 * The job-failure alert carries ids and the error's class and first line,
 * truncated: never the raw (possibly multi-line, possibly customer-bearing)
 * error. notify is mocked.
 */
import { describe, expect, it, vi } from "vitest";

const notifyOperator = vi.fn(async () => ({}));
vi.mock("@repo/notify", () => ({ notifyOperator }));

const { reportFinalFailure } = await import("./worker");

describe("reportFinalFailure", () => {
  it("sends name, job id, attempts and a truncated first line; one alert per job name", async () => {
    const err = new TypeError(
      `${"x".repeat(200)}\nsecond line with jane@customer.example`,
    );
    await reportFinalFailure(
      {
        id: "42",
        name: "items.summarize",
        data: { organizationId: "org_1" },
        attemptsMade: 3,
      },
      err,
    );
    const [arg] = notifyOperator.mock.calls[0] as unknown as [
      { title: string; body: string; dedupeKey: string; priority: string },
    ];
    expect(arg.title).toBe("Job items.summarize failed for good");
    expect(arg.body).toBe(
      `TypeError: ${"x".repeat(120)}\njob 42 · attempt 3 · org org_1 · full error in job_run`,
    );
    expect(arg.body).not.toContain("customer.example");
    expect(arg).toMatchObject({
      priority: "high",
      dedupeKey: "job-failed:items.summarize",
    });
  });
});
