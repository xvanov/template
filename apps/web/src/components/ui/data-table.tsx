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
import {
  sortRows,
  type DataTableColumn,
  type SortState,
} from "@/lib/table-sort";
import { cn } from "@/lib/utils";

export type { DataTableColumn, SortState, SortValue } from "@/lib/table-sort";

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
