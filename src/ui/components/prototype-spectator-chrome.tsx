"use client";

import { Check, ChevronDown, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";

const sportColors: Record<string, string> = { "A-Math": "#315db3", Crossword: "#246f60", "คำคม": "#7751a3" };
const luminance = ([r, g, b]: number[]) => {
  const linear = (value: number) => value / 255 <= .04045 ? value / 255 / 12.92 : ((value / 255 + .055) / 1.055) ** 2.4;
  return .2126 * linear(r) + .7152 * linear(g) + .0722 * linear(b);
};

export function prototypeSportTheme(sport: string, override?: string): CSSProperties {
  const color = override && /^#[\da-f]{6}$/i.test(override) ? override : sportColors[sport] ?? "#315db3";
  const rgb = [1, 3, 5].map(offset => Number.parseInt(color.slice(offset, offset + 2), 16));
  let ink = rgb;
  while (luminance(ink) > .15) ink = ink.map(value => Math.floor(value * .9));
  return {
    "--sport": color,
    "--sport-ink": `rgb(${ink.join(",")})`,
    "--sport-on": luminance(rgb) > .179 ? "#000" : "#fff",
  } as CSSProperties;
}

export function PrototypeViewerStatus({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

export function PrototypeViewerHelp({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return <>
    <button ref={button} type="button" className="help vcard-help" aria-label={`คำอธิบาย ${label}`} aria-expanded={open}
      aria-controls={id} onClick={() => setOpen(!open)}>?</button>
    {open && <PrototypeViewerPopover anchor={button} width={250} minHeight={48} label={label} onDismiss={() => setOpen(false)}
      id={id} kind="help"><div className="prototype-viewer-help" role="note">{children}</div></PrototypeViewerPopover>}
  </>;
}

type Placement = { style: CSSProperties; direction: "up" | "down"; sheet: boolean; centered?: boolean };
export function useViewerPlacement(
  anchor: RefObject<HTMLElement | null>,
  box: RefObject<HTMLElement | null>,
  width: number,
  minHeight: number,
  end = false,
  player = false,
  enabled = true,
) {
  const [placement, setPlacement] = useState<Placement>();
  useLayoutEffect(() => {
    if (!enabled) return;
    let frame: number;
    const position = () => {
      const trigger = anchor.current;
      if (!trigger || !box.current) {
        setPlacement({ style: {}, direction: "down", sheet: !player || window.innerWidth <= 768, centered: player && window.innerWidth > 768 });
        return;
      }
      const rect = trigger.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const actualWidth = Math.min(width, viewportWidth - 16);
      const gap = player ? 6 : 4;
      const below = viewportHeight - rect.bottom - 8 - gap;
      const above = rect.top - 8 - gap;
      if (Math.max(below, above) < minHeight || rect.bottom < 0 || rect.top > viewportHeight) {
        setPlacement({ style: {}, direction: "down", sheet: !player || viewportWidth <= 768, centered: player && viewportWidth > 768 });
        return;
      }
      const up = below < Math.min(minHeight * 1.6, box.current.scrollHeight) && above > below;
      const aligned = end || rect.left + actualWidth > viewportWidth - 8 ? rect.right - actualWidth : rect.left;
      setPlacement({
        style: {
          width: actualWidth, maxHeight: Math.floor(up ? above : below),
          left: Math.max(8, Math.min(viewportWidth - 8 - actualWidth, Math.round(aligned))),
          ...(up ? { bottom: Math.round(viewportHeight - rect.top + gap) } : { top: Math.round(rect.bottom + gap) }),
        },
        direction: up ? "up" : "down",
        sheet: false,
      });
    };
    const onPositionChange = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(position);
    };
    position();
    window.addEventListener("resize", onPositionChange);
    window.addEventListener("scroll", onPositionChange, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onPositionChange);
      window.removeEventListener("scroll", onPositionChange, true);
    };
  }, [anchor, box, width, minHeight, end, player, enabled]);
  return placement;
}

export function PrototypeViewerPopover({ anchor, width, minHeight = 160, end, label, kind, style, id, onDismiss, children, keyboard = true }: {
  anchor: RefObject<HTMLElement | null>;
  width: number;
  minHeight?: number;
  end?: boolean;
  label: string;
  kind: "search" | "menu" | "vcard" | "help";
  style?: CSSProperties;
  id?: string;
  onDismiss: () => void;
  children: ReactNode;
  keyboard?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const placement = useViewerPlacement(anchor, box, width, minHeight, end);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (kind === "help" && event.target instanceof Element && event.target.closest(".help")) return;
      if (event.target instanceof Node && !anchor.current?.contains(event.target) && !box.current?.contains(event.target)) dismiss.current();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      event.preventDefault();
      dismiss.current();
      anchor.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", outside);
    if (keyboard) document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      if (keyboard) document.removeEventListener("keydown", escape);
    };
  }, [anchor, keyboard, kind]);

  return <>
    {placement?.sheet && <div className="pop-scrim" aria-hidden />}
    <div ref={box} id={id} className={`pop pop--${kind}${style ? " sport-theme" : ""}${placement?.sheet ? " pop--sheet" : ""}`}
      data-side={placement?.direction} role={kind === "vcard" ? "dialog" : undefined} aria-label={kind === "vcard" ? label : undefined}
      style={{ ...style, ...placement?.style, visibility: placement ? undefined : "hidden" }}>
      {placement?.sheet && <div className="pop__head"><strong>{label}</strong><button type="button" className="pop__x" aria-label="ปิด" onClick={onDismiss}><X className="i" size={18} /></button></div>}
      {children}
    </div>
  </>;
}

