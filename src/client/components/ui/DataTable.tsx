// Data table: header, rows, optional selection, row click, loading skeleton and empty state
import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "../../lib/cn";
import { Skeleton } from "./Spinner";
import type { Pagination as PaginationInfo } from "@shared/types";

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
  headerClassName?: string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  empty,
  onRowClick,
  selection,
  caption,
}: {
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  loading?: boolean;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  selection?: { selected: Set<string>; onChange: (next: Set<string>) => void };
  caption?: string;
}) {
  const data = rows ?? [];
  const allSelected = selection && data.length > 0 && data.every((r) => selection.selected.has(rowKey(r)));
  const toggleAll = () => {
    if (!selection) return;
    const next = new Set(selection.selected);
    if (allSelected) data.forEach((r) => next.delete(rowKey(r)));
    else data.forEach((r) => next.add(rowKey(r)));
    selection.onChange(next);
  };
  const toggle = (id: string) => {
    if (!selection) return;
    const next = new Set(selection.selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selection.onChange(next);
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-[13px]">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="border-b border-line bg-surface-muted/80 backdrop-blur-xs">
            {selection && (
              <th className="w-10 py-3 pl-5 pr-1">
                <input
                  type="checkbox"
                  aria-label="Select all on this page"
                  checked={Boolean(allSelected)}
                  onChange={toggleAll}
                  className="h-4 w-4 rounded border-line-strong text-brand focus:ring-brand/30 accent-[rgb(var(--brand))]"
                />
              </th>
            )}
            {columns.map((c, i) => (
              <th
                key={c.key}
                scope="col"
                className={cn(
                  "whitespace-nowrap py-3 pr-4 text-2xs font-semibold uppercase tracking-wider text-ink-subtle",
                  i === 0 && !selection && "pl-5",
                  c.headerClassName
                )}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line/70">
          {loading && !rows
            ? Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} className="border-b border-line last:border-0">
                  {selection && <td className="py-3.5 pl-5" />}
                  {columns.map((c, j) => (
                    <td key={c.key} className={cn("py-3.5 pr-4", j === 0 && !selection && "pl-5")}>
                      <Skeleton className="h-3.5 w-3/4 rounded" />
                    </td>
                  ))}
                </tr>
              ))
            : data.map((row) => {
                const id = rowKey(row);
                const selected = selection?.selected.has(id);
                return (
                  <tr
                    key={id}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    className={cn(
                      "transition-colors duration-100",
                      onRowClick && "cursor-pointer hover:bg-surface-muted/80",
                      selected && "bg-brand-soft/40"
                    )}
                  >
                    {selection && (
                      <td className="py-3 pl-5 pr-1" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label="Select row"
                          checked={Boolean(selected)}
                          onChange={() => toggle(id)}
                          className="h-4 w-4 rounded border-line-strong text-brand focus:ring-brand/30 accent-[rgb(var(--brand))]"
                        />
                      </td>
                    )}
                    {columns.map((c, j) => (
                      <td key={c.key} className={cn("py-3 pr-4 align-middle text-ink", j === 0 && !selection && "pl-5", c.className)}>
                        {c.cell(row)}
                      </td>
                    ))}
                  </tr>
                );
              })}
        </tbody>
      </table>
      {!loading && data.length === 0 && empty && <div className="p-8 text-center">{empty}</div>}
    </div>
  );
}

export function Pagination({
  pagination,
  onPage,
  onPageChange,
}: {
  pagination?: PaginationInfo;
  onPage?: (page: number) => void;
  onPageChange?: (page: number) => void;
}) {
  const handler = onPageChange || onPage;
  if (!pagination || pagination.totalPages <= 1 || !handler) return null;
  const { page, totalPages, total } = pagination;
  return (
    <nav className="flex flex-col sm:flex-row items-center justify-between gap-3 border-t border-line px-4 sm:px-5 py-3 text-xs text-ink-subtle" aria-label="Pagination">
      <span className="text-center sm:text-left">
        Page <strong className="font-semibold text-ink">{page}</strong> of <strong className="font-semibold text-ink">{totalPages}</strong> ({total.toLocaleString()} total)
      </span>
      <div className="flex gap-2 w-full sm:w-auto justify-between sm:justify-end">
        <button
          onClick={() => handler(page - 1)}
          disabled={page <= 1}
          className="flex-1 sm:flex-initial justify-center inline-flex h-8 items-center gap-1 rounded-lg border border-line bg-surface px-3 font-medium text-ink shadow-xs transition-colors hover:bg-surface-muted disabled:opacity-40 disabled:hover:bg-surface"
        >
          <ChevronLeft className="h-3.5 w-3.5" /> Previous
        </button>
        <button
          onClick={() => handler(page + 1)}
          disabled={page >= totalPages}
          className="flex-1 sm:flex-initial justify-center inline-flex h-8 items-center gap-1 rounded-lg border border-line bg-surface px-3 font-medium text-ink shadow-xs transition-colors hover:bg-surface-muted disabled:opacity-40 disabled:hover:bg-surface"
        >
          Next <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </nav>
  );
}
