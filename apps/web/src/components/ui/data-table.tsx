"use client";

/**
 * A small sortable table on top of the shadcn `Table` primitives. Deliberately
 * not TanStack Table: for the common case (tens to a few hundred rows,
 * client-side sort) a column list and a comparator are all you need, and it
 * costs no extra dependency. Reach for @tanstack/react-table when you need
 * pagination, column visibility or server-side sorting.
 *
 * Accessibility: sortable headers are real <button>s inside <th aria-sort>,
 * and the caption is required (visually hidden) so screen readers can name it.
 */
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

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

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  emptyState,
  initialSort = null,
  className,
}: {
  columns: DataTableColumn<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  /** Visually hidden caption; required so the table has an accessible name. */
  caption: string;
  emptyState?: ReactNode;
  initialSort?: SortState;
  className?: string;
}) {
  const [sort, setSort] = useState<SortState>(initialSort);
  const sorted = useMemo(
    () => sortRows(rows, columns, sort),
    [rows, columns, sort],
  );

  function toggle(key: string) {
    setSort((s) =>
      s?.key !== key
        ? { key, dir: "asc" }
        : s.dir === "asc"
          ? { key, dir: "desc" }
          : null,
    );
  }

  return (
    <Table className={className}>
      <TableCaption className="sr-only">{caption}</TableCaption>
      <TableHeader>
        <TableRow>
          {columns.map((col) => {
            const active = sort?.key === col.key ? sort.dir : null;
            return (
              <TableHead
                key={col.key}
                aria-sort={
                  col.sortValue
                    ? active === "asc"
                      ? "ascending"
                      : active === "desc"
                        ? "descending"
                        : "none"
                    : undefined
                }
                className={cn(
                  col.align === "right" && "text-right",
                  col.className,
                )}
              >
                {col.sortValue ? (
                  <button
                    type="button"
                    onClick={() => toggle(col.key)}
                    className={cn(
                      "-mx-1 inline-flex items-center gap-1 rounded px-1 outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
                      col.align === "right" && "flex-row-reverse",
                    )}
                  >
                    {col.header}
                    {active === "asc" ? (
                      <ArrowUp aria-hidden className="size-3.5" />
                    ) : active === "desc" ? (
                      <ArrowDown aria-hidden className="size-3.5" />
                    ) : (
                      <ChevronsUpDown
                        aria-hidden
                        className="size-3.5 text-muted-foreground/60"
                      />
                    )}
                  </button>
                ) : (
                  col.header
                )}
              </TableHead>
            );
          })}
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.length === 0 ? (
          <TableRow>
            <TableCell colSpan={columns.length} className="h-24 text-center">
              {emptyState ?? (
                <span className="text-muted-foreground">No results.</span>
              )}
            </TableCell>
          </TableRow>
        ) : (
          sorted.map((row) => (
            <TableRow key={rowKey(row)}>
              {columns.map((col) => (
                <TableCell
                  key={col.key}
                  className={cn(
                    col.align === "right" && "text-right tabular-nums",
                    col.className,
                  )}
                >
                  {col.cell(row)}
                </TableCell>
              ))}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
