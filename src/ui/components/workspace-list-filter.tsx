"use client";

import { ChevronDown, ChevronRight, Filter, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from "react";

export type WorkspaceFilterField = "pair" | "seat" | "code" | "name" | "school" | "status";
export type WorkspaceFilters = Partial<Record<WorkspaceFilterField, string>>;
export const workspaceFilterLabel = {
  pair: "เลขคู่", seat: "ที่นั่ง", code: "รหัส", name: "ชื่อ–นามสกุล", school: "โรงเรียน/สถาบัน", status: "สถานะ",
};

export function useWorkspaceListFilter(initial: WorkspaceFilters = {}) {
  const [state, setState] = useState<WorkspaceFilters>(initial);
  const [popup, setPopup] = useState<{ field: WorkspaceFilterField | "all"; anchor: HTMLButtonElement } | null>(null);
  const controlId = useId();
  const count = Object.values(state).filter(Boolean).length;
  const open = (event: MouseEvent<HTMLButtonElement>, field: WorkspaceFilterField | "all") => {
    setPopup({ field, anchor: event.currentTarget });
  };

  return {
    state, count, popup, setPopup, controlId, clear: () => { setState({}); setPopup(null); }, setState,
    button: <button type="button" className="btn btn--secondary" aria-haspopup="dialog" aria-expanded={popup?.field === "all"} aria-controls={popup ? controlId : undefined} onClick={(event) => open(event, "all")}>
      <Filter className="i" size={15} />ตัวกรอง{count > 0 && ` (${count})`}
    </button>,
    heading: (field: WorkspaceFilterField, label = workspaceFilterLabel[field]) => <button type="button" className={`list-filter-th${state[field] ? " on" : ""}`}
      aria-label={`กรอง ${label}`} aria-haspopup="dialog" aria-expanded={popup?.field === field} aria-controls={popup ? controlId : undefined}
      onClick={(event) => open(event, field)}>{label}{state[field] ? <Filter className="i" size={12} /> : <ChevronDown className="i" size={12} />}</button>,
  };
}

export function WorkspaceListFilter({ filter, fields, statuses, emptyStatus }: {
  filter: ReturnType<typeof useWorkspaceListFilter>;
  fields: WorkspaceFilterField[];
  statuses: readonly (readonly [string, string])[];
  emptyStatus: string;
}) {
  const info = filter.popup;
  if (!info) return null;

  return <WorkspaceFilterPopup key={info.field} field={info.field} anchor={info.anchor} initial={filter.state} fields={fields}
    statuses={statuses} emptyStatus={emptyStatus} controlId={filter.controlId}
    onDrill={(field) => filter.setPopup({ ...info, field })}
    onClose={() => { filter.setPopup(null); info.anchor.focus({ preventScroll:true }); }}
    onApply={(state) => { filter.setState(state); filter.setPopup(null); info.anchor.focus({ preventScroll:true }); }}
  />;
}

function WorkspaceFilterPopup({ field, anchor, initial, statuses, emptyStatus, fields, controlId, onDrill, onClose, onApply }: {
  field: WorkspaceFilterField | "all";
  anchor: HTMLButtonElement;
  initial: WorkspaceFilters;
  fields: WorkspaceFilterField[];
  statuses: readonly (readonly [string, string])[];
  emptyStatus: string;
  controlId: string;
  onDrill: (field: WorkspaceFilterField) => void;
  onClose: () => void;
  onApply: (state: WorkspaceFilters) => void;
}) {
  const [value, setValue] = useState(() => field === "all" ? initial.status ?? "" : initial[field] ?? "");
  const [rect, setRect] = useState(() => anchor.getBoundingClientRect());
  const root = useRef<HTMLFormElement>(null);
  const byStatus = field === "all" || field === "status";
  const title = field === "all" ? "ตัวกรอง" : workspaceFilterLabel[field];
  const closer = useRef(onClose);
  closer.current = onClose;
  useEffect(() => {
    root.current?.querySelector<HTMLElement>("input, button")?.focus({ preventScroll:true });
    const watch = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target) && !anchor.contains(event.target)) closer.current();
    };
    const measure = () => setRect(anchor.getBoundingClientRect());
    document.addEventListener("pointerdown", watch);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      document.removeEventListener("pointerdown", watch);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [anchor]);
  const width = Math.min(330, window.innerWidth - 20);
  const up = window.innerHeight - rect.bottom < 270 && rect.top > 270;
  const style = {
    left: Math.max(10, Math.min(rect.right - width, window.innerWidth - width - 10)),
    width, ...(up ? { bottom: window.innerHeight - rect.top + 5 } : { top: rect.bottom + 5 }),
  };
  return <form ref={root} className="pop dir-filter-ui workspace-filter-pop" id={controlId} data-side={up ? "up" : "down"} role="dialog" aria-label={title}
    style={style} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } }}
    onSubmit={(event) => { event.preventDefault(); onApply({ ...initial, [byStatus ? "status" : field]: value.trim() }); }}>
    <div className="dir-filter-head"><span><Filter className="i" size={16} /><h3>{title}</h3></span>
      <button type="button" className="btn btn--ghost" aria-label="ปิดตัวกรอง" onClick={onClose}><X className="i" size={16} /></button></div>
    {byStatus ? <fieldset className="dir-filter-status"><legend>สถานะ</legend>
      {[["", emptyStatus], ...statuses].map(([key, label]) => <label className="dir-filter-option" key={key}>
        <input type="radio" name={`${controlId}-status`} checked={value === key} onChange={() => setValue(key)} />{label}</label>)}
    </fieldset> : <input className="input" value={value} onChange={(event) => setValue(event.target.value)}
      inputMode={field === "pair" || field === "seat" ? "numeric" : "text"} aria-label={title} placeholder={`ค้นหา ${title}`} />}
    {field === "all" && <div className="dir-filter-keys">{fields.map((key) => <button type="button" key={key} onClick={() => onDrill(key)}>
      <span>{workspaceFilterLabel[key]}</span>{initial[key] ? <small>{initial[key]}</small> : <ChevronRight className="i" size={14} />}</button>)}</div>}
    <div className="dir-filter-footer">
      <button type="button" className="btn btn--secondary" onClick={() => onApply(field === "all" ? {} : { ...initial, [field]: "" })}>
        {field === "all" ? "ล้างทั้งหมด" : "ล้างตัวกรอง"}</button>
      <button type="submit" className="btn btn--primary">ใช้ตัวกรอง</button>
    </div>
  </form>;
}

export function WorkspaceListToolbar({ status, actions }: { status: ReactNode; actions: ReactNode }) {
  return <div className="list-filter-bar"><div className="list-status" role="status">{status}</div><div className="list-actions">{actions}</div></div>;
}
