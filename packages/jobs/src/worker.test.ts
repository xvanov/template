import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { JobEntry, ScopeOf } from "./handlers";
import { isFinalFailure, ownerOf } from "./worker";

describe("ownerOf", () => {
  it("an org job is owned by the organizationId of its validated payload", () => {
    expect(
      ownerOf(
        "items.summarize",
        { organizationId: "org_1", userId: "u", extra: 1 },
        { organizationId: "org_1", userId: "u" },
      ),
    ).toBe("org_1");
  });

  it("reads the VALIDATED payload, not the raw job data", () => {
    expect(
      ownerOf(
        "items.summarize",
        { organizationId: "raw" },
        { organizationId: "validated" },
      ),
    ).toBe("validated");
  });

  it("a system job is owned by nobody", () => {
    expect(ownerOf("maintenance.nightly", {}, {})).toBeNull();
    expect(ownerOf("maintenance.nightly", undefined, {})).toBeNull();
  });

  it("rejects a system job that names a tenant", () => {
    expect(() =>
      ownerOf("maintenance.nightly", { organizationId: "org_1" }, {}),
    ).toThrow(/System job maintenance.nightly was given an organizationId/);
  });
});

describe("registry scope is enforced at compile time", () => {
  const withOrg = z.object({ organizationId: z.string(), n: z.number() });
  const without = z.object({ n: z.number() });
  const optionalOrg = z.object({ organizationId: z.string().optional() });
  const run = async () => null;

  it("accepts a scope that matches the schema", () => {
    const org: JobEntry<typeof withOrg> = {
      scope: "org",
      schema: withOrg,
      run,
    };
    const sys: JobEntry<typeof without> = {
      scope: "system",
      schema: without,
      run,
    };
    expect([org.scope, sys.scope]).toEqual(["org", "system"]);
  });

  it("rejects a scope that does not (checked by `make typecheck`)", () => {
    const a: JobEntry<typeof without> = {
      // @ts-expect-error an org job's payload must carry organizationId
      scope: "org",
      schema: without,
      run,
    };
    const b: JobEntry<typeof withOrg> = {
      // @ts-expect-error a payload naming a tenant cannot be a system job
      scope: "system",
      schema: withOrg,
      run,
    };
    const neither: ScopeOf<typeof optionalOrg> = undefined as never;
    const c: JobEntry<typeof optionalOrg> = {
      // @ts-expect-error an OPTIONAL organizationId fits neither scope
      scope: "org",
      schema: optionalOrg,
      run,
    };
    expect([a, b, c, neither]).toHaveLength(4);
  });
});

describe("isFinalFailure", () => {
  const err = new Error("boom");
  const job = (attemptsMade: number, attempts?: number) => ({
    attemptsMade,
    opts: { attempts },
  });

  it("is final once the attempts are used up, not before", () => {
    expect(isFinalFailure(job(1, 3), err)).toBe(false);
    expect(isFinalFailure(job(2, 3), err)).toBe(false);
    expect(isFinalFailure(job(3, 3), err)).toBe(true);
  });

  it("a job with no retries is final on its first failure", () => {
    expect(isFinalFailure(job(1), err)).toBe(true);
  });

  it("an UnrecoverableError is final whatever the count", () => {
    const fatal = Object.assign(new Error("bad payload"), {
      name: "UnrecoverableError",
    });
    expect(isFinalFailure(job(1, 3), fatal)).toBe(true);
  });
});
