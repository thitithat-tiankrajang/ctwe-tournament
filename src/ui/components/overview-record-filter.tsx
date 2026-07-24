"use client";

import { Building2, Check, ChevronDown, Hash, Search, X } from "lucide-react";
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { matchesPlayerCode, PLAYER_CODE_QUERY } from "@/domain/tournament/player-code";
import type { Player } from "@/domain/tournament/types";
import { Button } from "@/ui/components/button";

export interface OverviewRecordFilterValue {
  mode: "player" | "school";
  playerIds: string[];
  schools: string[];
}

/**
 * Cap on rendered option rows. Typing narrows the list further; rendering every player as a
 * button on each keystroke is what made the mobile keyboard stutter on large cards.
 */
const MAX_VISIBLE_OPTIONS = 80;
const MOBILE_PICKER_QUERY = "(max-width: 768px)";
const SHEET_CLOSE_FALLBACK_MS = 380;
const SHEET_SNAP_DURATION_MS = 220;

function codeTokens(query: string): string[] | null {
  const tokens = query.split(/[\s,;]+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => PLAYER_CODE_QUERY.test(token)) ? tokens : null;
}

/**
 * The scrollable option rows, memoised as a unit: live SSE updates re-render the overview while
 * the picker is open, and this keeps those renders away from the (potentially large) list. Its
 * props only change on real picker interactions (typing settles via the deferred query).
 */
const OptionList = memo(function OptionList({ mode, players, schools, query, selectedPlayers, selectedSchools, onTogglePlayer, onToggleSchool }: {
  mode: OverviewRecordFilterValue["mode"];
  players: Player[];
  schools: string[];
  query: string;
  selectedPlayers: string[];
  selectedSchools: string[];
  onTogglePlayer: (playerId: string) => void;
  onToggleSchool: (school: string) => void;
}) {
  const normalized = query.trim().toLocaleLowerCase("th");
  const tokens = mode === "player" ? codeTokens(query) : null;
  const schoolCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const player of players) counts.set(player.school, (counts.get(player.school) ?? 0) + 1);
    return counts;
  }, [players]);
  const matches = useMemo(() => {
    if (mode === "school") {
      return normalized ? schools.filter((school) => school.toLocaleLowerCase("th").includes(normalized)) : schools;
    }
    if (!normalized) return players;
    if (tokens) return players.filter((player) => tokens.some((token) => matchesPlayerCode(player.id, token)));
    return players.filter((player) =>
      `${player.id} ${player.firstName} ${player.lastName} ${player.school}`.toLocaleLowerCase("th").includes(normalized));
  }, [mode, normalized, players, schools, tokens]);
  const hidden = Math.max(0, matches.length - MAX_VISIBLE_OPTIONS);
  const visible = hidden > 0 ? matches.slice(0, MAX_VISIBLE_OPTIONS) : matches;
  const selectedPlayerSet = useMemo(() => new Set(selectedPlayers), [selectedPlayers]);
  const selectedSchoolSet = useMemo(() => new Set(selectedSchools), [selectedSchools]);

  if (matches.length === 0) return <div className="overview-record-filter__empty">ไม่พบรายการที่ค้นหา</div>;
  return (
    <>
      {mode === "player"
        ? (visible as Player[]).map((player) => {
            const selected = selectedPlayerSet.has(player.id);
            return (
              <button type="button" key={player.id} className={selected ? "is-selected" : ""} aria-pressed={selected} onClick={() => onTogglePlayer(player.id)}>
                <span className="overview-record-filter__check">{selected && <Check size={14} />}</span>
                <span><strong>{player.id} · {player.firstName} {player.lastName}</strong><small>{player.school}</small></span>
              </button>
            );
          })
        : (visible as string[]).map((school) => {
            const selected = selectedSchoolSet.has(school);
            return (
              <button type="button" key={school} className={selected ? "is-selected" : ""} aria-pressed={selected} onClick={() => onToggleSchool(school)}>
                <span className="overview-record-filter__check">{selected && <Check size={14} />}</span>
                <span><strong>{school}</strong><small>{schoolCounts.get(school) ?? 0} นักกีฬา</small></span>
              </button>
            );
          })}
      {hidden > 0 && <div className="overview-record-filter__more">ยังมีอีก {hidden} รายการ — พิมพ์ค้นหาเพื่อกรองให้แคบลง</div>}
    </>
  );
});

