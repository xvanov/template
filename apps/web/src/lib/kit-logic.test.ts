/** Unit tests for the UI kit's pure logic (plain .ts: no React/Radix loaded). */
import { describe, expect, it } from "vitest";

import { errorMessage } from "./error-message";
import { matchesAccept } from "./file-accept";
import {
  compareSortValues,
  sortRows,
  type DataTableColumn,
} from "./table-sort";

type Row = { name: string; size: number | null };
const columns: DataTableColumn<Row>[] = [
  {
    key: "name",
    header: "Name",
    cell: (r) => r.name,
    sortValue: (r) => r.name,
  },
  {
    key: "size",
    header: "Size",
    cell: (r) => r.size,
    sortValue: (r) => r.size,
  },
  { key: "plain", header: "Plain", cell: () => null },
];
const rows: Row[] = [
  { name: "item 10", size: 3 },
  { name: "Item 2", size: null },
  { name: "item 1", size: 1 },
];

describe("data table sorting", () => {
  it("sorts strings naturally and case-insensitively", () => {
    const names = sortRows(rows, columns, { key: "name", dir: "asc" }).map(
      (r) => r.name,
    );
    expect(names).toEqual(["item 1", "Item 2", "item 10"]);
  });

  it("keeps nulls last in both directions", () => {
    const asc = sortRows(rows, columns, { key: "size", dir: "asc" }).map(
      (r) => r.size,
    );
    const desc = sortRows(rows, columns, { key: "size", dir: "desc" }).map(
      (r) => r.size,
    );
    expect(asc).toEqual([1, 3, null]);
    expect(desc).toEqual([3, 1, null]);
  });

  it("leaves order alone with no sort or an unsortable column", () => {
    expect(sortRows(rows, columns, null)).toEqual(rows);
    expect(sortRows(rows, columns, { key: "plain", dir: "asc" })).toEqual(rows);
  });

  it("compares dates by time", () => {
    expect(compareSortValues(new Date(1), new Date(2))).toBeLessThan(0);
  });
});

describe("file drop accept matching", () => {
  const png = { name: "Photo.PNG", type: "image/png" };
  it("matches extensions, wildcards and exact types", () => {
    expect(matchesAccept(png, undefined)).toBe(true);
    expect(matchesAccept(png, ".png")).toBe(true);
    expect(matchesAccept(png, "image/*")).toBe(true);
    expect(matchesAccept(png, "application/pdf, image/png")).toBe(true);
    expect(matchesAccept(png, ".csv,text/csv")).toBe(false);
  });
});

describe("errorMessage", () => {
  it("extracts a message from whatever was thrown", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage({ message: "trpc" })).toBe("trpc");
    expect(errorMessage(42)).toBe("Something went wrong.");
  });
});
