import { describe, expect, it, vi } from "vitest";

const marked: unknown[] = [];
vi.mock("@repo/rag", () => ({
  ingestDocument: vi.fn(),
  sweepStaleIngests: vi.fn(),
  markIngestFailed: async (job: unknown, err: Error) => {
    marked.push([job, err.message]);
  },
}));

const { finalFailureHook } = await import("./worker");

describe("finalFailureHook", () => {
  it("lets docs.ingest mark its document failed once retries are used up", async () => {
    await finalFailureHook(
      {
        id: "1",
        name: "docs.ingest",
        data: { organizationId: "o", documentId: "d" },
        attemptsMade: 3,
      },
      new Error("db down"),
    );
    expect(marked).toEqual([
      [{ organizationId: "o", documentId: "d" }, "db down"],
    ]);
  });

  it("ignores jobs without a hook, unknown names and invalid payloads", async () => {
    marked.length = 0;
    await finalFailureHook(
      { id: "2", name: "maintenance.nightly", data: {}, attemptsMade: 1 },
      new Error("x"),
    );
    await finalFailureHook(
      { id: "3", name: "nope", data: {}, attemptsMade: 1 },
      new Error("x"),
    );
    await finalFailureHook(
      { id: "4", name: "docs.ingest", data: { bad: 1 }, attemptsMade: 3 },
      new Error("x"),
    );
    expect(marked).toEqual([]);
  });
});
