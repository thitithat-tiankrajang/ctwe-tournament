"use client";

import { Search, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

/** Compact search bar shared by every table so staff and public can filter rows anytime. */
export function TableSearch({ value, onChange, placeholder = "ค้นหา…", count, total, unit = "รายการ", id }: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  count: number;
  total: number;
  unit?: string;
  id?: string;
}) {
  return (
    <div className="table-search">
      <div className="table-search__field">
        <Search size={15} aria-hidden />
        <input
          id={id}
          className="table-search__input"
          type="search"
          value={value}
          placeholder={placeholder}
          aria-label={placeholder}
          autoComplete="off"
          onChange={(event) => onChange(event.target.value)}
        />
        {value && <button type="button" className="table-search__clear" aria-label="ล้างคำค้น" onClick={() => onChange("")}><X size={14} /></button>}
      </div>
      <span className="table-search__count">{count.toLocaleString("th-TH")}<small> / {total.toLocaleString("th-TH")} {unit}</small></span>
    </div>
  );
}

/** Client-side text filtering with the query state colocated, used by every searchable table. */
export function useTableSearch<T>(items: T[], toText: (item: T) => string) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("th");
    if (!needle) return items;
    return items.filter((item) => toText(item).toLocaleLowerCase("th").includes(needle));
  }, [items, query, toText]);
  return { query, setQuery, filtered };
}

interface Column {
  label: ReactNode;
  className?: string;
}

/** Read-only table that gains a search box, live count, and an empty state with one wiring point. */
export function SearchableTable<T>({
  items,
  toText,
  columns,
  renderRow,
  placeholder,
  unit = "รายการ",
  emptyTitle = "ไม่พบรายการที่ค้นหา",
  emptyHint = "ลองปรับคำค้นหาหรือกดล้างเพื่อดูทั้งหมด",
  wrapClassName = "",
  tableClassName = "",
}: {
  items: T[];
  toText: (item: T) => string;
  columns: Column[];
  /** Must return a keyed <tr>. */
  renderRow: (item: T) => ReactNode;
  placeholder?: string;
  unit?: string;
  emptyTitle?: string;
  emptyHint?: string;
  wrapClassName?: string;
  tableClassName?: string;
}) {
  const { query, setQuery, filtered } = useTableSearch(items, toText);
  return (
    <>
      <TableSearch value={query} onChange={setQuery} placeholder={placeholder ?? "ค้นหา…"} count={filtered.length} total={items.length} unit={unit} />
      <div className={`dense-table-wrap ${wrapClassName}`.trim()}>
        <table className={`data-table ${tableClassName}`.trim()}>
          <thead><tr>{columns.map((column, index) => <th key={index} className={column.className}>{column.label}</th>)}</tr></thead>
          <tbody>
            {filtered.length === 0
              ? <tr><td colSpan={columns.length}><div className="table-empty"><strong>{emptyTitle}</strong><span>{emptyHint}</span></div></td></tr>
              : filtered.map(renderRow)}
          </tbody>
        </table>
      </div>
    </>
  );
}
