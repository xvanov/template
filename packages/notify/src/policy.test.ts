import { describe, expect, it } from "vitest";

import {
  dueSlot,
  localParts,
  ntfyPriority,
  parseDigestTimes,
  renderDigest,
} from "./policy";

const at = (iso: string) => new Date(iso);

describe("ntfyPriority", () => {
  it("maps low…urgent to ntfy 2…5", () => {
    expect(
      (["low", "normal", "high", "urgent"] as const).map(ntfyPriority),
    ).toEqual([2, 3, 4, 5]);
  });
});

describe("digest slots", () => {
  const times = parseDigestTimes("17:00, 9");

  it("parses, sorts and deduplicates times", () => {
    expect(times).toEqual([540, 1020]);
    expect(parseDigestTimes("9:00,09:00,bad")).toEqual([540]);
  });

  it("the latest slot at or before now, today's or yesterday's last", () => {
    const slot = (iso: string, lastSlot?: string) =>
      dueSlot({ times, now: at(iso), timeZone: "UTC", lastSlot });
    expect(slot("2026-03-02T10:00:00Z")).toBe("2026-03-02 09:00");
    expect(slot("2026-03-02T17:00:00Z")).toBe("2026-03-02 17:00");
    expect(slot("2026-03-01T08:59:00Z")).toBe("2026-02-28 17:00");
    expect(slot("2026-01-01T03:00:00Z")).toBe("2025-12-31 17:00");
  });

  it("runs a slot once, and a missed backlog collapses into one", () => {
    const now = at("2026-03-05T10:00:00Z");
    expect(
      dueSlot({ times, now, timeZone: "UTC", lastSlot: "2026-03-05 09:00" }),
    ).toBeNull();
    // Down since two days ago: only the latest slot runs.
    expect(
      dueSlot({ times, now, timeZone: "UTC", lastSlot: "2026-03-03 09:00" }),
    ).toBe("2026-03-05 09:00");
  });

  it("slots are local to the timezone, across DST", () => {
    // New York 09:00 is 14:00 UTC in winter and 13:00 UTC in summer.
    const ny = (iso: string) =>
      dueSlot({ times: [540], now: at(iso), timeZone: "America/New_York" });
    expect(ny("2026-01-15T14:00:00Z")).toBe("2026-01-15 09:00");
    expect(ny("2026-01-15T13:59:00Z")).toBe("2026-01-14 09:00");
    expect(ny("2026-07-15T13:00:00Z")).toBe("2026-07-15 09:00");
    expect(localParts(at("2026-07-15T04:30:00Z"), "America/New_York")).toEqual({
      date: "2026-07-15",
      minutes: 30,
    });
  });

  it("no times = no digest", () => {
    expect(dueSlot({ times: [], now: new Date(), timeZone: "UTC" })).toBeNull();
  });
});

describe("renderDigest", () => {
  const row = (priority: string, title: string, body = "", min = 0) => ({
    priority,
    title,
    body,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, min)),
  });

  it("most urgent first, then oldest; one line each with the body's first line", () => {
    const d = renderDigest(
      [
        row("low", "New sign-up", "", 1),
        row("normal", "Cap hit", "\norg_1 spent $2", 2),
        row("low", "Another sign-up", "", 0),
      ],
      "2026-01-01 09:00",
    );
    expect(d.title).toBe("Digest 09:00: 3 notifications");
    expect(d.body.split("\n")).toEqual([
      "- [normal] Cap hit — org_1 spent $2",
      "- Another sign-up",
      "- New sign-up",
    ]);
  });

  it("caps the list and says how many more", () => {
    const many = Array.from({ length: 30 }, (_, i) => row("low", `n${i}`));
    const lines = renderDigest(many, "2026-01-01 09:00").body.split("\n");
    expect(lines).toHaveLength(26);
    expect(lines.at(-1)).toMatch(/and 5 more/);
  });
});
