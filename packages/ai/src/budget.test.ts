import { describe, expect, it } from "vitest";

import { decide, startOfUtcDay } from "./budget";

describe("decide", () => {
  const cap = 2;
  it("allows discretionary work under the cap and refuses it when this call would cross it", () => {
    expect(
      decide({
        priority: "discretionary",
        spentUsd: 1,
        estimateUsd: 0.5,
        capUsd: cap,
      }),
    ).toEqual({
      allowed: true,
      overCap: false,
    });
    expect(
      decide({
        priority: "discretionary",
        spentUsd: 1.9,
        estimateUsd: 0.2,
        capUsd: cap,
      }),
    ).toEqual({
      allowed: false,
      overCap: true,
    });
  });

  it("never refuses essential work, but reports it as over the cap", () => {
    expect(
      decide({
        priority: "essential",
        spentUsd: 50,
        estimateUsd: 1,
        capUsd: cap,
      }),
    ).toEqual({
      allowed: true,
      overCap: true,
    });
  });

  it("fails closed for discretionary work when spend is unknown, open for essential", () => {
    expect(
      decide({
        priority: "discretionary",
        spentUsd: null,
        estimateUsd: 0,
        capUsd: cap,
      }).allowed,
    ).toBe(false);
    expect(
      decide({
        priority: "essential",
        spentUsd: null,
        estimateUsd: 0,
        capUsd: cap,
      }).allowed,
    ).toBe(true);
  });

  it("treats a $0 cap as 'no optional AI at all'", () => {
    expect(
      decide({
        priority: "discretionary",
        spentUsd: 0,
        estimateUsd: 0.0001,
        capUsd: 0,
      }).allowed,
    ).toBe(false);
  });
});

describe("startOfUtcDay", () => {
  it("is midnight UTC whatever the time of day", () => {
    expect(startOfUtcDay(new Date("2026-11-16T23:59:59Z")).toISOString()).toBe(
      "2026-11-16T00:00:00.000Z",
    );
  });
});
