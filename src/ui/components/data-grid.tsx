"use client";

import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Filter, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
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
  /** Plain text/number accessor that powers Excel sort + filter for this column. */
  value?: (row: T) => string | number;
  /** Defaults to true when `value` is set. */
  sortable?: boolean;
  /** Defaults to true when `value` is set (e.g. set false for continuous/unique columns). */
  filterable?: boolean;
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

export interface ExcelHeadControls {
  sortable: (key: string) => boolean;
  filterable: (key: string) => boolean;
  sort: { key: string; dir: SortDir } | null;
  filters: Record<string, string[]>;
  uniqueValues: Record<string, string[]>;
  openKey: string | null;
  openAnchor: { top: number; left: number };
  onToggleSort: (key: string) => void;
  onOpenFilter: (key: string, rect: DOMRect) => void;
  onApply: (key: string, values: string[]) => void;
  onClear: (key: string) => void;
  onClose: () => void;
}

export function GridHead({ columns, colWidths, startResize, columnFilters, excel }: { columns: GridColumnBase[]; colWidths: number[]; startResize: (index: number, clientX: number) => void; columnFilters?: Partial<Record<string, ReactNode>>; excel?: ExcelHeadControls }) {
  return (
    <>
      <colgroup>{columns.map((column, index) => <col key={column.key} style={{ width: colWidths[index] }} />)}</colgroup>
      <thead>
        <tr>{columns.map((column, index) => {
          const resizer = <span className="egrid-resizer" role="separator" aria-orientation="vertical" aria-label="ปรับความกว้างคอลัมน์" onMouseDown={(event) => { event.preventDefault(); document.body.classList.add("col-resizing"); startResize(index, event.clientX); }} />;
          if (excel) {
            const sortable = excel.sortable(column.key);
            const filterable = excel.filterable(column.key);
            const sorted = excel.sort?.key === column.key ? excel.sort.dir : null;
            const filterActive = (excel.filters[column.key]?.length ?? 0) > 0;
            return (
              <th key={column.key} className={`egrid-th egrid-col-${column.key}`}>
                <div className="egrid-th-bar">
                  <button type="button" className={`egrid-th__label egrid-th__label--btn${sortable ? "" : " egrid-th__label--plain"}`} disabled={!sortable} onClick={() => sortable && excel.onToggleSort(column.key)}>
                    <span className="egrid-th__text">{column.label}</span>
                    {sorted === "asc" ? <ArrowUp size={12} /> : sorted === "desc" ? <ArrowDown size={12} /> : sortable ? <ArrowUpDown size={11} className="egrid-th__sorticon" /> : null}
                  </button>
                  {filterable && <button type="button" className={`egrid-th__filterbtn${filterActive ? " egrid-th__filterbtn--on" : ""}`} aria-label={`กรอง ${labelText(column.label)}`} aria-expanded={excel.openKey === column.key} onClick={(event) => excel.onOpenFilter(column.key, event.currentTarget.getBoundingClientRect())}><Filter size={12} /></button>}
                </div>
                {excel.openKey === column.key && filterable && (
                  <ColumnFilterDropdown label={labelText(column.label) || column.key} values={excel.uniqueValues[column.key] ?? []} selected={excel.filters[column.key]} anchor={excel.openAnchor} onApply={(values) => excel.onApply(column.key, values)} onClear={() => excel.onClear(column.key)} onClose={excel.onClose} />
                )}
                {resizer}
              </th>
            );
          }
          return (
            <th key={column.key} className={`egrid-th egrid-col-${column.key}`}>
              <span className="egrid-th__label">{column.label}</span>
              {columnFilters?.[column.key] ? <span className="egrid-th__filterwrap">{columnFilters[column.key]}</span> : null}
              {resizer}
            </th>
          );
        })}</tr>
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

export type SortDir = "asc" | "desc";

function labelText(label: ReactNode): string {
  return typeof label === "string" ? label : "";
}

/** Shared Excel column controls (sort + multi-select filter) state, reusable across any grid. */
export function useColumnControls() {
  const [sort, setSort] = useState<{ key: string; dir: SortDir } | null>(null);
  const [filters, setFilters] = useState<Record<string, string[]>>({});
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [openAnchor, setOpenAnchor] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const toggleSort = (key: string) => setSort((prev) => prev?.key !== key ? { key, dir: "asc" } : prev.dir === "asc" ? { key, dir: "desc" } : null);
  const openFilter = (key: string, rect: DOMRect) => { setOpenAnchor({ top: rect.bottom + 4, left: rect.left }); setOpenKey((current) => current === key ? null : key); };
  const applyFilter = (key: string, values: string[], total: number) => setFilters((prev) => { const next = { ...prev }; if (values.length === 0 || values.length >= total) delete next[key]; else next[key] = values; return next; });
  const clearFilter = (key: string) => setFilters((prev) => { const next = { ...prev }; delete next[key]; return next; });
  const clearAll = () => { setSort(null); setFilters({}); };
  const activeFilterKeys = Object.keys(filters).filter((key) => filters[key]?.length);
  return { sort, filters, openKey, openAnchor, setOpenKey, toggleSort, openFilter, applyFilter, clearFilter, clearAll, activeFilterKeys, active: sort !== null || activeFilterKeys.length > 0 };
}

/** Apply column filters + sort to rows using per-column string/number accessors. */
export function applyColumnControls<T>(rows: T[], accessors: Record<string, (row: T) => string | number>, filters: Record<string, string[]>, sort: { key: string; dir: SortDir } | null): T[] {
  const activeKeys = Object.keys(filters).filter((key) => filters[key]?.length && accessors[key]);
  let result = activeKeys.length === 0 ? rows : rows.filter((row) => activeKeys.every((key) => filters[key].includes(String(accessors[key](row)))));
  if (sort && accessors[sort.key]) {
    const accessor = accessors[sort.key];
    result = [...result].sort((a, b) => {
      const av = accessor(a); const bv = accessor(b);
      const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv), "th", { numeric: true });
      return sort.dir === "asc" ? cmp : -cmp;
    });
  }
  return result;
}

