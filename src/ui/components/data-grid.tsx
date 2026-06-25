"use client";

import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/ui/components/button";

export interface GridColumnBase {
  key: string;
  label: ReactNode;
  min: number;
  width: number;
}

export interface DataColumn<T> extends GridColumnBase {
  align?: "left" | "right" | "center";
  cellClassName?: string | ((row: T) => string | undefined);
  render: (row: T) => ReactNode;
}

export type GridFilter<T> =
  | { key: string; label: string; kind?: "text"; placeholder?: string; predicate: (row: T, value: string) => boolean }
  | { key: string; label: string; kind: "select"; options: { value: string; label: string }[]; predicate: (row: T, value: string) => boolean }
  | { key: string; label: string; kind: "range"; placeholder?: [string, string]; predicate: (row: T, min: number | null, max: number | null) => boolean };

const PAGE_SIZES = [10, 20, 50, 100, 0];
const widthsKey = (key: string) => `ctwe.gridWidths.${key}`;

function buildPageList(current: number, total: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Set<number>([1, total, current, current - 1, current + 1]);
  const sorted = [...pages].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  const result: (number | "…")[] = [];
  let prev = 0;
  for (const page of sorted) {
    if (page - prev > 1) result.push("…");
    result.push(page);
    prev = page;
  }
  return result;
}

/** Resizable, screen-fitting, sessionStorage-persisted column widths shared by every grid. */
export function useResizableColumns(columns: readonly { min: number; width: number }[], storageKey: string) {
  const minsRef = useRef(columns.map((column) => column.min)); minsRef.current = columns.map((column) => column.min);
  const defaultsRef = useRef(columns.map((column) => column.width)); defaultsRef.current = columns.map((column) => column.width);
  const count = columns.length;
  const [widths, setWidths] = useState<number[] | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const resizedRef = useRef(false);
  const resizeRef = useRef<{ index: number; startX: number; startW: number } | null>(null);
  const colWidths = widths ?? defaultsRef.current;

  const startResize = (index: number, clientX: number) => { resizedRef.current = true; resizeRef.current = { index, startX: clientX, startW: colWidths[index] }; };

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const state = resizeRef.current; if (!state) return;
      const delta = event.clientX - state.startX;
      setWidths((prev) => { const next = [...(prev ?? defaultsRef.current)]; next[state.index] = Math.max(minsRef.current[state.index], state.startW + delta); return next; });
    };
    const onUp = () => { resizeRef.current = null; document.body.classList.remove("col-resizing"); };
    window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  // Restore saved widths, or pick a default that fits all columns into the visible width.
  useEffect(() => {
    let restored: number[] | null = null;
    try {
      const raw = sessionStorage.getItem(widthsKey(storageKey));
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length === count && parsed.every((value) => typeof value === "number" && value > 0)) restored = parsed;
      }
    } catch { /* ignore malformed storage */ }
    if (restored) { resizedRef.current = true; setWidths(restored); return; }
    resizedRef.current = false;
    const available = (scrollRef.current?.clientWidth ?? 0) - 2;
    const totalDefault = defaultsRef.current.reduce((sum, value) => sum + value, 0);
    setWidths(available > 0 ? defaultsRef.current.map((value, index) => Math.max(minsRef.current[index], Math.round(value * (available / totalDefault)))) : [...defaultsRef.current]);
  }, [storageKey, count]);

  // Persist only widths the user dragged — never the auto-fit defaults.
  useEffect(() => {
    if (!widths || !resizedRef.current) return;
    try { sessionStorage.setItem(widthsKey(storageKey), JSON.stringify(widths)); } catch { /* ignore */ }
  }, [widths, storageKey]);

  const totalWidth = colWidths.reduce((sum, value) => sum + value, 0);
  return { colWidths, totalWidth, scrollRef, startResize };
}

export function usePagination(total: number, resetKey: string, initialSize = 20) {
  const [pageSize, setPageSize] = useState(initialSize);
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [resetKey, pageSize]);
  const size = pageSize === 0 ? Math.max(total, 1) : pageSize;
  const totalPages = Math.max(1, Math.ceil(total / size));
  return { pageSize, setPageSize, page: Math.min(page, totalPages), setPage, size, totalPages };
}

