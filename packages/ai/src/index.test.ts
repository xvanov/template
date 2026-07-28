import { beforeEach, describe, expect, it } from "vitest";

import { priceUsd } from "./index";

beforeEach(async () => {
  process.env.LLM_INPUT_COST_PER_MTOK = "0.40";
  process.env.LLM_OUTPUT_COST_PER_MTOK = "1.60";
  const { resetEnvCache } = await import("@repo/env");
  resetEnvCache();
});

describe("priceUsd", () => {
  it("prices input and output at their own rates", () => {
    // 1M input at $0.40 + 1M output at $1.60
    expect(priceUsd(1_000_000, 1_000_000)).toBeCloseTo(2.0, 6);
  });

  it("is zero for a call that consumed nothing", () => {
    expect(priceUsd(0, 0)).toBe(0);
  });

  it("keeps six decimals so per-call costs do not round to nothing", () => {
    // 1000 input tokens = $0.0004 — must survive, not floor to 0.00.
    expect(priceUsd(1_000, 0)).toBe(0.0004);
  });
});
