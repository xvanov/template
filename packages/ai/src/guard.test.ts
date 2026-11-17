import { describe, expect, it } from "vitest";

import { assertGrounded, UngroundedOutputError, unknownFactsIn } from "./guard";

describe("unknownFactsIn", () => {
  const input =
    "Balance $1,200.50 due 2026-12-01. Contact billing@acme.test or https://acme.test/pay";

  it("passes facts repeated from the input, whatever their formatting", () => {
    const out =
      "You owe $1200.5, due 2026-12-01 — pay at https://acme.test/pay. or email BILLING@acme.test";
    expect(unknownFactsIn(out, [input])).toEqual({
      numbers: [],
      emails: [],
      urls: [],
    });
  });

  it("catches an invented figure, address and link — and a changed figure", () => {
    const out =
      "Pay $840 plus a $35 fee to help@acme.test via https://evil.test";
    expect(unknownFactsIn(out, [input])).toEqual({
      numbers: ["840", "35"],
      emails: ["help@acme.test"],
      urls: ["https://evil.test"],
    });
  });

  it("checks structured output too, and honours an allow-list", () => {
    expect(
      unknownFactsIn({ total: 1235.5 }, [input], [1235.5]).numbers,
    ).toEqual([]);
    expect(() => assertGrounded({ total: 99 }, [input])).toThrow(
      UngroundedOutputError,
    );
  });
});