export function GridHead({ columns, colWidths, startResize, columnFilters }: { columns: GridColumnBase[]; colWidths: number[]; startResize: (index: number, clientX: number) => void; columnFilters?: Partial<Record<string, ReactNode>> }) {
  return (
    <>
      <colgroup>{columns.map((column, index) => <col key={column.key} style={{ width: colWidths[index] }} />)}</colgroup>
      <thead>
        <tr>{columns.map((column, index) => (
          <th key={column.key} className={`egrid-th egrid-col-${column.key}`}>
            <span className="egrid-th__label">{column.label}</span>
            {columnFilters?.[column.key] ? <span className="egrid-th__filterwrap">{columnFilters[column.key]}</span> : null}
            <span className="egrid-resizer" role="separator" aria-orientation="vertical" aria-label="ปรับความกว้างคอลัมน์" onMouseDown={(event) => { event.preventDefault(); document.body.classList.add("col-resizing"); startResize(index, event.clientX); }} />
          </th>
        ))}</tr>
      </thead>
    </>
  );
}

export function GridPagination({ idBase, pageSize, setPageSize, page, totalPages, setPage, total, grandTotal, start, end, unit = "รายการ" }: {
  idBase: string;
  pageSize: number;
  setPageSize: (value: number) => void;
  page: number;
  totalPages: number;
  setPage: (value: number) => void;
  total: number;
  grandTotal: number;
  start: number;
  end: number;
  unit?: string;
}) {
  const num = (value: number) => value.toLocaleString("th-TH");
  return (
    <div className="entry-pagination">
      <div className="entry-pagination__size">
        <span className="entry-pagination__info">{total === 0 ? `ไม่มี${unit}` : `แสดง ${num(start)}–${num(end)} จาก ${num(total)} ${unit}`}{grandTotal > total ? ` · กรองจาก ${num(grandTotal)}` : ""}</span>
        <label htmlFor={`page-size-${idBase}`}>ต่อหน้า</label>
        <select id={`page-size-${idBase}`} className="select" value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>{PAGE_SIZES.map((value) => <option key={value} value={value}>{value === 0 ? "ทั้งหมด" : value}</option>)}</select>
      </div>
      <div className="entry-pagination__pages">
        <button type="button" className="page-btn" aria-label="หน้าแรก" disabled={page === 1} onClick={() => setPage(1)}><ChevronsLeft size={15} /></button>
        <button type="button" className="page-btn" aria-label="ก่อนหน้า" disabled={page === 1} onClick={() => setPage(page - 1)}><ChevronLeft size={15} /></button>
        {buildPageList(page, totalPages).map((item, index) => item === "…"
          ? <span key={`gap-${index}`} className="page-gap">…</span>
          : <button type="button" key={item} className={`page-btn${item === page ? " page-btn--active" : ""}`} aria-current={item === page ? "page" : undefined} onClick={() => setPage(item)}>{item}</button>)}
        <button type="button" className="page-btn" aria-label="ถัดไป" disabled={page === totalPages} onClick={() => setPage(page + 1)}><ChevronRight size={15} /></button>
        <button type="button" className="page-btn" aria-label="หน้าสุดท้าย" disabled={page === totalPages} onClick={() => setPage(totalPages)}><ChevronsRight size={15} /></button>
      </div>
    </div>
  );
}

function cellClass<T>(column: DataColumn<T>, row: T) {
  const base = column.align === "right" ? " numeric" : column.align === "center" ? " egrid-td--center" : "";
  const extra = typeof column.cellClassName === "function" ? column.cellClassName(row) : column.cellClassName;
  return `${base}${extra ? ` ${extra}` : ""}`;
}

