import { describe, expect, it } from "@jest/globals";

import { routeForPush } from "./push-route";

describe("routeForPush", () => {
  it("opens the proposal or the message the push was about", () => {
    expect(
      routeForPush({ kind: "proposal", id: "cm1abc", messageId: "x" }),
    ).toBe("/proposal/cm1abc");
    expect(routeForPush({ kind: "inbound", id: "cm2def" })).toBe(
      "/inbox/cm2def",
    );
  });

  it("opens nothing for anything else (test pushes, junk, path tricks)", () => {
    expect(routeForPush({ kind: "test" })).toBeNull();
    expect(routeForPush({ kind: "proposal" })).toBeNull();
    expect(routeForPush({ kind: "inbound", id: "../settings" })).toBeNull();
    expect(routeForPush({ kind: "inbound", id: 42 })).toBeNull();
    expect(routeForPush(null)).toBeNull();
    expect(routeForPush("proposal")).toBeNull();
  });
});