export interface PrototypeGameOption { value: string; label: string; detail?: string; disabled?: boolean }
export function PrototypeViewerGameSelect({ value, options, theme, onChange }: {
  value: string; options: PrototypeGameOption[]; theme: CSSProperties; onChange: (value: string) => void;
}) {
  const listId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const indexes = options.flatMap((option, index) => option.disabled ? [] : [index]);
  const selected = options.findIndex(option => option.value === value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const close = () => setOpen(false);
  const openAt = () => { setActive(indexes.includes(selected) ? selected : indexes[0] ?? -1); setOpen(true); };
  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    close();
    trigger.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (open && active >= 0) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, listId, open]);
  return <>
    <button ref={trigger} type="button" className="sm" aria-haspopup="listbox" aria-expanded={open} aria-label={`เลือกเกม: ${options[selected]?.label ?? "ยังไม่ประกาศคู่"}`}
      aria-controls={open ? listId : undefined} aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
      onClick={() => open ? close() : openAt()}
      onKeyDown={event => {
        if (event.key === "Escape" && open) { event.preventDefault(); close(); return; }
        if (open && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); choose(active); return; }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        if (!open) { openAt(); return; }
        if (!indexes.length) return;
        const current = indexes.indexOf(active);
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive(event.key === "Home" ? indexes[0] : event.key === "End" ? indexes.at(-1)!
          : indexes[(current + step + indexes.length) % indexes.length]);
      }}>
      <span className="sm__v">{options[selected]?.label ?? "ยังไม่ประกาศคู่"}</span><ChevronDown className="i sm__chev" size={14} />
    </button>
    {open && <PrototypeViewerPopover anchor={trigger} id={listId} width={Math.max(210, Math.min(380, trigger.current?.offsetWidth ?? 210))} end label="เลือกเกม" kind="menu" style={theme} onDismiss={close}>
      <div className="lb" role="listbox" aria-label="เลือกเกม">{options.map((option, index) => <button key={option.value}
        type="button" role="option" id={`${listId}-${index}`} tabIndex={-1}
        className={`lb__opt${index === active ? " is-active" : ""}`} aria-selected={option.value === value}
        aria-disabled={option.disabled || undefined} onClick={() => choose(index)} onMouseEnter={() => { if (!option.disabled) setActive(index); }}>
        <span className="lb__l">{option.label}</span>{option.detail && <span className="lb__d">{option.detail}</span>}
        {option.value === value && <Check className="i lb__ck" size={14} />}
      </button>)}</div>
    </PrototypeViewerPopover>}
  </>;
}
