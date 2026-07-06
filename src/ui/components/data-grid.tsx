"use client";

import { ArrowDown, ArrowUp, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { matchesPlayerCode } from "@/domain/tournament/player-code";
import { Button } from "@/ui/components/button";

export interface GridColumnBase {
  key: string;
  label: ReactNode;
  min: number;
  width: number;
  /** Minimum width kept during automatic screen fitting; manual resizing still uses `min`. */
  fitMin?: number;
  /** Automatically keep the full rendered header/cell content visible at the current responsive font size. */
  fitContent?: boolean;
  align?: "left" | "right" | "center";
  filterKind?: "playerCode";
}

export interface DataColumn<T> extends GridColumnBase {
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

const widthsKey = (key: string) => `ctwe.gridWidths.v2.${key}`;
const headAlignClass = (align?: GridColumnBase["align"]) =>
  align === "right" ? " egrid-th--right" : align === "center" ? " egrid-th--center" : " egrid-th--left";

/** Resizable, screen-fitting, sessionStorage-persisted column widths shared by every grid. */
export function useResizableColumns(columns: readonly { min: number; width: number; fitMin?: number; fitContent?: boolean }[], storageKey: string) {
  const minsRef = useRef(columns.map((column) => column.min)); minsRef.current = columns.map((column) => column.min);
  const fitMinsRef = useRef(columns.map((column) => column.fitMin ?? 1)); fitMinsRef.current = columns.map((column) => column.fitMin ?? 1);
  const fitContentRef = useRef(columns.map((column) => Boolean(column.fitContent))); fitContentRef.current = columns.map((column) => Boolean(column.fitContent));
  const defaultsRef = useRef(columns.map((column) => column.width)); defaultsRef.current = columns.map((column) => column.width);
  const count = columns.length;
  const [widths, setWidths] = useState<number[] | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const resizedRef = useRef(false);
  const resizeRef = useRef<{ index: number; startX: number; startW: number } | null>(null);
  const colWidths = widths ?? defaultsRef.current;

  const startResize = (index: number, clientX: number) => { resizedRef.current = true; resizeRef.current = { index, startX: clientX, startW: colWidths[index] }; };
  const measureContentMins = () => {
    const table = scrollRef.current?.querySelector("table");
    if (!table) return fitMinsRef.current;
    const headerCells = [...table.querySelectorAll<HTMLTableCellElement>("thead th")];
    const bodyRows = [...table.querySelectorAll<HTMLTableRowElement>("tbody tr")];
    return fitMinsRef.current.map((configured, index) => {
      if (!fitContentRef.current[index]) return configured;
      let naturalWidth = 0;
      const measure = (element: HTMLElement, boxElement: HTMLElement) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const contentWidth = range.getBoundingClientRect().width;
        const style = getComputedStyle(boxElement);
        const horizontalSpace = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
        naturalWidth = Math.max(naturalWidth, contentWidth + horizontalSpace);
      };
      const headerContent = headerCells[index]?.querySelector<HTMLElement>(".egrid-th__text");
      if (headerContent && headerCells[index]) measure(headerContent, headerCells[index]);
      for (const row of bodyRows) {
        const cell = row.cells[index];
        if (cell && !cell.classList.contains("egrid-empty")) measure(cell, cell);
      }
      return Math.max(configured, Math.ceil(naturalWidth + 2));
    });
  };
  const fitWidths = (source: number[], available: number, contentMins = fitMinsRef.current) => {
    const target = Math.round(available);
    if (target <= 0 || source.length === 0) return [...source];
    const distribute = (weights: number[], amount: number) => {
      const safeWeights = weights.map((value) => Math.max(1, value));
      const total = safeWeights.reduce((sum, value) => sum + value, 0);
      const exact = safeWeights.map((value) => value * (amount / total));
      const allocated = exact.map((value) => Math.floor(value));
      let remainder = amount - allocated.reduce((sum, value) => sum + value, 0);
      const byLargestFraction = exact
        .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
        .sort((a, b) => b.fraction - a.fraction);
      for (let index = 0; remainder > 0; index += 1, remainder -= 1) {
        allocated[byLargestFraction[index % byLargestFraction.length].index] += 1;
      }
      return allocated;
    };
    const floors = contentMins.map((value) => Math.max(1, Math.round(value)));
    const floorTotal = floors.reduce((sum, value) => sum + value, 0);
    if (floorTotal >= target) return distribute(floors, target);
    const extraWeights = source.map((value, index) => Math.max(1, value - floors[index]));
    const extra = distribute(extraWeights, target - floorTotal);
    const fitted = floors.map((floor, index) => floor + extra[index]);
    return fitted;
  };

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const state = resizeRef.current; if (!state) return;
      const delta = event.clientX - state.startX;
      setWidths((prev) => { const next = [...(prev ?? defaultsRef.current)]; next[state.index] = Math.max(minsRef.current[state.index], state.startW + delta); return next; });
    };
    const onUp = () => { resizeRef.current = null; document.body.classList.remove("col-resizing"); };
    window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp); window.addEventListener("pointercancel", onUp);
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); window.removeEventListener("pointercancel", onUp); };
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
    const available = scrollRef.current?.clientWidth ?? 0;
    if (restored) {
      resizedRef.current = true;
      setWidths(restored);
      return;
    }
    resizedRef.current = false;
    setWidths(available > 0 ? fitWidths(defaultsRef.current, available, measureContentMins()) : [...defaultsRef.current]);
  }, [storageKey, count]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !("ResizeObserver" in window)) return;
    const observer = new ResizeObserver(() => {
      const available = element.clientWidth;
      if (available <= 0 || resizedRef.current) return;
      setWidths(fitWidths(defaultsRef.current, available, measureContentMins()));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [storageKey, count]);

  // Persist only widths the user dragged — never the auto-fit defaults.
  useEffect(() => {
    if (!widths || !resizedRef.current) return;
    try { sessionStorage.setItem(widthsKey(storageKey), JSON.stringify(widths)); } catch { /* ignore */ }
  }, [widths, storageKey]);

  const totalWidth = colWidths.reduce((sum, value) => sum + value, 0);
  return { colWidths, totalWidth, scrollRef, startResize };
}

