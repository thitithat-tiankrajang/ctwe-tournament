"use client";

import { AlertTriangle, Check, CheckCircle2, LoaderCircle, Pencil, Save, SaveAll, Shuffle, Undo2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Pairing, Player } from "@/domain/tournament/types";
import { normalizePlayerCode } from "@/domain/tournament/player-code";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { applyColumnControls, GridHead, uniqueColumnValues, useColumnControls, useResizableColumns, type GridColumnBase } from "@/ui/components/data-grid";

/** Columns of the result-entry grid that get Excel sort + filter (player code / name / school / pair). */
const ENTRY_FILTER_KEYS = ["pair", "id1", "name1", "school1", "id2", "name2", "school2"];

export interface EntrySlot {
  /** Table/couple number; stable even before the pairing exists (PAIR_RESULT destination). */
  tableNumber: number;
  /** Undefined while the matchup is still unknown (waiting on the source game). */
  pairing?: Pairing;
  /** A finalized one-player pairing: the lone player must win. Distinct from a still-pending row. */
  isBye?: boolean;
}

type RowStatus = "pending" | "empty" | "dirty" | "saved";

const EDIT_COLUMNS: GridColumnBase[] = [
  { key: "pair", label: "คู่", min: 32, width: 42, align: "center" },
  { key: "id1", label: "รหัส 1", min: 58, width: 72, filterKind: "playerCode" },
  { key: "name1", label: "ชื่อ-นามสกุล", min: 90, width: 138 },
  { key: "school1", label: "โรงเรียน/สถาบัน", min: 90, width: 132 },
  { key: "id2", label: "รหัส 2", min: 58, width: 72, filterKind: "playerCode" },
  { key: "name2", label: "ชื่อ-นามสกุล", min: 90, width: 138 },
  { key: "school2", label: "โรงเรียน/สถาบัน", min: 90, width: 132 },
  { key: "score1", label: "คะแนน 1", min: 48, width: 62, align: "center" },
  { key: "score2", label: "คะแนน 2", min: 48, width: 62, align: "center" },
  { key: "diff", label: "Diff", min: 52, width: 68, align: "center" },
  { key: "action", label: "จัดการ", min: 82, width: 106 },
];

const VIEW_COLUMNS: GridColumnBase[] = [
  { key: "pair", label: "คู่", min: 32, width: 42, align: "center" },
  { key: "id1", label: "รหัส 1", min: 58, width: 72, filterKind: "playerCode" },
  { key: "name1", label: "ชื่อ-นามสกุล", min: 90, width: 138 },
  { key: "school1", label: "โรงเรียน/สถาบัน", min: 90, width: 132 },
  { key: "id2", label: "รหัส 2", min: 58, width: 72, filterKind: "playerCode" },
  { key: "name2", label: "ชื่อ-นามสกุล", min: 90, width: 138 },
  { key: "school2", label: "โรงเรียน/สถาบัน", min: 90, width: 132 },
  { key: "score1", label: "คะแนน 1", min: 64, width: 64, fitMin: 64, align: "center" },
  { key: "score2", label: "คะแนน 2", min: 64, width: 64, fitMin: 64, align: "center" },
  { key: "diff", label: "Diff", min: 50, width: 64, align: "center" },
  { key: "winner", label: "ผู้ชนะ", min: 58, width: 72, filterKind: "playerCode" },
];
const VIEW_FILTER_KEYS = VIEW_COLUMNS.map((column) => column.key);

const STATUS_OPTIONS: { value: "all" | RowStatus; label: string }[] = [
  { value: "all", label: "ทุกสถานะ" },
  { value: "empty", label: "ยังไม่ได้กรอก" },
  { value: "dirty", label: "กรอกแล้วยังไม่เซฟ" },
  { value: "saved", label: "บันทึกแล้ว" },
  { value: "pending", label: "รอผลจากเกมก่อนหน้า" },
];

function isRecorded(pairing: Pairing) {
  return pairing.scoreOne !== undefined && pairing.scoreTwo !== undefined && Boolean(pairing.resultType);
}

type CompletePairing = Pairing & { playerOneId: string; playerTwoId: string };

function isCompletePairing(pairing: Pairing | undefined): pairing is CompletePairing {
  return Boolean(pairing?.playerOneId && pairing?.playerTwoId);
}

/** For a bye (exactly one player present), which slot holds that player. */
function byeSide(pairing: Pairing | undefined): "one" | "two" | null {
  if (!pairing) return null;
  const one = Boolean(pairing.playerOneId);
  const two = Boolean(pairing.playerTwoId);
  return one && !two ? "one" : two && !one ? "two" : null;
}

interface Outcome { resultType: "WIN" | "DRAW"; winnerId?: string; diff: number; }
type SaveResult = { ok: true } | { ok: false; reason: string };

function calcOutcome(one: string, two: string, maxDiff: number, p1: string, p2: string): Outcome | null {
  if (one.trim() === "" || two.trim() === "") return null;
  const a = Number(one); const b = Number(two);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a > 1_000_000_000 || b > 1_000_000_000) return null;
  if (a === b) return { resultType: "DRAW", diff: 0 };
  return { resultType: "WIN", winnerId: a > b ? p1 : p2, diff: Math.min(Math.abs(a - b), maxDiff) };
}

function recordedDiff(pairing: Pairing) {
  if (!isRecorded(pairing)) return null;
  return pairing.resultType === "DRAW" ? 0 : pairing.calculatedDiff ?? 0;
}

