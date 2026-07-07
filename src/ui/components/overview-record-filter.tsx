"use client";

import { Building2, Check, ChevronDown, Hash, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { matchesPlayerCode, normalizePlayerCode } from "@/domain/tournament/player-code";
import type { Player } from "@/domain/tournament/types";
import { Button } from "@/ui/components/button";

export interface OverviewRecordFilterValue {
  mode: "player" | "school";
  playerIds: string[];
  schools: string[];
}

function codeTokens(query: string): string[] | null {
  const tokens = query.split(/[\s,;]+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => /^P?\d+$/i.test(token)) ? tokens : null;
}

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
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const schools = useMemo(() => [...new Set(players.map((player) => player.school).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "th", { numeric: true })), [players]);
  const tokens = value.mode === "player" ? codeTokens(query) : null;
  const normalizedQuery = query.trim().toLocaleLowerCase("th");
  const filteredPlayers = useMemo(() => players
    .filter((player) => {
      if (!query.trim()) return true;
      if (tokens) return tokens.some((token) => matchesPlayerCode(player.id, token));
      return `${player.id} ${player.firstName} ${player.lastName} ${player.school}`
        .toLocaleLowerCase("th").includes(normalizedQuery);
    })
    .sort((a, b) => a.id.localeCompare(b.id, "th", { numeric: true })), [normalizedQuery, players, query, tokens]);
  const filteredSchools = useMemo(() => schools.filter((school) =>
    !normalizedQuery || school.toLocaleLowerCase("th").includes(normalizedQuery)), [normalizedQuery, schools]);
  const activeCount = value.mode === "player" ? value.playerIds.length : value.schools.length;

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  const changeMode = (mode: OverviewRecordFilterValue["mode"]) => {
    onChange({ ...value, mode });
    setQuery("");
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };
  const togglePlayer = (playerId: string) => {
    const selected = new Set(value.playerIds);
    if (selected.has(playerId)) selected.delete(playerId); else selected.add(playerId);
    onChange({ ...value, playerIds: [...selected] });
  };
  const toggleSchool = (school: string) => {
    const selected = new Set(value.schools);
    if (selected.has(school)) selected.delete(school); else selected.add(school);
    onChange({ ...value, schools: [...selected] });
  };
  const selectTypedCodes = () => {
    if (value.mode !== "player" || !tokens) return false;
    const valid = new Set(players.map((player) => player.id));
    const selected = new Set(value.playerIds);
    for (const token of tokens) {
      const playerId = normalizePlayerCode(token);
      if (valid.has(playerId)) selected.add(playerId);
    }
    onChange({ ...value, playerIds: [...selected] });
    setQuery("");
    return true;
  };
  const clear = () => onChange({ mode: value.mode, playerIds: [], schools: [] });

  return (
    <div ref={rootRef} className={`overview-record-filter${open ? " overview-record-filter--open" : ""}`}>
      <div className="overview-record-filter__field">
        <Search size={15} aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          inputMode={value.mode === "player" ? "text" : "search"}
          autoComplete="off"
          aria-label={value.mode === "player" ? "กรองหลายรหัสนักกีฬา" : "กรองหลายโรงเรียน"}
          aria-haspopup="dialog"
          aria-expanded={open}
          placeholder={activeCount > 0
            ? `เลือกแล้ว ${activeCount} ${value.mode === "player" ? "รหัส" : "โรงเรียน"}`
            : "ค้นหารหัส / โรงเรียน"}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
              setQuery("");
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (!selectTypedCodes()) {
                if (value.mode === "player" && filteredPlayers.length === 1) togglePlayer(filteredPlayers[0].id);
                if (value.mode === "school" && filteredSchools.length === 1) toggleSchool(filteredSchools[0]);
                setQuery("");
              }
            }
          }}
        />
        {activeCount > 0 && <span className="overview-record-filter__count">{activeCount}</span>}
        <ChevronDown size={15} className="overview-record-filter__chevron" aria-hidden="true" />
      </div>

      {open && (
        <section className="overview-record-filter__popup" role="dialog" aria-label="เลือกตัวกรองข้อมูลภาพรวม">
          <header>
            <div>
              <strong>กรองข้อมูลทุกมุมมอง</strong>
              <span>Ranking, Pairing และ Result ใช้ตัวกรองชุดเดียวกัน</span>
            </div>
            <button type="button" aria-label="ปิดตัวกรอง" onClick={() => { setOpen(false); setQuery(""); }}><X size={17} /></button>
          </header>
          <div className="overview-record-filter__modes" role="group" aria-label="ประเภทตัวกรอง">
            <button type="button" className={value.mode === "player" ? "is-active" : ""} aria-pressed={value.mode === "player"} onClick={() => changeMode("player")}><Hash size={15} />หลายรหัสนักกีฬา</button>
            <button type="button" className={value.mode === "school" ? "is-active" : ""} aria-pressed={value.mode === "school"} onClick={() => changeMode("school")}><Building2 size={15} />หลายโรงเรียน</button>
          </div>
          <p className="overview-record-filter__hint">
            {value.mode === "player"
              ? "พิมพ์รหัสแล้วกด Enter ได้หลายรหัส เช่น 1, 12, 31 หรือเลือกจากรายการ"
              : "พิมพ์ชื่อโรงเรียนแล้วเลือกได้มากกว่าหนึ่งแห่ง"}
          </p>
          <div className="overview-record-filter__options">
            {value.mode === "player" ? filteredPlayers.map((player) => {
              const selected = value.playerIds.includes(player.id);
              return (
                <button type="button" key={player.id} className={selected ? "is-selected" : ""} aria-pressed={selected} onClick={() => togglePlayer(player.id)}>
                  <span className="overview-record-filter__check">{selected && <Check size={13} />}</span>
                  <span><strong>{player.id} · {player.firstName} {player.lastName}</strong><small>{player.school}</small></span>
                </button>
              );
            }) : filteredSchools.map((school) => {
              const selected = value.schools.includes(school);
              const count = players.filter((player) => player.school === school).length;
              return (
                <button type="button" key={school} className={selected ? "is-selected" : ""} aria-pressed={selected} onClick={() => toggleSchool(school)}>
                  <span className="overview-record-filter__check">{selected && <Check size={13} />}</span>
                  <span><strong>{school}</strong><small>{count} นักกีฬา</small></span>
                </button>
              );
            })}
            {(value.mode === "player" ? filteredPlayers.length : filteredSchools.length) === 0 && (
              <div className="overview-record-filter__empty">ไม่พบรายการที่ค้นหา</div>
            )}
          </div>
          <footer>
            <span>เลือกอยู่ {activeCount} รายการ</span>
            <Button type="button" variant="secondary" size="sm" disabled={value.playerIds.length === 0 && value.schools.length === 0} onClick={clear}><X size={14} />ล้างทั้งหมด</Button>
            <Button type="button" size="sm" onClick={() => { setOpen(false); setQuery(""); }}>เสร็จสิ้น</Button>
          </footer>
        </section>
      )}
    </div>
  );
}