export interface ExcelHeadControls {
  sortable: (key: string) => boolean;
  filterable: (key: string) => boolean;
  sort: { key: string; dir: SortDir } | null;
  filters: Record<string, string[]>;
  textFilters: Record<string, string>;
  editingKey: string | null;
  uniqueValues: Record<string, string[]>;
  openKey: string | null;
  openAnchor: { top: number; left: number };
  onSetSort: (key: string, direction: SortDir | null) => void;
  onStartTextFilter: (key: string) => void;
  onTextFilter: (key: string, value: string) => void;
  onStopTextFilter: () => void;
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
          const resizer = <span className="egrid-resizer" role="separator" aria-orientation="vertical" aria-label="ปรับความกว้างคอลัมน์" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); document.body.classList.add("col-resizing"); startResize(index, event.clientX); }} />;
          if (excel) {
            const sortable = excel.sortable(column.key);
            const filterable = excel.filterable(column.key);
            const sorted = excel.sort?.key === column.key ? excel.sort.dir : null;
            const popupable = sortable || filterable;
            const filterActive = (excel.filters[column.key]?.length ?? 0) > 0
              || Boolean(excel.textFilters[column.key]);
            return (
              <th key={column.key} className={`egrid-th egrid-col-${column.key}${headAlignClass(column.align)}${filterActive ? " egrid-th--filtered" : ""}${sorted ? " egrid-th--sorted" : ""}${excel.openKey === column.key ? " egrid-th--popup" : ""}`}>
                <div className="egrid-th-bar">
                  {excel.editingKey === column.key ? (
                    <input
                      autoFocus
                      className="egrid-th__inline-filter"
                      aria-label={`ค้นหา ${labelText(column.label)}`}
                      placeholder={labelText(column.label)}
                      value={excel.textFilters[column.key] ?? ""}
                      onChange={(event) => excel.onTextFilter(column.key, event.target.value)}
                      onBlur={excel.onStopTextFilter}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") excel.onStopTextFilter();
                        if (event.key === "Escape") {
                          excel.onTextFilter(column.key, "");
                          excel.onStopTextFilter();
                        }
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className={`egrid-th__label egrid-th__label--btn${sortable ? "" : " egrid-th__label--plain"}`}
                      disabled={!popupable}
                      title={popupable ? "คลิกเพื่อเปิดเมนู · คลิกช่องเดิมอีกครั้งเพื่อพิมพ์ค้นหา" : undefined}
                      onMouseDown={(event) => {
                        event.stopPropagation();
                        if (excel.openKey === column.key) {
                          event.preventDefault();
                          excel.onClose();
                          excel.onStartTextFilter(column.key);
                        }
                      }}
                      onClick={(event) => {
                        if (!popupable) return;
                        event.stopPropagation();
                        if (excel.openKey === column.key) return;
                        const anchor = event.currentTarget.closest("th")?.getBoundingClientRect()
                          ?? event.currentTarget.getBoundingClientRect();
                        excel.onOpenFilter(column.key, anchor);
                      }}
                    >
                      <span className="egrid-th__text">{column.label}</span>
                    </button>
                  )}
                </div>
                {excel.openKey === column.key && popupable && (
                  <ColumnFilterDropdown
                    label={labelText(column.label) || column.key}
                    values={excel.uniqueValues[column.key] ?? []}
                    selected={excel.filters[column.key]}
                    anchor={excel.openAnchor}
                    filterable={filterable}
                    sortable={sortable}
                    sortDirection={sorted}
                    filterKind={column.filterKind}
                    onSort={(direction) => excel.onSetSort(column.key, direction)}
                    onApply={(values) => excel.onApply(column.key, values)}
                    onClear={() => excel.onClear(column.key)}
                    onClose={excel.onClose}
                  />
                )}
                {resizer}
              </th>
            );
          }
          return (
            <th key={column.key} className={`egrid-th egrid-col-${column.key}${headAlignClass(column.align)}`}>
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
  const [textFilters, setTextFilters] = useState<Record<string, string>>({});
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [openAnchor, setOpenAnchor] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const setColumnSort = (key: string, direction: SortDir | null) =>
    setSort(direction ? { key, dir: direction } : null);
  const openFilter = (key: string, rect: DOMRect) => { setOpenAnchor({ top: rect.bottom + 4, left: rect.left }); setOpenKey((current) => current === key ? null : key); };
  const applyFilter = (key: string, values: string[], total: number) => setFilters((prev) => { const next = { ...prev }; if (values.length === 0 || values.length >= total) delete next[key]; else next[key] = values; return next; });
  const clearFilter = (key: string) => setFilters((prev) => { const next = { ...prev }; delete next[key]; return next; });
  const setTextFilter = (key: string, value: string) => setTextFilters((prev) => {
    const next = { ...prev };
    if (value) next[key] = value; else delete next[key];
    return next;
  });
  const startTextFilter = (key: string) => {
    setSort((current) => current?.key === key ? null : current);
    setEditingKey(key);
  };
  const clearAll = () => { setSort(null); setFilters({}); setTextFilters({}); setEditingKey(null); };
  const activeFilterKeys = Object.keys(filters).filter((key) => filters[key]?.length);
  const activeTextKeys = Object.keys(textFilters).filter((key) => textFilters[key]?.trim());
  return {
    sort, filters, textFilters, openKey, openAnchor, editingKey,
    setOpenKey, setEditingKey, setTextFilter, startTextFilter, setColumnSort, openFilter, applyFilter, clearFilter, clearAll,
    activeFilterKeys, activeTextKeys,
    active: sort !== null || activeFilterKeys.length > 0 || activeTextKeys.length > 0,
  };
}