export function ResultEntryGrid({ gameNumber, slots, players, maxDiff, storageKey, onSubmit, onPenalty, pairingEdit }: {
  gameNumber: number;
  slots: EntrySlot[];
  players: Map<string, Player>;
  maxDiff: number;
  /** Identifies the table so user-resized column widths persist per card+game in sessionStorage. */
  storageKey: string;
  onSubmit: (pairing: Pairing, scoreOne: number, scoreTwo: number, editExisting: boolean) => Promise<void>;
  /** Director-only "ลงดาบ" penalty for a pairing (incl. a bye). Opens the page's penalty dialog. */
  onPenalty?: (pairing: Pairing) => void;
  /** Director-only pairing edit during result collection. Swaps require password re-authentication. */
  pairingEdit?: { onSwap: (a: string, b: string, password: string) => Promise<boolean>; onUnpair: () => Promise<void> };
}) {
  const controls = useColumnControls();
  const [status, setStatus] = useState<"all" | RowStatus>("all");
  const [drafts, setDrafts] = useState<Record<string, { one: string; two: string }>>({});
  const [editing, setEditing] = useState<Set<string>>(new Set());
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [failedIds, setFailedIds] = useState<Set<string>>(new Set());
  const [savingAll, setSavingAll] = useState(false);
  const [swapOpen, setSwapOpen] = useState(false);
  const [swapA, setSwapA] = useState(""); const [swapB, setSwapB] = useState(""); const [swapPassword, setSwapPassword] = useState(""); const [swapping, setSwapping] = useState(false);
  // Quick key-in bar (รหัส A → คะแนน A → รหัส B → คะแนน B → save) + inline feedback/highlight.
  const [qIdA, setQIdA] = useState(""); const [qScoreA, setQScoreA] = useState("");
  const [qIdB, setQIdB] = useState(""); const [qScoreB, setQScoreB] = useState("");
  const [quickSaving, setQuickSaving] = useState(false);
  const [quickFeedback, setQuickFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const idARef = useRef<HTMLInputElement>(null); const scoreARef = useRef<HTMLInputElement>(null);
  const idBRef = useRef<HTMLInputElement>(null); const scoreBRef = useRef<HTMLInputElement>(null);
  const { colWidths, totalWidth, scrollRef, startResize } = useResizableColumns(EDIT_COLUMNS, storageKey);

  // Any "this is the pair" highlight + inline feedback clears when closed or the next entry starts.
  const clearFlash = () => { setQuickFeedback(null); setHighlightId(null); };

  const valueOf = (pairing: Pairing) => {
    const draft = drafts[pairing.id];
    return { one: draft?.one ?? pairing.scoreOne?.toString() ?? "", two: draft?.two ?? pairing.scoreTwo?.toString() ?? "" };
  };

  const rows = useMemo(() => slots.map((slot) => {
    const pairing = slot.pairing;
    const side = slot.isBye ? byeSide(pairing) : null;
    if (side && pairing) {
      // A finalized bye: one editable score for the lone player (they must win).
      const savedScore = (side === "one" ? pairing.scoreOne : pairing.scoreTwo)?.toString() ?? "";
      const value = drafts[pairing.id]?.[side] ?? savedScore;
      const saved = isRecorded(pairing);
      const changed = value !== savedScore;
      const rowStatus: RowStatus = saved && !changed ? "saved" : changed ? "dirty" : "empty";
      return { slot, pairing, status: rowStatus, saved, changed, bye: true as const, byeSlot: side };
    }
    if (!isCompletePairing(pairing)) return { slot, pairing, status: "pending" as RowStatus };
    const draft = drafts[pairing.id];
    const one = draft?.one ?? pairing.scoreOne?.toString() ?? "";
    const two = draft?.two ?? pairing.scoreTwo?.toString() ?? "";
    const saved = isRecorded(pairing);
    const savedOne = pairing.scoreOne?.toString() ?? ""; const savedTwo = pairing.scoreTwo?.toString() ?? "";
    const changed = one !== savedOne || two !== savedTwo;
    const rowStatus: RowStatus = saved && !changed ? "saved" : changed ? "dirty" : "empty";
    return { slot, pairing, status: rowStatus, saved, changed, one, two };
  }), [slots, drafts]);

  const accessors = useMemo<Record<string, (row: (typeof rows)[number]) => string | number>>(() => ({
    pair: (row) => row.slot.tableNumber,
    id1: (row) => players.get(row.pairing?.playerOneId ?? "")?.id ?? "—",
    name1: (row) => { const player = players.get(row.pairing?.playerOneId ?? ""); return player ? `${player.firstName} ${player.lastName}` : "—"; },
    school1: (row) => players.get(row.pairing?.playerOneId ?? "")?.school ?? "—",
    id2: (row) => players.get(row.pairing?.playerTwoId ?? "")?.id ?? "—",
    name2: (row) => { const player = players.get(row.pairing?.playerTwoId ?? ""); return player ? `${player.firstName} ${player.lastName}` : "—"; },
    school2: (row) => players.get(row.pairing?.playerTwoId ?? "")?.school ?? "—",
  }), [players]);
  const uniqueValues = useMemo(() => uniqueColumnValues(rows, accessors, ENTRY_FILTER_KEYS), [rows, accessors]);
  const filtered = useMemo(() => {
    const byColumn = applyColumnControls(rows, accessors, controls.filters, controls.sort, controls.textFilters, ["id1", "id2"]);
    return status === "all" ? byColumn : byColumn.filter((row) => row.status === status);
  }, [rows, accessors, controls.filters, controls.textFilters, controls.sort, status]);

  const filtersActive = controls.active || status !== "all";
  const savedCount = rows.filter((row) => row.status === "saved").length;
  const dirtyCount = rows.filter((row) => row.status === "dirty").length;
  const filteredSavable = filtered.filter((row) => isCompletePairing(row.pairing) && row.status === "dirty" && calcOutcome(row.one ?? "", row.two ?? "", maxDiff, row.pairing.playerOneId, row.pairing.playerTwoId));

  const setDraft = (id: string, field: "one" | "two", value: string, base: { one: string; two: string }) => {
    clearFlash();
    setFailedIds((prev) => { if (!prev.has(id)) return prev; const next = new Set(prev); next.delete(id); return next; });
    setDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] ?? base), [field]: value } }));
  };

  const saveValues = async (pairing: CompletePairing, one: string, two: string): Promise<SaveResult> => {
    if (!calcOutcome(one, two, maxDiff, pairing.playerOneId, pairing.playerTwoId))
      return { ok: false, reason: "คะแนนต้องเป็นจำนวนเต็มตั้งแต่ 0 ขึ้นไป" };
    setSavingIds((prev) => new Set(prev).add(pairing.id));
    try {
      await onSubmit(pairing, Number(one), Number(two), isRecorded(pairing));
      setDrafts((prev) => { const next = { ...prev }; delete next[pairing.id]; return next; });
      setEditing((prev) => { if (!prev.has(pairing.id)) return prev; const next = new Set(prev); next.delete(pairing.id); return next; });
      setFailedIds((prev) => { if (!prev.has(pairing.id)) return prev; const next = new Set(prev); next.delete(pairing.id); return next; });
      return { ok: true };
    } catch (error) {
      setFailedIds((prev) => new Set(prev).add(pairing.id));
      return { ok: false, reason: error instanceof Error ? error.message : "ระบบไม่ตอบรับ กรุณาลองใหม่" };
    } finally {
      setSavingIds((prev) => { const next = new Set(prev); next.delete(pairing.id); return next; });
    }
  };

  const saveRow = async (pairing: Pairing): Promise<boolean> => {
    if (!isCompletePairing(pairing)) return false;
    const { one, two } = valueOf(pairing);
    return (await saveValues(pairing, one, two)).ok;
  };

  // A bye: the lone player must win. We send their entered score in their slot and 0 in the empty slot.
  const byeValue = (pairing: Pairing, side: "one" | "two") =>
    drafts[pairing.id]?.[side] ?? (side === "one" ? pairing.scoreOne : pairing.scoreTwo)?.toString() ?? "";
  const saveByeRow = async (pairing: Pairing): Promise<boolean> => {
    const side = byeSide(pairing);
    if (!side) return false;
    const score = Number(byeValue(pairing, side));
    if (!Number.isInteger(score) || score <= 0) return false;
    const scoreOne = side === "one" ? score : 0;
    const scoreTwo = side === "one" ? 0 : score;
    setSavingIds((prev) => new Set(prev).add(pairing.id));
    try {
      await onSubmit(pairing, scoreOne, scoreTwo, isRecorded(pairing));
      setDrafts((prev) => { const next = { ...prev }; delete next[pairing.id]; return next; });
      setEditing((prev) => { if (!prev.has(pairing.id)) return prev; const next = new Set(prev); next.delete(pairing.id); return next; });
      setFailedIds((prev) => { if (!prev.has(pairing.id)) return prev; const next = new Set(prev); next.delete(pairing.id); return next; });
      return true;
    } catch {
      setFailedIds((prev) => new Set(prev).add(pairing.id));
      return false;
    } finally {
      setSavingIds((prev) => { const next = new Set(prev); next.delete(pairing.id); return next; });
    }
  };

  const saveAll = async () => {
    if (filteredSavable.length === 0) return;
    setSavingAll(true);
    try {
      for (const row of filteredSavable) {
        if (row.pairing) await saveRow(row.pairing);
      }
    } finally {
      setSavingAll(false);
    }
  };

  // Quick key-in: validate that A vs B is a real pairing this game (either side), then save + highlight.
  const quickSave = async () => {
    if (quickSaving) return;
    const a = normalizePlayerCode(qIdA); const b = normalizePlayerCode(qIdB);
    if (!a || !b) {
      setHighlightId(null);
      setQuickFeedback({ type: "error", message: "ไม่สำเร็จ · กรุณากรอกรหัส A และ B" });
      return;
    }
    const match = rows.find((row) => isCompletePairing(row.pairing)
      && ((normalizePlayerCode(row.pairing.playerOneId) === a && normalizePlayerCode(row.pairing.playerTwoId) === b)
        || (normalizePlayerCode(row.pairing.playerOneId) === b && normalizePlayerCode(row.pairing.playerTwoId) === a)));
    if (!match || !isCompletePairing(match.pairing)) {
      setHighlightId(null);
      setQuickFeedback({ type: "error", message: `ไม่สำเร็จ · ${a} กับ ${b} ไม่ใช่คู่ในเกม ${gameNumber}` });
      return;
    }
    const pairing = match.pairing;
    if (pairing.resultType === "PENALTY") {
      setHighlightId(pairing.id);
      setQuickFeedback({ type: "error", message: `ไม่สำเร็จ · คู่ที่ ${pairing.tableNumber} ถูกลงดาบและล็อกแล้ว` });
      return;
    }
    const aIsOne = normalizePlayerCode(pairing.playerOneId) === a;
    const oneScore = aIsOne ? qScoreA : qScoreB;
    const twoScore = aIsOne ? qScoreB : qScoreA;
    if (!calcOutcome(oneScore, twoScore, maxDiff, pairing.playerOneId, pairing.playerTwoId)) {
      setQuickFeedback({ type: "error", message: "ไม่สำเร็จ · คะแนนต้องเป็นจำนวนเต็ม ≥ 0" });
      return;
    }
    setQuickSaving(true);
    const result = await saveValues(pairing, oneScore, twoScore);
    setQuickSaving(false);
    if (!result.ok) {
      setQuickFeedback({ type: "error", message: `ไม่สำเร็จ · ${result.reason}` });
      return;
    }
    setHighlightId(pairing.id);
    const p1 = players.get(pairing.playerOneId); const p2 = players.get(pairing.playerTwoId);
    setQuickFeedback({ type: "success", message: `สำเร็จ · คู่ที่ ${pairing.tableNumber} · ${p1?.id} ${oneScore} : ${twoScore} ${p2?.id}` });
    setQIdA(""); setQScoreA(""); setQIdB(""); setQScoreB("");
    idARef.current?.focus();
  };

  const doSwap = async () => {
    if (!pairingEdit || !swapA.trim() || !swapB.trim() || !swapPassword) return;
    setSwapping(true);
    try {
      if (await pairingEdit.onSwap(normalizePlayerCode(swapA), normalizePlayerCode(swapB), swapPassword)) {
        setSwapA(""); setSwapB(""); setSwapPassword(""); setSwapOpen(false);
      }
    } finally { setSwapping(false); }
  };

  const startEdit = (id: string) => setEditing((prev) => new Set(prev).add(id));
  const cancelEdit = (id: string) => {
    setEditing((prev) => { const next = new Set(prev); next.delete(id); return next; });
    setDrafts((prev) => { const next = { ...prev }; delete next[id]; return next; });
    setFailedIds((prev) => { if (!prev.has(id)) return prev; const next = new Set(prev); next.delete(id); return next; });
  };

  const focusNext = (origin: HTMLElement, direction: "other" | "next") => {
    const row = origin.closest("tr"); if (!row) return;
    if (direction === "other") {
      const inputs = [...row.querySelectorAll<HTMLInputElement>("input.egrid-score")];
      const target = inputs.find((input) => input !== origin && !input.disabled);
      target?.focus(); target?.select();
      return;
    }
    let sibling = row.nextElementSibling as HTMLElement | null;
    while (sibling) {
      const target = sibling.querySelector<HTMLInputElement>("input.egrid-score:not([disabled])");
      if (target) { target.focus(); target.select(); return; }
      sibling = sibling.nextElementSibling as HTMLElement | null;
    }
  };

  return (
    <div className="entry-grid-wrap">
      <div className={`entry-keyin${quickFeedback ? ` entry-keyin--${quickFeedback.type}` : ""}`}>
        <span className="entry-keyin__label">คีย์เร็ว</span>
        <input ref={idARef} className="entry-keyin__id" inputMode="numeric" placeholder="รหัส A เช่น 16" value={qIdA} aria-label="รหัสฝ่าย A"
          onChange={(event) => { clearFlash(); setQIdA(event.target.value.toUpperCase()); }}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); scoreARef.current?.focus(); scoreARef.current?.select(); } }} />
        <input ref={scoreARef} type="number" inputMode="numeric" min={0} className="entry-keyin__score" placeholder="คะแนน A" value={qScoreA} aria-label="คะแนนฝ่าย A"
          onChange={(event) => { clearFlash(); setQScoreA(event.target.value); }} onFocus={(event) => event.target.select()}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); idBRef.current?.focus(); idBRef.current?.select(); } }} />
        <span className="entry-keyin__vs">พบ</span>
        <input ref={idBRef} className="entry-keyin__id" inputMode="numeric" placeholder="รหัส B เช่น 16" value={qIdB} aria-label="รหัสฝ่าย B"
          onChange={(event) => { clearFlash(); setQIdB(event.target.value.toUpperCase()); }}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); scoreBRef.current?.focus(); scoreBRef.current?.select(); } }} />
        <input ref={scoreBRef} type="number" inputMode="numeric" min={0} className="entry-keyin__score" placeholder="คะแนน B" value={qScoreB} aria-label="คะแนนฝ่าย B"
          onChange={(event) => { clearFlash(); setQScoreB(event.target.value); }} onFocus={(event) => event.target.select()}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void quickSave(); } }} />
        <Button className="entry-keyin__save" size="sm" variant="success" disabled={quickSaving} onClick={() => void quickSave()}>{quickSaving ? <LoaderCircle className="loading-spinner" size={14} /> : <Save size={14} />}บันทึกคะแนน</Button>
        {quickFeedback && (
          <>
            <div
              className="entry-keyin__feedback"
              role={quickFeedback.type === "error" ? "alert" : "status"}
              aria-live={quickFeedback.type === "error" ? "assertive" : "polite"}
              title={quickFeedback.message}
            >
              {quickFeedback.type === "success" ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
              <span>{quickFeedback.message}</span>
            </div>
            <button type="button" className="entry-keyin__close" aria-label="ปิดข้อความผลการบันทึก" onClick={clearFlash}><X size={16} /></button>
          </>
        )}
      </div>
      <div className="entry-grid-meta">
        <span className="entry-grid-meta__tags"><Badge tone="success">เซฟแล้ว {savedCount}</Badge>{dirtyCount > 0 && <Badge tone="warning">ยังไม่เซฟ {dirtyCount}</Badge>}</span>
        <div className="entry-grid-meta__actions">
          <label htmlFor={`f-status-${gameNumber}`}>สถานะ</label>
          <select id={`f-status-${gameNumber}`} className="select" value={status} onChange={(event) => setStatus(event.target.value as "all" | RowStatus)}>{STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
          <Button variant="secondary" size="sm" disabled={!filtersActive} onClick={() => { controls.clearAll(); setStatus("all"); }}><X size={14} />ล้างตัวกรอง</Button>
          <Button size="sm" variant="success" disabled={savingAll || filteredSavable.length === 0} onClick={() => void saveAll()}>{savingAll ? <LoaderCircle className="loading-spinner" size={14} /> : <SaveAll size={14} />}บันทึกทั้งหมด ({filteredSavable.length})</Button>
          {pairingEdit && <Button size="sm" variant="secondary" onClick={() => setSwapOpen((open) => !open)} title="สลับผู้เล่นในคู่ที่ยังไม่กรอกผล (เฉพาะผู้อำนวยการ)"><Shuffle size={14} />สลับผู้เล่น</Button>}
          {pairingEdit && savedCount === 0 && <Button size="sm" variant="secondary" onClick={() => void pairingEdit.onUnpair()} title="ยกเลิกการยืนยันและกลับไปหน้า pairing preview (เฉพาะผู้อำนวยการ)"><Undo2 size={14} />กลับไปแก้ Pairing</Button>}
        </div>
      </div>
      {pairingEdit && swapOpen && (
        <div className="entry-swap">
          <span className="entry-swap__label">สลับผู้เล่น (เฉพาะคู่ที่ยังไม่กรอกผล)</span>
          <input className="entry-keyin__id" inputMode="numeric" placeholder="รหัส A เช่น 16" value={swapA} aria-label="รหัสผู้เล่น A ที่จะสลับ" onChange={(event) => setSwapA(event.target.value.toUpperCase())} />
          <span className="entry-keyin__vs">↔</span>
          <input className="entry-keyin__id" inputMode="numeric" placeholder="รหัส B เช่น 16" value={swapB} aria-label="รหัสผู้เล่น B ที่จะสลับ" onChange={(event) => setSwapB(event.target.value.toUpperCase())} />
          <input className="entry-swap__password" type="password" autoComplete="current-password" placeholder="รหัสผ่านผู้อำนวยการ" value={swapPassword} aria-label="รหัสผ่านผู้อำนวยการเพื่อยืนยันการสลับคู่" onChange={(event) => setSwapPassword(event.target.value)} />
          <Button size="sm" variant="success" disabled={swapping || !swapA.trim() || !swapB.trim() || !swapPassword} onClick={() => void doSwap()}>{swapping ? <LoaderCircle className="loading-spinner" size={14} /> : <Shuffle size={14} />}ยืนยันการสลับ</Button>
          <Button size="sm" variant="ghost" aria-label="ปิด" onClick={() => { setSwapOpen(false); setSwapPassword(""); }}><X size={14} /></Button>
        </div>
      )}

      <div className="entry-grid-scroll" ref={scrollRef}>
        <table className="entry-grid entry-grid--match" style={{ width: totalWidth }}>
          <GridHead columns={EDIT_COLUMNS} colWidths={colWidths} startResize={startResize} excel={{
            sortable: (key) => ENTRY_FILTER_KEYS.includes(key),
            filterable: (key) => ENTRY_FILTER_KEYS.includes(key),
            sort: controls.sort,
            filters: controls.filters,
            textFilters: controls.textFilters,
            editingKey: controls.editingKey,
            uniqueValues,
            openKey: controls.openKey,
            openAnchor: controls.openAnchor,
            onSetSort: controls.setColumnSort,
            onStartTextFilter: controls.startTextFilter,
            onTextFilter: controls.setTextFilter,
            onStopTextFilter: () => controls.setEditingKey(null),
            onOpenFilter: controls.openFilter,
            onApply: (key, values) => controls.applyFilter(key, values, uniqueValues[key]?.length ?? 0),
            onClear: controls.clearFilter,
            onClose: () => controls.setOpenKey(null),
          }} />
          <tbody>
            {filtered.length === 0 ? (
              <tr><td className="egrid-empty" colSpan={EDIT_COLUMNS.length}><strong>ไม่พบคู่ตามตัวกรอง</strong><span>ลองล้างตัวกรองเพื่อดูทุกคู่</span></td></tr>
            ) : filtered.map((row) => {
              const { slot, pairing } = row;
              if (pairing?.resultType === "PENALTY") {
                const p1 = pairing.playerOneId ? players.get(pairing.playerOneId) : undefined;
                const p2 = pairing.playerTwoId ? players.get(pairing.playerTwoId) : undefined;
                const penalty = pairing.calculatedDiff ?? 0;
                return <tr key={pairing.id} className="egrid-row egrid-row--locked egrid-row--penalty">
                  <td className="egrid-td egrid-td--center cell-pair">{pairing.tableNumber}</td>
                  <td className="egrid-td cell-id">{p1?.id ?? "—"}</td>
                  <td className="egrid-td cell-person-name" title={`${p1?.firstName ?? ""} ${p1?.lastName ?? ""}`}>{p1 ? `${p1.firstName} ${p1.lastName}` : "บาย (ไม่มีคู่แข่ง)"}</td>
                  <td className="egrid-td cell-person-school" title={p1?.school}>{p1?.school ?? "—"}</td>
                  <td className="egrid-td cell-id">{p2?.id ?? "—"}</td>
                  <td className="egrid-td cell-person-name" title={`${p2?.firstName ?? ""} ${p2?.lastName ?? ""}`}>{p2 ? `${p2.firstName} ${p2.lastName}` : "บาย (ไม่มีคู่แข่ง)"}</td>
                  <td className="egrid-td cell-person-school" title={p2?.school}>{p2?.school ?? "—"}</td>
                  <td className="egrid-td egrid-td--center cell-score">-</td>
                  <td className="egrid-td egrid-td--center cell-score">-</td>
                  <td className="egrid-td egrid-td--center cell-diff cell-diff--penalty">-{penalty}</td>
                  <td className="egrid-td cell-action">
                    {onPenalty
                      ? <Button size="sm" variant="danger" title="แก้ไขแต้มลงดาบ" onClick={() => onPenalty(pairing)}>แก้ลงดาบ</Button>
                      : <Badge tone="danger">ล็อกโดยผู้อำนวยการ</Badge>}
                  </td>
                </tr>;
              }
              const side = slot.isBye ? byeSide(pairing) : null;
              if (side && pairing) {
                const present = players.get((side === "one" ? pairing.playerOneId : pairing.playerTwoId) ?? "");
                const value = byeValue(pairing, side);
                const saved = isRecorded(pairing);
                const isEditing = editing.has(pairing.id);
                const saving = savingIds.has(pairing.id);
                const failed = failedIds.has(pairing.id);
                const locked = saved && !isEditing;
                const disabled = locked || saving || savingAll;
                const scoreNum = Number(value);
                const valid = value.trim() !== "" && Number.isInteger(scoreNum) && scoreNum > 0;
                const changed = value !== ((side === "one" ? pairing.scoreOne : pairing.scoreTwo)?.toString() ?? "");
                const base = { one: drafts[pairing.id]?.one ?? "", two: drafts[pairing.id]?.two ?? "" };
                const presentCell = (
                  <>
                    <td className="egrid-td cell-id">{present?.id ?? "—"}</td>
                    <td className="egrid-td cell-person-name" title={`${present?.firstName ?? ""} ${present?.lastName ?? ""}`}>{present ? `${present.firstName} ${present.lastName}` : "—"}</td>
                    <td className="egrid-td cell-person-school" title={present?.school}>{present?.school ?? "—"}</td>
                  </>
                );
                const byeCell = (
                  <>
                    <td className="egrid-td cell-id">—</td>
                    <td className="egrid-td cell-person-name cell-bye">บาย (ไม่มีคู่แข่ง)</td>
                    <td className="egrid-td cell-person-school">—</td>
                  </>
                );
                const scoreInput = (
                  <td className="egrid-td"><input className="egrid-score" type="number" inputMode="numeric" min={1} aria-label={`คะแนน ${present?.id}`} placeholder="คะแนน" value={value} disabled={disabled}
                    onChange={(event) => setDraft(pairing.id, side, event.target.value, base)} onFocus={(event) => event.target.select()}
                    onKeyDown={async (event) => { if (event.key !== "Enter") return; event.preventDefault(); await saveByeRow(pairing); }} /></td>
                );
                const byeScore = <td className="egrid-td"><input className="egrid-score" disabled value="" readOnly placeholder="บาย" /></td>;
                return <tr key={pairing.id} className={`egrid-row egrid-row--bye${changed ? " egrid-row--dirty" : ""}${locked ? " egrid-row--locked" : ""}${failed ? " egrid-row--failed" : ""}`}>
                  <td className="egrid-td egrid-td--center cell-pair">{pairing.tableNumber}</td>
                  {side === "one" ? presentCell : byeCell}
                  {side === "one" ? byeCell : presentCell}
                  {side === "one" ? scoreInput : byeScore}
                  {side === "one" ? byeScore : scoreInput}
                  <td className={`egrid-td egrid-td--center cell-diff cell-diff--${valid ? "win" : "pending"}`}>{valid ? `${present?.id} · ${Math.min(scoreNum, maxDiff)}` : "ต้องชนะ"}</td>
                  <td className="egrid-td cell-action">
                    {locked ? (
                      <div className="cell-action__group">
                        <Button size="sm" variant="secondary" onClick={() => startEdit(pairing.id)}><Pencil size={13} />แก้ไข</Button>
                        {onPenalty && <Button size="sm" variant="danger" title="ลงดาบ (บังคับแพ้)" onClick={() => onPenalty(pairing)}>ลงดาบ</Button>}
                      </div>
                    ) : (
                      <div className="cell-action__group">
                        <Button size="sm" variant="success" disabled={!valid || !changed || saving || savingAll} onClick={() => void saveByeRow(pairing)}>{saving ? <LoaderCircle className="loading-spinner" size={13} /> : saved ? <Check size={13} /> : <Save size={13} />}เซฟ</Button>
                        {onPenalty && <Button size="sm" variant="danger" title="ลงดาบ (บังคับแพ้)" onClick={() => onPenalty(pairing)}>ลงดาบ</Button>}
                      </div>
                    )}
                  </td>
                </tr>;
              }
              if (!isCompletePairing(pairing)) {
                const p1 = pairing?.playerOneId ? players.get(pairing.playerOneId) : undefined;
                const p2 = pairing?.playerTwoId ? players.get(pairing.playerTwoId) : undefined;
                const waitingText = pairing ? "รอคู่แข่งจากอีก row" : "รอผลจากเกมก่อนหน้า";
                return <tr key={pairing?.id ?? `pending-${slot.tableNumber}`} className="egrid-row egrid-row--pending">
                  <td className="egrid-td egrid-td--center cell-pair">{slot.tableNumber}</td>
                  <td className="egrid-td cell-id">{p1?.id ?? "—"}</td>
                  <td className="egrid-td cell-person-name" title={`${p1?.firstName ?? ""} ${p1?.lastName ?? ""}`}>{p1 ? `${p1.firstName} ${p1.lastName}` : waitingText}</td>
                  <td className="egrid-td cell-person-school" title={p1?.school}>{p1?.school ?? "—"}</td>
                  <td className="egrid-td cell-id">{p2?.id ?? "—"}</td>
                  <td className="egrid-td cell-person-name" title={`${p2?.firstName ?? ""} ${p2?.lastName ?? ""}`}>{p2 ? `${p2.firstName} ${p2.lastName}` : waitingText}</td>
                  <td className="egrid-td cell-person-school" title={p2?.school}>{p2?.school ?? "—"}</td>
                  <td className="egrid-td"><input className="egrid-score" disabled value="" readOnly placeholder="—" /></td>
                  <td className="egrid-td"><input className="egrid-score" disabled value="" readOnly placeholder="—" /></td>
                  <td className="egrid-td egrid-td--center cell-diff">—</td>
                  <td className="egrid-td cell-action"><Badge tone="neutral">{pairing ? "รออีกฝั่ง" : "รอข้อมูล"}</Badge></td>
                </tr>;
              }
              const p1 = players.get(pairing.playerOneId); const p2 = players.get(pairing.playerTwoId);
              const one = row.one ?? ""; const two = row.two ?? "";
              const saved = Boolean(row.saved); const changed = Boolean(row.changed);
              const isEditing = editing.has(pairing.id);
              const saving = savingIds.has(pairing.id);
              const failed = failedIds.has(pairing.id);
              const locked = saved && !isEditing;
              const disabled = locked || saving || savingAll;
              const outcome = calcOutcome(one, two, maxDiff, pairing.playerOneId, pairing.playerTwoId);
              const base = { one, two };
              return <tr key={pairing.id} className={`egrid-row${changed ? " egrid-row--dirty" : ""}${locked ? " egrid-row--locked" : ""}${failed ? " egrid-row--failed" : ""}${highlightId === pairing.id ? " egrid-row--flash" : ""}`}>
                <td className="egrid-td egrid-td--center cell-pair">{pairing.tableNumber}</td>
                <td className="egrid-td cell-id">{p1?.id}</td>
                <td className="egrid-td cell-person-name" title={`${p1?.firstName ?? ""} ${p1?.lastName ?? ""}`}>{p1?.firstName} {p1?.lastName}</td>
                <td className="egrid-td cell-person-school" title={p1?.school}>{p1?.school}</td>
                <td className="egrid-td cell-id">{p2?.id}</td>
                <td className="egrid-td cell-person-name" title={`${p2?.firstName ?? ""} ${p2?.lastName ?? ""}`}>{p2?.firstName} {p2?.lastName}</td>
                <td className="egrid-td cell-person-school" title={p2?.school}>{p2?.school}</td>
                <td className="egrid-td"><input className="egrid-score" type="number" inputMode="numeric" min={0} aria-label={`คะแนน ${p1?.id}`} placeholder={p1?.id} value={one} disabled={disabled} onChange={(event) => setDraft(pairing.id, "one", event.target.value, base)} onFocus={(event) => event.target.select()} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); focusNext(event.currentTarget, "other"); } }} /></td>
                <td className="egrid-td"><input className="egrid-score" type="number" inputMode="numeric" min={0} aria-label={`คะแนน ${p2?.id}`} placeholder={p2?.id} value={two} disabled={disabled} onChange={(event) => setDraft(pairing.id, "two", event.target.value, base)} onFocus={(event) => event.target.select()} onKeyDown={async (event) => { if (event.key !== "Enter") return; event.preventDefault(); const origin = event.currentTarget; if (await saveRow(pairing)) focusNext(origin, "next"); }} /></td>
                <td className={`egrid-td egrid-td--center cell-diff cell-diff--${outcome ? outcome.resultType.toLowerCase() : "pending"}`}>{outcome ? (outcome.resultType === "DRAW" ? "เสมอ · 0" : `${outcome.winnerId} · ${outcome.diff}`) : "—"}</td>
                <td className="egrid-td cell-action">
                  {locked ? (
                    <div className="cell-action__group">
                      <Button size="sm" variant="secondary" onClick={() => startEdit(pairing.id)}><Pencil size={13} />แก้ไข</Button>
                      {onPenalty && <Button size="sm" variant="danger" title="ลงดาบ (บังคับแพ้ทั้งคู่)" onClick={() => onPenalty(pairing)}>ลงดาบ</Button>}
                    </div>
                  ) : (
                    <div className="cell-action__group">
                      <Button size="sm" variant="success" disabled={!outcome || !changed || saving || savingAll} onClick={() => void saveRow(pairing)}>{saving ? <LoaderCircle className="loading-spinner" size={13} /> : saved ? <Check size={13} /> : <Save size={13} />}เซฟ</Button>
                      {saved && isEditing && <Button size="sm" variant="ghost" aria-label="ยกเลิกแก้ไข" disabled={saving || savingAll} onClick={() => cancelEdit(pairing.id)}><X size={13} /></Button>}
                      {onPenalty && <Button size="sm" variant="danger" title="ลงดาบ (บังคับแพ้ทั้งคู่)" onClick={() => onPenalty(pairing)}>ลงดาบ</Button>}
                    </div>
                  )}
                </td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>

    </div>
  );
}

