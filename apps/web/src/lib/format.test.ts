import { describe, expect, it } from "vitest";

import {
  createFormatter,
  currencyDigits,
  daysUntil,
  formatBytes,
  formatCount,
  formatDate,
  formatElapsed,
  formatMoney,
  formatPercent,
  formatRelative,
  toCalendarDate,
} from "./format";

const NY = { timeZone: "America/New_York" };

describe("formatMoney", () => {
  it("formats minor units with grouping (default en-US · USD)", () => {
    expect(formatMoney(125_000)).toBe("$1,250.00");
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(5)).toBe("$0.05");
  });

  it("uses a real minus sign, + only when signed, never a negative zero", () => {
    expect(formatMoney(-2_500)).toBe("−$25.00");
    expect(formatMoney(40_000, { signed: true })).toBe("+$400.00");
    expect(formatMoney(0, { signed: true })).toBe("$0.00");
    expect(formatMoney(-0.4)).toBe("$0.00");
  });

  it("compacts in the locale's own notation", () => {
    expect(formatMoney(95_000, { compact: true })).toBe("$950");
    expect(formatMoney(1_250_000, { compact: true })).toBe("$12.5K");
    expect(formatMoney(120_000_000, { compact: true })).toBe("$1.2M");
    expect(formatMoney(-1_250_000, { compact: true })).toBe("−$12.5K");
  });

  it("follows the configured locale and currency", () => {
    const de = { locale: "de-DE", currency: "EUR" };
    expect(formatMoney(125_050, {}, de)).toBe("1.250,50 €");
    expect(formatMoney(125_050, {}, { locale: "en-GB", currency: "GBP" })).toBe(
      "£1,250.50",
    );
  });

  it("respects currencies without (or with more) minor digits", () => {
    expect(currencyDigits("JPY")).toBe(0);
    expect(currencyDigits("KWD")).toBe(3);
    expect(formatMoney(1_250, {}, { locale: "en-US", currency: "JPY" })).toBe(
      "¥1,250",
    );
  });
});

describe("numbers", () => {
  it("formats percents, counts and bytes", () => {
    expect(formatPercent(0.125)).toBe("12.5%");
    expect(formatCount(1, "item")).toBe("1 item");
    expect(formatCount(1200, "transaction")).toBe("1,200 transactions");
    expect(formatCount(2, "person", "people")).toBe("2 people");
    expect(formatCount(1200, "Eintrag", "Einträge", { locale: "de-DE" })).toBe(
      "1.200 Einträge",
    );
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 MB");
  });
});

describe("formatDate", () => {
  const at = "2026-03-08T04:30:00Z"; // 11:30 PM EST on Mar 7 in New York

  it("renders an instant in the configured timezone", () => {
    expect(formatDate(at, "date", NY)).toBe("Mar 7, 2026");
    expect(formatDate(at)).toBe("Mar 8, 2026"); // default UTC
    expect(formatDate(new Date(at), "date", NY)).toBe("Mar 7, 2026");
  });

  it("supports styles", () => {
    expect(formatDate(at, "datetime", NY)).toBe("Mar 7, 2026, 11:30 PM");
    expect(formatDate(at, "short", NY)).toBe("Mar 7");
    expect(formatDate(at, "time", NY)).toBe("11:30 PM");
    expect(formatDate(at, "long", NY)).toBe("Saturday, March 7, 2026");
  });

  it("follows the configured locale", () => {
    expect(formatDate(at, "date", { locale: "en-GB", timeZone: "UTC" })).toBe(
      "8 Mar 2026",
    );
    expect(formatDate(at, "time", { locale: "de-DE", timeZone: "UTC" })).toBe(
      "4:30",
    );
  });

  it("never shifts a calendar date by a day", () => {
    expect(formatDate("2026-11-03", "date", NY)).toBe("Nov 3, 2026");
    expect(
      formatDate("2026-11-03", "date", { timeZone: "Pacific/Honolulu" }),
    ).toBe("Nov 3, 2026");
  });

  it("renders a dash for invalid input", () => {
    expect(formatDate("not a date")).toBe("—");
  });
});

describe("calendar days", () => {
  it("toCalendarDate is the local date in the configured timezone", () => {
    expect(toCalendarDate("2026-03-08T04:30:00Z", NY)).toBe("2026-03-07");
    expect(toCalendarDate("2026-03-08T04:30:00Z")).toBe("2026-03-08");
    expect(toCalendarDate("2026-03-08")).toBe("2026-03-08");
  });

  it("daysUntil counts whole calendar days across DST", () => {
    expect(daysUntil("2026-03-09", "2026-03-07")).toBe(2);
    expect(daysUntil("2026-03-01", "2026-03-07")).toBe(-6);
    expect(daysUntil("2026-03-07T23:00:00Z", "2026-03-07")).toBe(0);
  });

  it("formatRelative words calendar distance in the locale", () => {
    const now = "2026-03-07T12:00:00Z";
    expect(formatRelative("2026-03-07", now)).toBe("today");
    expect(formatRelative("2026-03-08", now)).toBe("tomorrow");
    expect(formatRelative("2026-03-06", now)).toBe("yesterday");
    expect(formatRelative("2026-03-10", now)).toBe("in 3 days");
    expect(formatRelative("2026-03-28", now)).toBe("in 3 weeks");
    expect(formatRelative("2025-11-07", now)).toBe("4 months ago");
    expect(formatRelative("2026-03-08", now, { locale: "de-DE" })).toBe(
      "morgen",
    );
  });

  it("formatRelative evaluates 'today' in the configured timezone", () => {
    // 03:00Z on Mar 8 is still Mar 7 in New York.
    expect(formatRelative("2026-03-07", "2026-03-08T03:00:00Z", NY)).toBe(
      "today",
    );
  });
});

describe("formatElapsed", () => {
  const now = "2026-03-07T12:00:00Z";
  it("phrases wall-clock time since an instant", () => {
    expect(formatElapsed("2026-03-07T11:59:30Z", now)).toBe("just now");
    expect(formatElapsed("2026-03-07T11:48:00Z", now)).toBe("12 minutes ago");
    expect(formatElapsed("2026-03-07T09:00:00Z", now)).toBe("3 hours ago");
    expect(formatElapsed("2026-03-04T12:00:00Z", now)).toBe("3 days ago");
    expect(formatElapsed("2026-03-07T12:05:00Z", now)).toBe("in 5 minutes");
  });
});

describe("createFormatter", () => {
  it("binds every formatter to one config", () => {
    const f = createFormatter({
      locale: "en-GB",
      currency: "EUR",
      timeZone: "Europe/London",
    });
    expect(f.money(1_999)).toBe("€19.99");
    expect(f.date("2026-03-08T04:30:00Z")).toBe("8 Mar 2026");
    expect(f.today("2026-03-08T04:30:00Z")).toBe("2026-03-08");
    expect(f.config.timeZone).toBe("Europe/London");
  });
});
