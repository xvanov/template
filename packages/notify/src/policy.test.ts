import { describe, expect, it } from "vitest";

import {
  dueSlot,
  inQuietHours,
  localParts,
  parseDigestTimes,
  parseQuietHours,
  renderDigest,
  route,
  type Priority,
} from "./policy";

const at = (iso: string) => new Date(iso);
const base = {
  sentLast24h: 0,
  budget: 3,
  quiet: parseQuietHours("22-07"),
  timeZone: "UTC",
};
const decide = (priority: Priority, now: string, over = {}) =>
  route({ ...base, priority, now: at(now), ...over });

describe("route", () => {
  it("low never interrupts; urgent always does, quiet hours included", () => {
    expect(decide("low", "2026-01-01T12:00:00Z").send).toBe(false);
    expect(decide("urgent", "2026-01-01T03:00:00Z").send).toBe(true);
  });

  it("normal and high wait out quiet hours", () => {
    for (const p of ["normal", "high"] as const) {
      expect(decide(p, "2026-01-01T23:30:00Z")).toEqual({
        send: false,
        reason: "quiet hours",
      });
      expect(decide(p, "2026-01-01T07:00:00Z").send).toBe(true);
    }
  });

  it("the budget holds normal back once spent, never high", () => {
    const spent = { sentLast24h: 3 };
    expect(decide("normal", "2026-01-01T12:00:00Z", spent).send).toBe(false);
    expect(
      decide("normal", "2026-01-01T12:00:00Z", { sentLast24h: 2 }).send,
    ).toBe(true);
    expect(decide("high", "2026-01-01T12:00:00Z", spent).send).toBe(true);
  });

  it("quiet hours are read in the configured timezone", () => {
    // 12:00 UTC is 21:00 in Tokyo (quiet from 20) but noon in London.
    const q = { quiet: parseQuietHours("20-07") };
    expect(
      decide("normal", "2026-01-01T12:00:00Z", { ...q, timeZone: "Asia/Tokyo" })
        .send,
    ).toBe(false);
    expect(
      decide("normal", "2026-01-01T12:00:00Z", {
        ...q,
        timeZone: "Europe/London",
      }).send,
    ).toBe(true);
  });
});

describe("quiet hours", () => {
  it("parses HH-HH and HH:MM-HH:MM; blank, equal or malformed = none", () => {
    expect(parseQuietHours("22-07")).toEqual({ from: 1320, to: 420 });
    expect(parseQuietHours("13:30 - 14:15")).toEqual({ from: 810, to: 855 });
    for (const none of [undefined, "", "8-8", "late", "25-3"]) {
      expect(parseQuietHours(none)).toBeNull();
    }
  });

  it("a window that does not wrap midnight", () => {
    const q = parseQuietHours("13-14");
    expect(inQuietHours(q, at("2026-01-01T13:59:00Z"), "UTC")).toBe(true);
    expect(inQuietHours(q, at("2026-01-01T14:00:00Z"), "UTC")).toBe(false);
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