export function uniqueColumnValues<T>(rows: T[], accessors: Record<string, (row: T) => string | number>, keys: string[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const key of keys) {
    if (!accessors[key]) continue;
    const set = new Set<string>();
    for (const row of rows) set.add(String(accessors[key](row)));
    result[key] = [...set].sort((a, b) => a.localeCompare(b, "th", { numeric: true }));
  }
  return result;
}

/** Excel-style per-column filter popover: search, select-all, multi-select checkboxes, apply, clear. */
export function ColumnFilterDropdown({ label, values, selected, anchor, onApply, onClear, onClose }: {
  label: string;
  values: string[];
  selected: string[] | undefined;
  anchor: { top: number; left: number };
  onApply: (values: string[]) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<Set<string>>(() => new Set(selected ?? values));

  useEffect(() => {
    const onDown = (event: MouseEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) onClose(); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true); // close if the table/page scrolls away from the anchor
    window.addEventListener("resize", onClose);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); window.removeEventListener("scroll", onClose, true); window.removeEventListener("resize", onClose); };
  }, [onClose]);

  const visible = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("th");
    return term ? values.filter((value) => value.toLocaleLowerCase("th").includes(term)) : values;
  }, [values, search]);
  const allVisibleChecked = visible.length > 0 && visible.every((value) => draft.has(value));
  const toggle = (value: string) => setDraft((prev) => { const next = new Set(prev); if (next.has(value)) next.delete(value); else next.add(value); return next; });
  const toggleAll = () => setDraft((prev) => { const next = new Set(prev); if (allVisibleChecked) visible.forEach((value) => next.delete(value)); else visible.forEach((value) => next.add(value)); return next; });

  const left = Math.max(8, Math.min(anchor.left, (typeof window !== "undefined" ? window.innerWidth : 9999) - 296));
  return createPortal(
    <div className="egrid-filterpop" ref={ref} style={{ top: anchor.top, left }} onMouseDown={(event) => event.stopPropagation()}>
      <div className="egrid-filterpop__search"><Search size={13} /><input autoFocus value={search} placeholder={`ค้นหาใน ${label}`} onChange={(event) => setSearch(event.target.value)} /></div>
      <label className="egrid-filterpop__all"><input type="checkbox" checked={allVisibleChecked} onChange={toggleAll} /><span>เลือกทั้งหมด{search ? " (ที่ค้นเจอ)" : ""}</span></label>
      <div className="egrid-filterpop__list">
        {visible.length === 0 ? <p className="egrid-filterpop__empty">ไม่พบค่า</p> : visible.map((value) => (
          <label key={value} className="egrid-filterpop__item"><input type="checkbox" checked={draft.has(value)} onChange={() => toggle(value)} /><span title={value}>{value === "" ? "(ว่าง)" : value}</span></label>
        ))}
      </div>
      <div className="egrid-filterpop__actions">
        <Button size="sm" variant="ghost" onClick={onClear}>ล้างตัวกรอง</Button>
        <Button size="sm" disabled={draft.size === 0} onClick={() => onApply([...draft])}>ใช้ ({draft.size})</Button>
      </div>
    </div>,
    document.body,
  );
}

