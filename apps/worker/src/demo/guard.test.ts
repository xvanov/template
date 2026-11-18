import { describe, expect, it } from "vitest";

import {
  isLocalDatabaseUrl,
  ownershipProblem,
  readMark,
  writeMark,
} from "./guard";

describe("isLocalDatabaseUrl", () => {
  it.each([
    "postgresql://postgres:postgres@localhost:5442/app?schema=public",
    "postgresql://u:p@127.0.0.1:5432/app",
    "postgresql://u:p@127.1.2.3/app",
    "postgresql://u:p@[::1]:5432/app",
  ])("local: %s", (url) => expect(isLocalDatabaseUrl(url)).toBe(true));

  it.each([
    "postgresql://u:p@db.example.com:5432/app",
    "postgresql://u:p@10.0.0.5:5432/app",
    "postgresql://u:p@db:5432/app", // a compose service name: another container, maybe production's
    "postgresql://u:p@localhost.evil.com/app",
    "not a url",
  ])("not local: %s", (url) => expect(isLocalDatabaseUrl(url)).toBe(false));
});

describe("the demo marker", () => {
  it("round-trips", () => {
    expect(readMark(writeMark("u1"))).toEqual({ demoSeed: true, userId: "u1" });
  });
  it("is absent from anyone else's metadata", () => {
    expect(readMark(null)).toBeNull();
    expect(readMark("not json")).toBeNull();
    expect(readMark(JSON.stringify({ plan: "pro" }))).toBeNull();
    expect(readMark(JSON.stringify({ demoSeed: "yes" }))).toBeNull();
  });
});

describe("ownershipProblem", () => {
  const base = { slug: "demo-acme", email: "demo@example.com" };
  const marked = { metadata: writeMark("u1") };

  it("a clean database is fine", () => {
    expect(ownershipProblem({ ...base, org: null, user: null })).toBeNull();
  });
  it("re-running over the seed's own rows is fine", () => {
    expect(
      ownershipProblem({ ...base, org: marked, user: { id: "u1" } }),
    ).toBeNull();
    expect(ownershipProblem({ ...base, org: marked, user: null })).toBeNull();
  });
  it("refuses a real organization with the same slug", () => {
    expect(
      ownershipProblem({ ...base, org: { metadata: null }, user: null }),
    ).toMatch(/not created by the demo seed/);
  });
  it("refuses a real account with the demo email (it would reset its password)", () => {
    expect(
      ownershipProblem({ ...base, org: null, user: { id: "real" } }),
    ).toMatch(/refusing to reset its password/);
    expect(
      ownershipProblem({ ...base, org: marked, user: { id: "real" } }),
    ).toMatch(/refusing to reset its password/);
  });
});
