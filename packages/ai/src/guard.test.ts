import { describe, expect, it } from "vitest";

import { assertGrounded, UngroundedOutputError, unknownFactsIn } from "./guard";

const input =
  "Balance $1,200.50 due 2026-12-01. Call 555-0100. Contact billing@acme.test or https://acme.test/pay/";

describe("unknownFactsIn", () => {
  it("passes facts repeated from the input, whatever their formatting", () => {
    const out =
      "You owe $1200.5, due 2026-12-01. Call 555-0100, pay at acme.test/pay or email BILLING@acme.test.";
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
      urls: ["evil.test"],
    });
  });

  it("catches bare domains, with or without www or a path", () => {
    expect(
      unknownFactsIn("Go to evil.com/pay or www.x.com now", [input]).urls,
    ).toEqual(["evil.com/pay", "x.com"]);
  });

  it("compares separated numbers as whole tokens, and keeps the sign", () => {
    // 555 and 1234 both appear in the input, but not as 555-1234.
    expect(unknownFactsIn("Call 555-1234", ["555 and 1234"]).numbers).toEqual([
      "555-1234",
    ]);
    expect(unknownFactsIn("Due 2026-12-02", [input]).numbers).toEqual([
      "2026-12-02",
    ]);
    expect(unknownFactsIn("Refund -5", ["fee 5"]).numbers).toEqual(["-5"]);
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