/** Apply column filters + sort to rows using per-column string/number accessors. */
export function applyColumnControls<T>(
  rows: T[],
  accessors: Record<string, (row: T) => string | number>,
  filters: Record<string, string[]>,
  sort: { key: string; dir: SortDir } | null,
  textFilters: Record<string, string> = {},
  playerCodeKeys: readonly string[] = [],
): T[] {
  const activeKeys = Object.keys(filters).filter((key) => filters[key]?.length && accessors[key]);
  const textKeys = Object.keys(textFilters).filter((key) => textFilters[key]?.trim() && accessors[key]);
  let result = activeKeys.length === 0 && textKeys.length === 0 ? rows : rows.filter((row) =>
    activeKeys.every((key) => filters[key].includes(String(accessors[key](row))))
    && textKeys.every((key) => playerCodeKeys.includes(key)
      ? matchesPlayerCode(accessors[key](row), textFilters[key])
      : String(accessors[key](row))
        .toLocaleLowerCase("th")
        .includes(textFilters[key].trim().toLocaleLowerCase("th"))));
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

/** Excel-style column popover: sorting plus checkbox filters. */
export function ColumnFilterDropdown({ label, values, selected, anchor, filterable, sortable, sortDirection, filterKind, onSort, onApply, onClear, onClose }: {
  label: string;
  values: string[];
  selected: string[] | undefined;
  anchor: { top: number; left: number };
  filterable: boolean;
  sortable: boolean;
  sortDirection: SortDir | null;
  filterKind?: "playerCode";
  onSort: (direction: SortDir | null) => void;
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
    const onViewportMove = (event?: Event) => {
      // Opening the software keyboard scrolls/resizes mobile viewports. Keep the popup open while
      // the user is typing inside it; ordinary page/table movement still dismisses it.
      if (ref.current?.contains(document.activeElement)
        || (event?.target instanceof Node && ref.current?.contains(event.target))) return;
      onClose();
    };
    const initialWidth = window.innerWidth;
    const onResize = () => {
      if (window.innerWidth !== initialWidth) onViewportMove();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onViewportMove, true);
    window.addEventListener("resize", onResize);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); window.removeEventListener("scroll", onViewportMove, true); window.removeEventListener("resize", onResize); };
  }, [onClose]);

  const visible = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("th");
    return term ? values.filter((value) => filterKind === "playerCode"
      ? matchesPlayerCode(value, search)
      : value.toLocaleLowerCase("th").includes(term)) : values;
  }, [filterKind, values, search]);
  const allVisibleChecked = visible.length > 0 && visible.every((value) => draft.has(value));
  const toggle = (value: string) => setDraft((prev) => { const next = new Set(prev); if (next.has(value)) next.delete(value); else next.add(value); return next; });
  const toggleAll = () => setDraft((prev) => { const next = new Set(prev); if (allVisibleChecked) visible.forEach((value) => next.delete(value)); else visible.forEach((value) => next.add(value)); return next; });

  const left = Math.max(8, Math.min(anchor.left, (typeof window !== "undefined" ? window.innerWidth : 9999) - 296));
  return createPortal(
    <div className="egrid-filterpop" ref={ref} style={{ top: anchor.top, left }} onMouseDown={(event) => event.stopPropagation()}>
      <strong className="egrid-filterpop__title">{label}</strong>
      {sortable && (
        <div className="egrid-filterpop__sort" role="group" aria-label={`เรียง ${label}`}>
          <button type="button" className={sortDirection === "asc" ? "egrid-sort-option egrid-sort-option--on" : "egrid-sort-option"} onClick={() => { onSort("asc"); onClose(); }}><ArrowUp size={14} />เรียงจากน้อยไปมาก</button>
          <button type="button" className={sortDirection === "desc" ? "egrid-sort-option egrid-sort-option--on" : "egrid-sort-option"} onClick={() => { onSort("desc"); onClose(); }}><ArrowDown size={14} />เรียงจากมากไปน้อย</button>
          {sortDirection && <button type="button" className="egrid-sort-option" onClick={() => { onSort(null); onClose(); }}><X size={14} />ยกเลิกการเรียง</button>}
        </div>
      )}
      {filterable && (
        <>
          <div className="egrid-filterpop__search"><Search size={13} /><input value={search} placeholder={`ค้นหาใน ${label}`} onChange={(event) => setSearch(event.target.value)} /></div>
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
        </>
      )}
    </div>,
    document.body,
  );
}

