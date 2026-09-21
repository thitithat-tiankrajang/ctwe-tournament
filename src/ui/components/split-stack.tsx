"use client";

import { ChevronDown } from "lucide-react";
import { useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

/**
 * Two stacked panels sharing one column, with a bar between them.
 *
 * The director decides how the height is spent: drag the bar to give one panel more of the column,
 * or collapse either panel to its header and hand the whole column to the other. Both open at half
 * each, which is what the work usually wants — a roster to pick from and a pool to clear.
 */

export interface StackPane {
  /** Accessible name of the region, and of its collapse control. */
  label: string;
  title: ReactNode;
  body: ReactNode;
}

const MIN_PCT = 15;
const MAX_PCT = 85;
const clamp = (pct: number) => Math.min(MAX_PCT, Math.max(MIN_PCT, pct));

export function SplitStack({ top, bottom }: { top: StackPane; bottom: StackPane }) {
  const host = useRef<HTMLDivElement>(null);
  const [pct, setPct] = useState(50);
  const [openTop, setOpenTop] = useState(true);
  const [openBottom, setOpenBottom] = useState(true);
  const [dragging, setDragging] = useState(false);

  const both = openTop && openBottom;

  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!both) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const box = host.current?.getBoundingClientRect();
    if (!box || box.height === 0) return;
    setPct(clamp(((event.clientY - box.top) / box.height) * 100));
  };

  const stop = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false);
  };

  // The bar is a real control, not decoration: arrows nudge it, Home/End throw it to either end.
  const keys = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!both) return;
    const step = event.key === "ArrowUp" ? -5 : event.key === "ArrowDown" ? 5 : 0;
    if (step !== 0) { event.preventDefault(); setPct((now) => clamp(now + step)); return; }
    if (event.key === "Home") { event.preventDefault(); setPct(MIN_PCT); }
    if (event.key === "End") { event.preventDefault(); setPct(MAX_PCT); }
  };

  // One pane open takes the column; both open split it; both closed leave two headers.
  const sizeOf = (open: boolean, isTop: boolean): CSSProperties =>
    !open ? { flex: "0 0 auto" }
      : both ? (isTop ? { flex: `0 0 ${pct}%` } : { flex: "1 1 0" })
        : { flex: "1 1 auto" };

  return (
    <div className={`split-stack${dragging ? " is-dragging" : ""}`} ref={host}>
      <Pane pane={top} open={openTop} onToggle={() => setOpenTop((on) => !on)} style={sizeOf(openTop, true)} />
      <div
        className="split-stack__bar"
        role="separator"
        tabIndex={both ? 0 : -1}
        aria-orientation="horizontal"
        aria-valuenow={both ? Math.round(pct) : undefined}
        aria-valuemin={MIN_PCT}
        aria-valuemax={MAX_PCT}
        aria-label={`ปรับสัดส่วนระหว่าง ${top.label} และ ${bottom.label}`}
        aria-disabled={!both}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={stop}
        onPointerCancel={stop}
        onKeyDown={keys}
      >
        <span className="split-stack__grip" aria-hidden="true" />
      </div>
      <Pane pane={bottom} open={openBottom} onToggle={() => setOpenBottom((on) => !on)} style={sizeOf(openBottom, false)} />
    </div>
  );
}

function Pane({
  pane, open, onToggle, style,
}: {
  pane: StackPane;
  open: boolean;
  onToggle: () => void;
  style: CSSProperties;
}) {
  return (
    <section className={`split-stack__pane${open ? "" : " is-collapsed"}`} style={style} aria-label={pane.label}>
      <button
        type="button"
        className="split-stack__head"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={`${open ? "ย่อ" : "ขยาย"} ${pane.label}`}
      >
        <ChevronDown size={14} className="split-stack__chevron" />
        <span className="pairing-tool__h">{pane.title}</span>
      </button>
      {open && <div className="split-stack__body">{pane.body}</div>}
    </section>
  );
}
