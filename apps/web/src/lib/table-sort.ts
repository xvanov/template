/**
 * Pure sorting for components/ui/data-table.tsx. Kept in a plain .ts file so
 * it is testable without loading React, Radix or icons.
 */
import type { ReactNode } from "react";

export type SortValue = string | number | Date | null | undefined;

export type DataTableColumn<T> = {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Present = the column is sortable by this value. */
  sortValue?: (row: T) => SortValue;
  align?: "left" | "right";
  className?: string;
};

export type SortState = { key: string; dir: "asc" | "desc" } | null;

/** Nulls last in either direction; numbers and dates numerically; strings naturally. */
export function compareSortValues(a: SortValue, b: SortValue): number {
  const an = a ?? null;
  const bn = b ?? null;
  if (an === bn) return 0;
  if (an === null) return 1;
  if (bn === null) return -1;
  const av = an instanceof Date ? an.getTime() : an;
  const bv = bn instanceof Date ? bn.getTime() : bn;
  if (typeof av === "number" && typeof bv === "number") return av - bv;
  return String(av).localeCompare(String(bv), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

export function sortRows<T>(
  rows: readonly T[],
  columns: readonly DataTableColumn<T>[],
  sort: SortState,
): T[] {
  const col = sort && columns.find((c) => c.key === sort.key);
  if (!sort || !col?.sortValue) return [...rows];
  const get = col.sortValue;
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((x, y) => {
    const a = get(x);
    const b = get(y);
    // Keep nulls at the bottom whichever way the column is sorted.
    if ((a ?? null) === null || (b ?? null) === null)
      return compareSortValues(a, b);
    return sign * compareSortValues(a, b);
  });
}