/** Read-only twin of the entry grid: same Excel look, no score inputs, no save/edit, diff-range filter. */
export function ResultViewGrid({ pairings, players, storageKey, onFilterActiveChange }: {
  pairings: Pairing[];
  players: Map<string, Player>;
  storageKey: string;
  onFilterActiveChange?: (active: boolean) => void;
}) {
  const controls = useColumnControls();
  const scoreWidth = useMemo(() => {
    const maxCharacters = pairings.reduce((largest, pairing) => Math.max(
      largest,
      pairing.resultType === "PENALTY" ? 1 : String(pairing.scoreOne ?? "").length,
      pairing.resultType === "PENALTY" ? 1 : String(pairing.scoreTwo ?? "").length,
    ), 1);
    // 64px keeps the complete Thai header visible on portrait phones. Longer score values
    // grow the column further instead of being clipped into the adjacent border.
    return Math.max(64, Math.min(86, maxCharacters * 9 + 14));
  }, [pairings]);
  const viewColumns = useMemo(() => VIEW_COLUMNS.map((column) =>
    column.key === "score1" || column.key === "score2"
      ? { ...column, min: scoreWidth, width: scoreWidth, fitMin: scoreWidth }
      : column
  ), [scoreWidth]);
  const { colWidths, totalWidth, scrollRef, startResize } = useResizableColumns(viewColumns, `${storageKey}:content-score-v1:${scoreWidth}`);
  const filterActiveCallback = useRef(onFilterActiveChange);
  filterActiveCallback.current = onFilterActiveChange;
  useEffect(() => { filterActiveCallback.current?.(controls.active); }, [controls.active]);

  const accessors = useMemo<Record<string, (pairing: Pairing) => string | number>>(() => ({
    pair: (pairing) => pairing.tableNumber,
    id1: (pairing) => pairing.playerOneId ? players.get(pairing.playerOneId)?.id ?? "—" : "—",
    name1: (pairing) => {
      const player = pairing.playerOneId ? players.get(pairing.playerOneId) : undefined;
      return player ? `${player.firstName} ${player.lastName}` : "—";
    },
    school1: (pairing) => pairing.playerOneId ? players.get(pairing.playerOneId)?.school ?? "—" : "—",
    id2: (pairing) => pairing.playerTwoId ? players.get(pairing.playerTwoId)?.id ?? "—" : "—",
    name2: (pairing) => {
      const player = pairing.playerTwoId ? players.get(pairing.playerTwoId) : undefined;
      return player ? `${player.firstName} ${player.lastName}` : "—";
    },
    school2: (pairing) => pairing.playerTwoId ? players.get(pairing.playerTwoId)?.school ?? "—" : "—",
    score1: (pairing) => pairing.scoreOne ?? "—",
    score2: (pairing) => pairing.scoreTwo ?? "—",
    diff: (pairing) => recordedDiff(pairing) ?? "—",
    winner: (pairing) => pairing.resultType === "DRAW" ? "เสมอ" : pairing.winnerId ?? "—",
  }), [players]);
  const uniqueValues = useMemo(
    () => uniqueColumnValues(pairings, accessors, VIEW_FILTER_KEYS),
    [pairings, accessors],
  );
  const filtered = useMemo(
    () => applyColumnControls(pairings, accessors, controls.filters, controls.sort, controls.textFilters, ["id1", "id2", "winner"]),
    [pairings, accessors, controls.filters, controls.sort, controls.textFilters],
  );

  return (
    <div className="entry-grid-wrap">
      <div className="entry-grid-scroll" ref={scrollRef}>
        <table className="entry-grid entry-grid--match" style={{ width: totalWidth }}>
          <GridHead columns={viewColumns} colWidths={colWidths} startResize={startResize} excel={{
            sortable: (key) => VIEW_FILTER_KEYS.includes(key),
            filterable: (key) => VIEW_FILTER_KEYS.includes(key),
            sort: controls.sort,
            filters: controls.filters,
            textFilters: controls.textFilters,
            editingKey: controls.editingKey,
            uniqueValues,
            openKey: controls.openKey,
            openAnchor: controls.openAnchor,
            onSetSort: controls.setColumnSort,
            onStartTextFilter: controls.startTextFilter,
            onTextFilter: controls.setTextFilter,
            onStopTextFilter: () => controls.setEditingKey(null),
            onOpenFilter: controls.openFilter,
            onApply: (key, values) => controls.applyFilter(key, values, uniqueValues[key]?.length ?? 0),
            onClear: controls.clearFilter,
            onClose: () => controls.setOpenKey(null),
          }} />
          <tbody>
            {filtered.length === 0 ? (
              <tr><td className="egrid-empty" colSpan={viewColumns.length}><strong>ไม่พบคู่ตามตัวกรอง</strong><span>กด “ล้างตัวกรอง” ด้านบนเพื่อดูทุกคู่</span></td></tr>
            ) : filtered.map((pairing) => {
              const p1 = pairing.playerOneId ? players.get(pairing.playerOneId) : undefined;
              const p2 = pairing.playerTwoId ? players.get(pairing.playerTwoId) : undefined;
              const recorded = isRecorded(pairing);
              const draw = pairing.resultType === "DRAW";
              const penalty = pairing.resultType === "PENALTY";
              const diff = recordedDiff(pairing);
              const absentText = recorded ? "บาย" : "รอคู่แข่ง";
              return <tr key={pairing.id} className="egrid-row">
                <td className="egrid-td egrid-td--center cell-pair">{pairing.tableNumber}</td>
                <td className="egrid-td cell-id">{p1?.id ?? "—"}</td>
                <td className="egrid-td cell-person-name" title={`${p1?.firstName ?? ""} ${p1?.lastName ?? ""}`}>{p1 ? `${p1.firstName} ${p1.lastName}` : absentText}</td>
                <td className="egrid-td cell-person-school" title={p1?.school}>{p1?.school ?? "—"}</td>
                <td className="egrid-td cell-id">{p2?.id ?? "—"}</td>
                <td className="egrid-td cell-person-name" title={`${p2?.firstName ?? ""} ${p2?.lastName ?? ""}`}>{p2 ? `${p2.firstName} ${p2.lastName}` : absentText}</td>
                <td className="egrid-td cell-person-school" title={p2?.school}>{p2?.school ?? "—"}</td>
                <td className="egrid-td egrid-td--center cell-score">{penalty ? "-" : pairing.scoreOne ?? "—"}</td>
                <td className="egrid-td egrid-td--center cell-score">{penalty ? "-" : pairing.scoreTwo ?? "—"}</td>
                <td className={`egrid-td egrid-td--center cell-diff cell-diff--${!recorded ? "pending" : penalty ? "penalty" : draw ? "draw" : "win"}`}>{!recorded ? "—" : penalty ? `-${diff ?? 0}` : draw ? "0" : `${diff}`}</td>
                <td className={`egrid-td${recorded && !draw && !penalty ? " cell-id" : ""}`}>{!recorded ? "—" : penalty ? "ลงดาบ" : draw ? "เสมอ" : pairing.winnerId ?? "—"}</td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>

    </div>
  );
}
