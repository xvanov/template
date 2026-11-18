import { describe, expect, it } from "@jest/globals";

import { routeForPush } from "./push-route";

describe("routeForPush", () => {
  it("opens what the push was about", () => {
    expect(routeForPush({ kind: "item", id: "cm0xyz" })).toBe("/items");
    // @module:agent
    expect(
      routeForPush({ kind: "proposal", id: "cm1abc", messageId: "x" }),
    ).toBe("/proposal/cm1abc");
    // @end
    // @module:inbound
    expect(routeForPush({ kind: "inbound", id: "cm2def" })).toBe(
      "/inbox/cm2def",
    );
    // @end
  });

  it("opens nothing for anything else (test pushes, junk, path tricks)", () => {
    expect(routeForPush({ kind: "test" })).toBeNull();
    expect(routeForPush({ kind: "item" })).toBeNull();
    expect(routeForPush({ kind: "proposal" })).toBeNull();
    expect(routeForPush({ kind: "inbound", id: "../settings" })).toBeNull();
    expect(routeForPush({ kind: "inbound", id: 42 })).toBeNull();
    expect(routeForPush(null)).toBeNull();
    expect(routeForPush("proposal")).toBeNull();
  });
});