/** Generic Excel-style grid: resizable columns, sessionStorage widths, multi-field filters, pagination. */
export function DataGrid<T>({ columns, rows, getRowKey, getRowElementId, storageKey, filterResetKey, rowClassName, tableClassName = "", emptyText = "ไม่พบรายการ", inlineClear = true, onRowClick, onFilterActiveChange }: {
  columns: DataColumn<T>[];
  rows: T[];
  getRowKey: (row: T) => string;
  getRowElementId?: (row: T) => string | undefined;
  storageKey: string;
  resetKey?: string;
  filterResetKey?: number;
  rowClassName?: (row: T) => string | undefined;
  tableClassName?: string;
  emptyText?: string;
  pageSize?: number;
  unit?: string;
  inlineClear?: boolean;
  onRowClick?: (row: T) => void;
  onFilterActiveChange?: (active: boolean) => void;
}) {
  const { colWidths, totalWidth, scrollRef, startResize } = useResizableColumns(columns, storageKey);
  const [sort, setSort] = useState<{ key: string; dir: SortDir } | null>(null);
  const [filters, setFilters] = useState<Record<string, string[]>>({});
  const [textFilters, setTextFilters] = useState<Record<string, string>>({});
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [openAnchor, setOpenAnchor] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  useEffect(() => {
    if (filterResetKey === undefined) return;
    setSort(null);
    setFilters({});
    setTextFilters({});
    setOpenKey(null);
    setEditingKey(null);
  }, [filterResetKey]);

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
    const textKeys = Object.keys(textFilters).filter((key) => textFilters[key]?.trim());
    let result = activeKeys.length === 0 && textKeys.length === 0 ? rows : rows.filter((row) =>
      activeKeys.every((key) => {
        const column = colByKey.get(key);
        return !column?.value || filters[key].includes(String(column.value(row)));
      }) && textKeys.every((key) => {
        const column = colByKey.get(key);
        if (!column?.value) return true;
        return column.filterKind === "playerCode"
          ? matchesPlayerCode(column.value(row), textFilters[key])
          : String(column.value(row)).toLocaleLowerCase("th")
            .includes(textFilters[key].trim().toLocaleLowerCase("th"));
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
  }, [rows, filters, textFilters, sort, colByKey]);

  const activeFilterKeys = Object.keys(filters).filter((key) => filters[key]?.length);
  const activeTextKeys = Object.keys(textFilters).filter((key) => textFilters[key]?.trim());
  const anyActive = sort !== null || activeFilterKeys.length > 0 || activeTextKeys.length > 0;
  const filterActiveCallback = useRef(onFilterActiveChange);
  filterActiveCallback.current = onFilterActiveChange;
  useEffect(() => { filterActiveCallback.current?.(anyActive); }, [anyActive]);

  const applyFilter = (key: string, values: string[]) => setFilters((prev) => {
    const next = { ...prev };
    if (values.length === 0 || values.length >= (uniqueValues[key]?.length ?? 0)) delete next[key]; else next[key] = values;
    return next;
  });

  return (
    <div className="entry-grid-wrap">
      <div className={`entry-grid-meta-shell${anyActive ? " entry-grid-meta-shell--open" : ""}`} aria-hidden={!anyActive}>
        <div className="entry-grid-meta">
          <span className="entry-grid-meta__tags">
            {sort && <span className="grid-chip">เรียง: {labelText(colByKey.get(sort.key)?.label)} {sort.dir === "asc" ? "↑" : "↓"}</span>}
            {activeFilterKeys.map((key) => <span key={key} className="grid-chip">กรอง: {labelText(colByKey.get(key)?.label)} ({filters[key].length})</span>)}
            {activeTextKeys.map((key) => <span key={`text-${key}`} className="grid-chip">{labelText(colByKey.get(key)?.label)}: {textFilters[key]}</span>)}
          </span>
          {inlineClear && <Button className="entry-grid-meta__clear" variant="secondary" size="sm" tabIndex={anyActive ? 0 : -1} onClick={() => { setSort(null); setFilters({}); setTextFilters({}); setEditingKey(null); }}><X size={14} />ล้างทั้งหมด</Button>}
        </div>
      </div>
      <div className="entry-grid-scroll" ref={scrollRef}>
        <table className={`entry-grid${tableClassName ? ` ${tableClassName}` : ""}`} style={{ width: totalWidth }}>
          <colgroup>{columns.map((column, index) => <col key={column.key} style={{ width: colWidths[index] }} />)}</colgroup>
          <thead>
            <tr>{columns.map((column, index) => {
              const sortable = Boolean(column.value) && (column.sortable ?? true);
              const filterable = Boolean(column.value) && (column.filterable ?? true);
              const textFilterable = Boolean(column.value);
              const popupable = sortable || filterable;
              const sorted = sort?.key === column.key ? sort.dir : null;
              const filterActive = (filters[column.key]?.length ?? 0) > 0 || Boolean(textFilters[column.key]);
              return (
                <th key={column.key} className={`egrid-th egrid-col-${column.key}${headAlignClass(column.align)}${filterActive ? " egrid-th--filtered" : ""}${sorted ? " egrid-th--sorted" : ""}${openKey === column.key ? " egrid-th--popup" : ""}`}>
                  <div className="egrid-th-bar">
                    {editingKey === column.key ? (
                      <input
                        autoFocus
                        className="egrid-th__inline-filter"
                        aria-label={`ค้นหา ${labelText(column.label)}`}
                        placeholder={labelText(column.label)}
                        value={textFilters[column.key] ?? ""}
                        onChange={(event) => setTextFilters((prev) => ({ ...prev, [column.key]: event.target.value }))}
                        onBlur={() => setEditingKey(null)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") setEditingKey(null);
                          if (event.key === "Escape") {
                            setTextFilters((prev) => { const next = { ...prev }; delete next[column.key]; return next; });
                            setEditingKey(null);
                          }
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className={`egrid-th__label egrid-th__label--btn${sortable ? "" : " egrid-th__label--plain"}`}
                        disabled={!popupable}
                        title={popupable ? "คลิกเพื่อเปิดเมนู · คลิกช่องเดิมอีกครั้งเพื่อพิมพ์ค้นหา" : undefined}
                        onMouseDown={(event) => {
                          event.stopPropagation();
                          if (openKey === column.key) {
                            event.preventDefault();
                            setOpenKey(null);
                            if (textFilterable) setEditingKey(column.key);
                          }
                        }}
                        onClick={(event) => {
                          if (!popupable) return;
                          event.stopPropagation();
                          if (openKey === column.key) return;
                          const anchor = event.currentTarget.closest("th")?.getBoundingClientRect()
                            ?? event.currentTarget.getBoundingClientRect();
                          setOpenAnchor({ top: anchor.bottom + 4, left: anchor.left });
                          setOpenKey(column.key);
                        }}
                      >
                        <span className="egrid-th__text">{column.label}</span>
                      </button>
                    )}
                  </div>
                  {openKey === column.key && popupable && (
                    <ColumnFilterDropdown
                      label={labelText(column.label) || column.key}
                      values={uniqueValues[column.key] ?? []}
                      selected={filters[column.key]}
                      anchor={openAnchor}
                      filterable={filterable}
                      sortable={sortable}
                      sortDirection={sorted}
                      filterKind={column.filterKind}
                      onSort={(direction) => setSort(direction ? { key: column.key, dir: direction } : null)}
                      onApply={(values) => { applyFilter(column.key, values); setOpenKey(null); }}
                      onClear={() => { setFilters((prev) => { const next = { ...prev }; delete next[column.key]; return next; }); setOpenKey(null); }}
                      onClose={() => setOpenKey(null)}
                    />
                  )}
                  <span className="egrid-resizer" role="separator" aria-orientation="vertical" aria-label="ปรับความกว้างคอลัมน์" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); document.body.classList.add("col-resizing"); startResize(index, event.clientX); }} />
                </th>
              );
            })}</tr>
          </thead>
          <tbody>
            {visibleRows.length === 0
              ? <tr><td className="egrid-empty" colSpan={columns.length}><strong>{emptyText}</strong></td></tr>
              : visibleRows.map((row) => {
                const extraClass = rowClassName?.(row);
                return (
                  <tr id={getRowElementId?.(row)} key={getRowKey(row)} className={`egrid-row${onRowClick ? " egrid-row--clickable" : ""}${extraClass ? ` ${extraClass}` : ""}`} onClick={onRowClick ? () => onRowClick(row) : undefined}>
                    {columns.map((column) => <td key={column.key} className={`egrid-td${cellClass(column, row)}`}>{column.render(row)}</td>)}
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
