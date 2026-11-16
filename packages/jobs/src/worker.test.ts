import { describe, expect, it } from "vitest";

import { tenantOf } from "./worker";

describe("tenantOf", () => {
  it("attributes a job to the organization named in its payload", () => {
    expect(tenantOf({ organizationId: "org_1", userId: "u" })).toBe("org_1");
  });

  it("treats payloads without a tenant as system jobs", () => {
    expect(tenantOf({})).toBeNull();
    expect(tenantOf(undefined)).toBeNull();
    expect(tenantOf({ organizationId: "" })).toBeNull();
    expect(tenantOf({ organizationId: 42 })).toBeNull();
  });
});