export function OverviewRecordFilter({
  players,
  value,
  onChange,
}: {
  players: Player[];
  value: OverviewRecordFilterValue;
  onChange: (value: OverviewRecordFilterValue) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const dragFrameRef = useRef<number | null>(null);
  const closingRef = useRef(false);
  const dragRef = useRef({ pointerId: -1, startY: 0, currentY: 0, lastY: 0, lastTime: 0, velocity: 0, sheetHeight: 1 });
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Typing updates the input at full speed; the (heavier) list below follows at deferred priority.
  const deferredQuery = useDeferredValue(query);
  const sortedPlayers = useMemo(() => [...players]
    .sort((a, b) => a.id.localeCompare(b.id, "th", { numeric: true })), [players]);
  const schools = useMemo(() => [...new Set(players.map((player) => player.school).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "th", { numeric: true })), [players]);
  const activeCount = value.mode === "player" ? value.playerIds.length : value.schools.length;
  const selectedChips = value.mode === "player"
    ? [...value.playerIds].sort((a, b) => a.localeCompare(b, "th", { numeric: true }))
    : [...value.schools].sort((a, b) => a.localeCompare(b, "th", { numeric: true }));

  const finishClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (dragFrameRef.current !== null) {
      window.cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = null;
    }
    closingRef.current = false;
    dragRef.current.pointerId = -1;
    setOpen(false);
    setQuery("");
  }, []);

  const close = useCallback(() => {
    if (closingRef.current) return;
    const mobile = window.matchMedia(MOBILE_PICKER_QUERY).matches;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!mobile || reduceMotion) {
      finishClose();
      return;
    }

    closingRef.current = true;
    if (dragFrameRef.current !== null) {
      window.cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = null;
    }
    const sheet = sheetRef.current;
    const backdrop = backdropRef.current;
    rootRef.current?.classList.remove("overview-record-filter--dragging");
    rootRef.current?.classList.add("overview-record-filter--closing");
    if (sheet) {
      const progress = Math.min(1, Math.max(0, dragRef.current.currentY) / Math.max(1, sheet.offsetHeight));
      const duration = Math.round(170 + (1 - progress) * 90);
      sheet.style.transitionDuration = `${duration}ms`;
      sheet.style.transform = `translate3d(0, ${sheet.offsetHeight + 24}px, 0)`;
    }
    if (backdrop) {
      backdrop.style.transitionDuration = "200ms";
      backdrop.style.opacity = "0";
    }
    closeTimerRef.current = window.setTimeout(finishClose, SHEET_CLOSE_FALLBACK_MS);
  }, [finishClose]);

  useEffect(() => () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    if (dragFrameRef.current !== null) window.cancelAnimationFrame(dragFrameRef.current);
  }, []);

  // Desktop dropdown: close when clicking anywhere else. The mobile sheet closes via its backdrop,
  // which lives inside the root, so this handler never fires for taps on it.
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [close, open]);

  // While the sheet covers a phone screen, the page behind it must not scroll along.
  useEffect(() => {
    if (!open || !window.matchMedia("(max-width: 768px)").matches) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [open]);

  const openPicker = () => {
    if (closingRef.current) return;
    dragRef.current.currentY = 0;
    setOpen(true);
    // Auto-focus only where a keyboard doesn't cover half the screen.
    if (!window.matchMedia(MOBILE_PICKER_QUERY).matches) {
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  };

  const startSheetDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (!open || closingRef.current || !event.isPrimary || event.button !== 0 || !window.matchMedia(MOBILE_PICKER_QUERY).matches) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      currentY: 0,
      lastY: event.clientY,
      lastTime: event.timeStamp,
      velocity: 0,
      sheetHeight: sheetRef.current?.offsetHeight ?? 1,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    rootRef.current?.classList.add("overview-record-filter--dragging");
  };
  const moveSheetDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (drag.pointerId !== event.pointerId) return;
    const elapsed = Math.max(1, event.timeStamp - drag.lastTime);
    const instantVelocity = (event.clientY - drag.lastY) / elapsed;
    drag.velocity = (drag.velocity * 0.35) + (instantVelocity * 0.65);
    drag.lastY = event.clientY;
    drag.lastTime = event.timeStamp;
    drag.currentY = Math.max(0, event.clientY - drag.startY);
    if (dragFrameRef.current !== null) return;
    dragFrameRef.current = window.requestAnimationFrame(() => {
      dragFrameRef.current = null;
      const sheet = sheetRef.current;
      if (!sheet || dragRef.current.pointerId < 0) return;
      const y = dragRef.current.currentY;
      sheet.style.transform = `translate3d(0, ${y}px, 0)`;
      if (backdropRef.current) {
        const fade = Math.min(0.58, (y / dragRef.current.sheetHeight) * 0.82);
        backdropRef.current.style.opacity = String(1 - fade);
      }
    });
  };
  const snapSheetBack = () => {
    const sheet = sheetRef.current;
    rootRef.current?.classList.remove("overview-record-filter--dragging");
    if (sheet) {
      sheet.style.transitionDuration = `${SHEET_SNAP_DURATION_MS}ms`;
      sheet.style.transform = "translate3d(0, 0, 0)";
    }
    if (backdropRef.current) {
      backdropRef.current.style.transitionDuration = "180ms";
      backdropRef.current.style.opacity = "1";
    }
    dragRef.current.currentY = 0;
  };
  const endSheetDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (drag.pointerId !== event.pointerId) return;
    drag.currentY = Math.max(0, event.clientY - drag.startY);
    const distance = drag.currentY;
    const farEnough = distance >= Math.min(140, drag.sheetHeight * 0.2);
    const fastEnough = distance >= 28 && drag.velocity >= 0.5;
    drag.pointerId = -1;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (farEnough || fastEnough) close();
    else snapSheetBack();
  };
  const cancelSheetDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (dragRef.current.pointerId !== event.pointerId) return;
    dragRef.current.pointerId = -1;
    snapSheetBack();
  };
  const changeMode = (mode: OverviewRecordFilterValue["mode"]) => {
    onChange({ ...value, mode });
    setQuery("");
  };
  const togglePlayer = useCallback((playerId: string) => {
    const selected = new Set(value.playerIds);
    if (selected.has(playerId)) selected.delete(playerId); else selected.add(playerId);
    onChange({ ...value, playerIds: [...selected] });
  }, [onChange, value]);
  const toggleSchool = useCallback((school: string) => {
    const selected = new Set(value.schools);
    if (selected.has(school)) selected.delete(school); else selected.add(school);
    onChange({ ...value, schools: [...selected] });
  }, [onChange, value]);
  const selectTypedCodes = () => {
    const tokens = value.mode === "player" ? codeTokens(query) : null;
    if (!tokens) return false;
    const selected = new Set(value.playerIds);
    // Resolve prefix-aware: a bare "1" must find A001 (every card's ids carry a letter prefix).
    for (const token of tokens) {
      for (const player of players) {
        if (matchesPlayerCode(player.id, token)) selected.add(player.id);
      }
    }
    onChange({ ...value, playerIds: [...selected] });
    setQuery("");
    return true;
  };
  const singleEnterMatch = () => {
    const normalized = query.trim().toLocaleLowerCase("th");
    if (!normalized) return;
    if (value.mode === "player") {
      const matched = sortedPlayers.filter((player) =>
        `${player.id} ${player.firstName} ${player.lastName} ${player.school}`.toLocaleLowerCase("th").includes(normalized));
      if (matched.length === 1) togglePlayer(matched[0].id);
    } else {
      const matched = schools.filter((school) => school.toLocaleLowerCase("th").includes(normalized));
      if (matched.length === 1) toggleSchool(matched[0]);
    }
    setQuery("");
  };
  const clear = () => onChange({ mode: value.mode, playerIds: [], schools: [] });

  return (
    <div
      ref={rootRef}
      className={`overview-record-filter${open ? " overview-record-filter--open" : ""}`}
    >
      <button
        type="button"
        className="overview-record-filter__trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : openPicker())}
      >
        <Search size={16} aria-hidden="true" />
        <span className={`overview-record-filter__trigger-label${activeCount > 0 ? " overview-record-filter__trigger-label--active" : ""}`}>
          {activeCount > 0
            ? `กรองอยู่ ${activeCount} ${value.mode === "player" ? "รหัส" : "โรงเรียน"}`
            : "ค้นหานักกีฬา / โรงเรียน"}
        </span>
        {activeCount > 0 && <span className="overview-record-filter__count">{activeCount}</span>}
        <ChevronDown size={15} className="overview-record-filter__chevron" aria-hidden="true" />
      </button>

      {open && (
        <>
          <div ref={backdropRef} className="overview-record-filter__backdrop" aria-hidden="true" onClick={close} />
          <section
            ref={sheetRef}
            className="overview-record-filter__popup"
            role="dialog"
            aria-modal="true"
            aria-label="เลือกตัวกรองข้อมูลภาพรวม"
            onTransitionEnd={(event) => {
              if (closingRef.current && event.currentTarget === event.target && event.propertyName === "transform") finishClose();
            }}
          >
            <span
              className="overview-record-filter__grip"
              aria-hidden="true"
              onPointerDown={startSheetDrag}
              onPointerMove={moveSheetDrag}
              onPointerUp={endSheetDrag}
              onPointerCancel={cancelSheetDrag}
            />
            <header
              onPointerDown={startSheetDrag}
              onPointerMove={moveSheetDrag}
              onPointerUp={endSheetDrag}
              onPointerCancel={cancelSheetDrag}
            >
              <div>
                <strong>ค้นหาและกรองข้อมูล</strong>
                <span className="overview-record-filter__scope-hint">Ranking, Pairing และ Result ใช้ตัวกรองชุดเดียวกัน</span>
                <span className="overview-record-filter__dismiss-hint">แตะพื้นที่ด้านนอกหรือปัดลงเพื่อปิด</span>
              </div>
              <button type="button" className="overview-record-filter__close" aria-label="ปิดตัวกรอง" onClick={close}><X size={19} /></button>
            </header>
            <div className="overview-record-filter__modes" role="group" aria-label="ประเภทตัวกรอง">
              <button type="button" className={value.mode === "player" ? "is-active" : ""} aria-pressed={value.mode === "player"} onClick={() => changeMode("player")}><Hash size={15} />รหัสนักกีฬา</button>
              <button type="button" className={value.mode === "school" ? "is-active" : ""} aria-pressed={value.mode === "school"} onClick={() => changeMode("school")}><Building2 size={15} />โรงเรียน</button>
            </div>
            <div className="overview-record-filter__searchbox">
              <Search size={17} aria-hidden="true" />
              <input
                ref={inputRef}
                value={query}
                type="text"
                inputMode="search"
                enterKeyHint="done"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                aria-label={value.mode === "player" ? "ค้นหารหัสหรือชื่อนักกีฬา" : "ค้นหาโรงเรียน"}
                placeholder={value.mode === "player" ? "พิมพ์รหัส / ชื่อ / โรงเรียน" : "พิมพ์ชื่อโรงเรียน"}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  if (!selectTypedCodes()) singleEnterMatch();
                }}
              />
              {query && (
                <button type="button" className="overview-record-filter__searchclear" aria-label="ล้างคำค้นหา" onClick={() => { setQuery(""); inputRef.current?.focus(); }}>
                  <X size={16} />
                </button>
              )}
            </div>
            {value.mode === "player" && (
              <p className="overview-record-filter__hint">พิมพ์หลายรหัสคั่นด้วยเว้นวรรคแล้วกด Enter ได้ เช่น 1 12 31</p>
            )}
            {selectedChips.length > 0 && (
              <div className="overview-record-filter__chips" aria-label="รายการที่เลือก — แตะเพื่อเอาออก">
                {selectedChips.map((chip) => (
                  <button type="button" key={chip} onClick={() => (value.mode === "player" ? togglePlayer(chip) : toggleSchool(chip))} aria-label={`เอา ${chip} ออก`}>
                    {chip}<X size={13} aria-hidden="true" />
                  </button>
                ))}
              </div>
            )}
            <div className="overview-record-filter__options">
              <OptionList
                mode={value.mode}
                players={sortedPlayers}
                schools={schools}
                query={deferredQuery}
                selectedPlayers={value.playerIds}
                selectedSchools={value.schools}
                onTogglePlayer={togglePlayer}
                onToggleSchool={toggleSchool}
              />
            </div>
            <footer>
              <span>เลือกอยู่ {activeCount} รายการ</span>
              <Button type="button" variant="secondary" size="sm" disabled={value.playerIds.length === 0 && value.schools.length === 0} onClick={clear}><X size={14} />ล้างทั้งหมด</Button>
              <Button type="button" size="sm" className="overview-record-filter__done" onClick={close}>เสร็จสิ้น</Button>
            </footer>
          </section>
        </>
      )}
    </div>
  );
}
