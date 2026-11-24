"use client";

import { ChevronDown, LoaderCircle, LockKeyhole, Shuffle } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { comparePlayerCodes, matchesPlayerCode } from "@/domain/tournament/player-code";
import type { Pairing, Player } from "@/domain/tournament/types";
import { FreshSecretInput } from "./fresh-secret-input";
import { useViewerPlacement } from "./prototype-spectator-chrome";

export function DirectPlayerSwap({ players, pairings, lockReason, onSwap, disabled, autoFocus, seats, samePairAllowed, game }: {
  players: readonly Player[];
  pairings: readonly Pairing[];
  lockReason?: (pairing: Pairing) => string | undefined;
  onSwap: (one: string, two: string, password: string) => Promise<boolean>;
  disabled?: boolean;
  autoFocus?: boolean;
  seats?: boolean;
  samePairAllowed?: boolean;
  game?: number;
}) {
  const id = useId();
  const first = useRef<HTMLInputElement>(null);
  const second = useRef<HTMLInputElement>(null);
  const secret = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<0 | 1 | null>(null);
  const closedAnchor = useRef<HTMLInputElement>(null);
  const anchor = active === null ? closedAnchor : active === 1 ? second : first;
  const placed = useViewerPlacement(anchor, panel, 380, 130);
  const [codes, setCodes] = useState<[string, string]>(["", ""]);
  const [password, setPassword] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("seat");
  const [descending, setDescending] = useState(false);
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ message: string; error?: boolean }>();
  const spots = new Map<string, { pairing: Pairing; side: number }>();
  for (const pairing of pairings) {
    if (pairing.playerOneId) spots.set(pairing.playerOneId, { pairing, side: 1 });
    if (pairing.playerTwoId) spots.set(pairing.playerTwoId, { pairing, side: 2 });
  }
  const options = players.map((player) => {
    const spot = spots.get(player.id);
    const name = `${player.firstName} ${player.lastName}`;
    const reason = player.terminated && (player.withdrawnFromGame ?? 0) <= (game ?? 0x7fff) ? "ถอนแล้ว" : !spot ? "ยังไม่มีคู่ในเกมนี้"
      : spot.pairing.resultType || spot.pairing.scoreOne != null || spot.pairing.scoreTwo != null ? "ล็อกผลแล้ว"
      : lockReason?.(spot.pairing);
    return { player, spot, name, reason };
  });
  const find = (code: string) => options.find((option) => matchesPlayerCode(option.player.id, code));
  const other = active != null ? find(codes[active === 0 ? 1 : 0]) : undefined;
  const rows = options.map((option) => ({ ...option, reason: option.reason
    || (option.player.id === other?.player.id ? "เลือกแล้ว"
      : !samePairAllowed && other?.spot && other.spot.pairing.id === option.spot?.pairing.id ? "อยู่คู่เดียวกัน" : undefined) }))
    .filter(({ player, reason }) => (!available || !reason) && (!query || matchesPlayerCode(player.id, query)
      || player.id.toLowerCase().includes(query.toLowerCase())
      || player.id.replace(/^[A-Z]+0*/i, "").startsWith(query)))
    .sort((a, b) => {
      if (sort === "seat" && Boolean(a.spot) !== Boolean(b.spot)) return a.spot ? -1 : 1;
      const compare = sort === "name" ? a.name.localeCompare(b.name, "th")
        : sort === "seat" && a.spot && b.spot ? a.spot.pairing.tableNumber - b.spot.pairing.tableNumber || a.spot.side - b.spot.side
        : comparePlayerCodes(a.player.id, b.player.id);
      return (descending ? -1 : 1) * compare;
    });
  useEffect(() => { if (autoFocus) first.current?.focus(); }, [autoFocus]);
  const wrapper = useRef<HTMLDivElement>(null);
  const update = (index: 0 | 1, code: string) => {
    setCodes((prior) => index === 0 ? [code, prior[1]] : [prior[0], code]);
    setFeedback(undefined);
  };
  const next = (index: 0 | 1) => {
    setActive(null);
    (index === 0 ? second : secret).current?.focus({ preventScroll: true });
  };
  const submit = async () => {
    const [a, b] = codes.map(find);
    const fail = (message: string) => setFeedback({ message, error: true });
    if (!a || !b || a === b) return fail("กรอกรหัสผู้เล่นสองคนที่ต่างกัน");
    if (a.reason || b.reason) return fail(a.reason || b.reason || "");
    if (!samePairAllowed && a.spot?.pairing.id === b.spot?.pairing.id) return fail("ผู้เล่นอยู่คู่เดียวกัน");
    if (!password) return fail("กรอกรหัสผ่านเพื่อยืนยัน");
    if (busy || disabled) return;
    setActive(null);
    setBusy(true);
    try {
      if (await onSwap(a.player.id, b.player.id, password)) {
        setCodes(["", ""]); setPassword(""); setFeedback({ message: `สลับ ${a.player.id} ↔ ${b.player.id} แล้ว` });
      }
    } catch (error) { fail(error instanceof Error ? error.message : "สลับผู้เล่นไม่สำเร็จ"); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    if (active === null) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !wrapper.current?.contains(event.target)) setActive(null);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [active]);
  const field = (index: 0 | 1) => <span className="dir-field">
    <input ref={index ? second : first} className="kid" inputMode="numeric" autoComplete="off" disabled={disabled || busy}
      placeholder={index ? "รหัส B" : "รหัส A"} value={codes[index]} aria-label={index ? "รหัสผู้เล่น B ที่จะสลับ" : "รหัสผู้เล่น A ที่จะสลับ"}
      aria-haspopup="dialog" aria-expanded={active === index} aria-controls={active === index ? id : undefined}
      onFocus={() => { setQuery(""); setActive(index); }} onClick={() => { if (active !== index) { setQuery(""); setActive(index); } }}
      onChange={(event) => { const code = event.target.value.toUpperCase(); if (/^[A-Z]*\d{0,4}$/.test(code)) { update(index, code); setActive(index); setQuery(code); } }}
      onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); next(index); }
        if (event.key === "Escape") setActive(null);
        if (event.key === "ArrowDown") { event.preventDefault(); panel.current?.querySelector("select")?.focus(); }
      }} />
  </span>;
  return <div ref={wrapper} className="dir-tool-fields" onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setActive(null);
  }} onKeyDown={(event) => { if (event.key === "Escape" && active !== null) {
    if (panel.current?.contains(event.target as Node)) anchor.current?.focus();
    setActive(null);
  } }}>
    {field(0)}<span className="dir-tool-join" aria-hidden><Shuffle className="i" size={15} /></span>{field(1)}
    <FreshSecretInput ref={secret} wrapperClassName="dir-field score-swap-password" placeholder="รหัสผ่าน" aria-label="รหัสผ่านผู้อำนวยการ"
      disabled={disabled || busy} value={password} onFocus={() => setActive(null)} onChange={(event) => setPassword(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void submit(); } }} />
    <button type="button" className="btn btn--secondary dir-tool-submit" disabled={disabled || busy} onClick={() => void submit()}>
      {busy ? <LoaderCircle className="i spin" size={15} /> : <Shuffle className="i" size={15} />}ยืนยันการสลับ
    </button>
    <span className="dir-tool-feedback" data-score-message="swap" data-error={feedback?.error} role="status" title={feedback?.message}>{feedback?.message}</span>
    {active !== null && <div ref={panel} id={id} className={`pop pop--swap-picker${placed?.sheet ? " pop--sheet" : ""}`} role="dialog" aria-label="เลือกผู้เล่นที่จะสลับ"
      style={{ ...placed?.style, visibility: placed ? undefined : "hidden" }}>
      <div className="msw-controls swap-picker-controls">
        <label htmlFor={`${id}-sort`}>เรียงตาม</label><span className="msw-order-select"><select id={`${id}-sort`} value={sort} onChange={(event) => setSort(event.target.value)}>
          <option value="seat">{seats ? "ที่นั่ง / คู่" : "คู่ / ที่นั่ง"}</option><option value="code">รหัส</option><option value="name">ชื่อ</option>
        </select><ChevronDown className="i" size={14} /></span>
        <button type="button" className="btn btn--sm btn--secondary" onClick={() => setDescending(!descending)}>{sort === "name" ? descending ? "ฮ → ก" : "ก → ฮ" : descending ? "มาก → น้อย" : "น้อย → มาก"}</button>
        <label className="swap-picker-filter"><input type="checkbox" checked={available} onChange={(event) => setAvailable(event.target.checked)} />เฉพาะที่สลับได้</label>
      </div>
      <div className="swap-picker-list">
        {rows.length ? rows.map(({ player, spot, name, reason }) => <button type="button" className="msw-roster-row" key={player.id} disabled={Boolean(reason)}
          onClick={() => { update(active, player.id); next(active); }}>
          <small className="msw-pos">{spot ? seats ? `ที่นั่ง ${(spot.pairing.tableNumber - 1) * 2 + spot.side}` : `คู่ ${spot.pairing.tableNumber}` : "—"}</small>
          <span className="code">{player.id}</span><span className="msw-person"><b>{name}</b><small>{player.school}</small></span>
          {reason && <span className="swap-picker-lock"><LockKeyhole className="i" size={12} />{reason}</span>}
        </button>) : <p className="meta msw-empty">ไม่พบผู้เล่นตามตัวกรอง</p>}
      </div>
    </div>}
  </div>;
}
