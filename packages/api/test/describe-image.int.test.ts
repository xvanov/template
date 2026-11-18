/**
 * ai.describeImage: only this tenant's photos, only image types a vision
 * model takes, and the bytes go to ask() as a capped, discretionary call. The
 * model and the storage are stubbed: no test may reach a real provider.
 */
import { describe, expect, it, vi } from "vitest";
import { db } from "@repo/db";
import { createTenant, type TestTenant } from "@repo/db/testing";

import { callerFor } from "./caller";

const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const asked: Record<string, unknown>[] = [];
let truncate = false;

vi.mock("@repo/storage", () => ({
  storage: () => ({ get: async () => BYTES }),
}));
vi.mock("@repo/ai", async (importOriginal) => {
  const real = await importOriginal<typeof import("@repo/ai")>();
  return {
    ...real,
    ask: async (opts: Record<string, unknown>) => {
      asked.push(opts);
      if (truncate) throw new real.LlmTruncatedError("A mug on a", 0.002);
      return {
        text: "A mug on a desk.",
        servedBy: "anthropic/test",
        costUsd: 0.001,
        costKnown: true,
        latencyMs: 5,
      };
    },
  };
});

const photo = (t: TestTenant, contentType: string, sizeBytes = 4) =>
  db.mediaAsset.create({
    data: {
      organizationId: t.organizationId,
      uploadedById: t.userId,
      key: `test/${t.organizationId}/${Math.random()}`,
      filename: "glasses.jpg",
      contentType,
      sizeBytes,
    },
  });

describe("ai.describeImage", () => {
  it("describes this tenant's photo, and not another tenant's", async () => {
    const a = await createTenant("describe-a");
    const b = await createTenant("describe-b");
    const jpeg = await photo(a, "image/jpeg");

    await expect(
      callerFor(b).ai.describeImage({ mediaId: jpeg.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(asked).toHaveLength(0);

    const r = await callerFor(a).ai.describeImage({ mediaId: jpeg.id });
    expect(r.text).toBe("A mug on a desk.");
    expect(asked[0]).toMatchObject({
      purpose: "media.describe",
      priority: "discretionary",
      organizationId: a.organizationId,
      userId: a.userId,
      images: [{ data: BYTES, mediaType: "image/jpeg" }],
    });
    expect(asked[0]!.maxOutputTokens).toBeLessThanOrEqual(400);
  });

  it("refuses files a vision model cannot take, before calling it", async () => {
    const a = await createTenant("describe-types");
    const pdf = await photo(a, "application/pdf");
    const heic = await photo(a, "image/heic");
    // 4 MB: under 5 MB, but its base64 is over Anthropic's 5 MB limit.
    const huge = await photo(a, "image/png", 4 * 1024 * 1024);
    asked.length = 0;
    for (const asset of [pdf, heic, huge]) {
      await expect(
        callerFor(a).ai.describeImage({ mediaId: asset.id }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(asked).toHaveLength(0);
  });

  it("returns a cut-off description labelled as truncated", async () => {
    const a = await createTenant("describe-truncated");
    const jpeg = await photo(a, "image/jpeg");
    truncate = true;
    try {
      expect(
        await callerFor(a).ai.describeImage({ mediaId: jpeg.id }),
      ).toMatchObject({ text: "A mug on a", truncated: true });
    } finally {
      truncate = false;
    }
  });
});