/** Generic Excel-style grid: resizable columns, sessionStorage widths, multi-field filters, pagination. */
export function DataGrid<T>({ columns, rows, getRowKey, storageKey, resetKey, rowClassName, emptyText = "ไม่พบรายการ", pageSize: initialSize, filters, unit = "รายการ", onRowClick }: {
  columns: DataColumn<T>[];
  rows: T[];
  getRowKey: (row: T) => string;
  storageKey: string;
  resetKey?: string;
  rowClassName?: (row: T) => string | undefined;
  emptyText?: string;
  pageSize?: number;
  filters?: GridFilter<T>[];
  unit?: string;
  onRowClick?: (row: T) => void;
}) {
  const { colWidths, totalWidth, scrollRef, startResize } = useResizableColumns(columns, storageKey);
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const activeFilters = filters ?? [];
  const setValue = (key: string, value: string) => setFilterValues((prev) => ({ ...prev, [key]: value }));
  const toNumber = (raw: string | undefined) => { if (!raw || raw.trim() === "") return null; const value = Number(raw); return Number.isNaN(value) ? null : value; };

  const visibleRows = rows.filter((row) => activeFilters.every((filter) => {
    if (filter.kind === "range") {
      const min = toNumber(filterValues[`${filter.key}:min`]); const max = toNumber(filterValues[`${filter.key}:max`]);
      if (min === null && max === null) return true;
      return filter.predicate(row, min, max);
    }
    const value = (filterValues[filter.key] ?? "").trim();
    if (value === "") return true;
    return filter.predicate(row, value);
  }));
  const anyActive = Object.values(filterValues).some((value) => value && value.trim() !== "");

  const { pageSize, setPageSize, page, setPage, size, totalPages } = usePagination(visibleRows.length, `${resetKey ?? ""}|${JSON.stringify(filterValues)}`, initialSize);
  const pageRows = visibleRows.slice((page - 1) * size, page * size);
  const start = visibleRows.length === 0 ? 0 : (page - 1) * size + 1;
  const end = Math.min(page * size, visibleRows.length);

  return (
    <div className="entry-grid-wrap">
      {activeFilters.length > 0 && (
        <div className="entry-toolbar">
          {activeFilters.map((filter) => (
            <div className="entry-filter" key={filter.key}>
              <label htmlFor={`${storageKey}-${filter.key}`}>{filter.label}</label>
              {filter.kind === "select" ? (
                <select id={`${storageKey}-${filter.key}`} className="select" value={filterValues[filter.key] ?? ""} onChange={(event) => setValue(filter.key, event.target.value)}>
                  <option value="">ทั้งหมด</option>
                  {filter.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              ) : filter.kind === "range" ? (
                <div className="entry-filter-range">
                  <input id={`${storageKey}-${filter.key}`} type="number" inputMode="numeric" placeholder={filter.placeholder?.[0] ?? "ต่ำสุด"} value={filterValues[`${filter.key}:min`] ?? ""} onChange={(event) => setValue(`${filter.key}:min`, event.target.value)} />
                  <span>–</span>
                  <input type="number" inputMode="numeric" placeholder={filter.placeholder?.[1] ?? "สูงสุด"} value={filterValues[`${filter.key}:max`] ?? ""} onChange={(event) => setValue(`${filter.key}:max`, event.target.value)} />
                </div>
              ) : (
                <input id={`${storageKey}-${filter.key}`} value={filterValues[filter.key] ?? ""} placeholder={filter.placeholder} onChange={(event) => setValue(filter.key, event.target.value)} />
              )}
            </div>
          ))}
          <div className="entry-toolbar__actions">
            <Button variant="secondary" size="sm" disabled={!anyActive} onClick={() => setFilterValues({})}><X size={14} />ล้างตัวกรอง</Button>
          </div>
        </div>
      )}
      <div className="entry-grid-scroll" ref={scrollRef}>
        <table className="entry-grid" style={{ width: totalWidth }}>
          <GridHead columns={columns} colWidths={colWidths} startResize={startResize} />
          <tbody>
            {pageRows.length === 0
              ? <tr><td className="egrid-empty" colSpan={columns.length}><strong>{emptyText}</strong></td></tr>
              : pageRows.map((row) => (
                <tr key={getRowKey(row)} className={`egrid-row${onRowClick ? " egrid-row--clickable" : ""}${rowClassName?.(row) ? ` ${rowClassName(row)}` : ""}`} onClick={onRowClick ? () => onRowClick(row) : undefined}>
                  {columns.map((column) => <td key={column.key} className={`egrid-td${cellClass(column, row)}`}>{column.render(row)}</td>)}
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <GridPagination idBase={storageKey} pageSize={pageSize} setPageSize={setPageSize} page={page} totalPages={totalPages} setPage={setPage} total={visibleRows.length} grandTotal={rows.length} start={start} end={end} unit={unit} />
    </div>
  );
}