/** Generic Excel-style grid: resizable columns, sessionStorage widths, multi-field filters, pagination. */
export function DataGrid<T>({ columns, rows, getRowKey, storageKey, resetKey, rowClassName, emptyText = "ไม่พบรายการ", pageSize: initialSize, unit = "รายการ", onRowClick }: {
  columns: DataColumn<T>[];
  rows: T[];
  getRowKey: (row: T) => string;
  storageKey: string;
  resetKey?: string;
  rowClassName?: (row: T) => string | undefined;
  emptyText?: string;
  pageSize?: number;
  unit?: string;
  onRowClick?: (row: T) => void;
}) {
  const { colWidths, totalWidth, scrollRef, startResize } = useResizableColumns(columns, storageKey);
  const [sort, setSort] = useState<{ key: string; dir: SortDir } | null>(null);
  const [filters, setFilters] = useState<Record<string, string[]>>({});
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [openAnchor, setOpenAnchor] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  const colByKey = useMemo(() => new Map(columns.map((column) => [column.key, column])), [columns]);
  // Unique values per filterable column (Excel checkbox list); memoised, so large datasets stay cheap.
  const uniqueValues = useMemo(() => {
    const result: Record<string, string[]> = {};
    for (const column of columns) {
      if (column.value && (column.filterable ?? true)) {
        const set = new Set<string>();
        for (const row of rows) set.add(String(column.value(row)));
        result[column.key] = [...set].sort((a, b) => a.localeCompare(b, "th", { numeric: true }));
      }
    }
    return result;
  }, [columns, rows]);

  const visibleRows = useMemo(() => {
    const activeKeys = Object.keys(filters).filter((key) => filters[key]?.length);
    let result = activeKeys.length === 0 ? rows : rows.filter((row) => activeKeys.every((key) => {
      const column = colByKey.get(key);
      return !column?.value || filters[key].includes(String(column.value(row)));
    }));
    if (sort) {
      const column = colByKey.get(sort.key);
      if (column?.value) {
        const accessor = column.value;
        result = [...result].sort((a, b) => {
          const av = accessor(a); const bv = accessor(b);
          const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv), "th", { numeric: true });
          return sort.dir === "asc" ? cmp : -cmp;
        });
      }
    }
    return result;
  }, [rows, filters, sort, colByKey]);

  const activeFilterKeys = Object.keys(filters).filter((key) => filters[key]?.length);
  const anyActive = sort !== null || activeFilterKeys.length > 0;
  const { pageSize, setPageSize, page, setPage, size, totalPages } = usePagination(visibleRows.length, `${resetKey ?? ""}|${JSON.stringify(filters)}|${sort ? sort.key + sort.dir : ""}`, initialSize);
  const pageRows = visibleRows.slice((page - 1) * size, page * size);
  const start = visibleRows.length === 0 ? 0 : (page - 1) * size + 1;
  const end = Math.min(page * size, visibleRows.length);

  const toggleSort = (key: string) => setSort((prev) => prev?.key !== key ? { key, dir: "asc" } : prev.dir === "asc" ? { key, dir: "desc" } : null);
  const applyFilter = (key: string, values: string[]) => setFilters((prev) => {
    const next = { ...prev };
    if (values.length === 0 || values.length >= (uniqueValues[key]?.length ?? 0)) delete next[key]; else next[key] = values;
    return next;
  });

  return (
    <div className="entry-grid-wrap">
      {anyActive && (
        <div className="entry-grid-meta">
          <span className="entry-grid-meta__tags">
            {sort && <span className="grid-chip">เรียง: {labelText(colByKey.get(sort.key)?.label)} {sort.dir === "asc" ? "↑" : "↓"}</span>}
            {activeFilterKeys.map((key) => <span key={key} className="grid-chip">กรอง: {labelText(colByKey.get(key)?.label)} ({filters[key].length})</span>)}
          </span>
          <Button variant="secondary" size="sm" onClick={() => { setSort(null); setFilters({}); }}><X size={14} />ล้างทั้งหมด</Button>
        </div>
      )}
      <div className="entry-grid-scroll" ref={scrollRef}>
        <table className="entry-grid" style={{ width: totalWidth }}>
          <colgroup>{columns.map((column, index) => <col key={column.key} style={{ width: colWidths[index] }} />)}</colgroup>
          <thead>
            <tr>{columns.map((column, index) => {
              const sortable = Boolean(column.value) && (column.sortable ?? true);
              const filterable = Boolean(column.value) && (column.filterable ?? true);
              const sorted = sort?.key === column.key ? sort.dir : null;
              const filterActive = (filters[column.key]?.length ?? 0) > 0;
              return (
                <th key={column.key} className={`egrid-th egrid-col-${column.key}`}>
                  <div className="egrid-th-bar">
                    <button type="button" className={`egrid-th__label egrid-th__label--btn${sortable ? "" : " egrid-th__label--plain"}`} disabled={!sortable} onClick={() => sortable && toggleSort(column.key)}>
                      <span className="egrid-th__text">{column.label}</span>
                      {sorted === "asc" ? <ArrowUp size={12} /> : sorted === "desc" ? <ArrowDown size={12} /> : sortable ? <ArrowUpDown size={11} className="egrid-th__sorticon" /> : null}
                    </button>
                    {filterable && <button type="button" className={`egrid-th__filterbtn${filterActive ? " egrid-th__filterbtn--on" : ""}`} aria-label={`กรอง ${labelText(column.label)}`} aria-expanded={openKey === column.key} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setOpenAnchor({ top: rect.bottom + 4, left: rect.left }); setOpenKey((current) => current === column.key ? null : column.key); }}><Filter size={12} /></button>}
                  </div>
                  {openKey === column.key && filterable && (
                    <ColumnFilterDropdown
                      label={labelText(column.label) || column.key}
                      values={uniqueValues[column.key] ?? []}
                      selected={filters[column.key]}
                      anchor={openAnchor}
                      onApply={(values) => { applyFilter(column.key, values); setOpenKey(null); }}
                      onClear={() => { setFilters((prev) => { const next = { ...prev }; delete next[column.key]; return next; }); setOpenKey(null); }}
                      onClose={() => setOpenKey(null)}
                    />
                  )}
                  <span className="egrid-resizer" role="separator" aria-orientation="vertical" aria-label="ปรับความกว้างคอลัมน์" onMouseDown={(event) => { event.preventDefault(); document.body.classList.add("col-resizing"); startResize(index, event.clientX); }} />
                </th>
              );
            })}</tr>
          </thead>
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
