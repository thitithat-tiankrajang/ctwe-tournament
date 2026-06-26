"use client";

import { AlertTriangle, Check, CheckCircle2, LoaderCircle, Pencil, Save, SaveAll, Shuffle, Undo2, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { Pairing, Player } from "@/domain/tournament/types";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { applyColumnControls, GridHead, GridPagination, uniqueColumnValues, usePagination, useColumnControls, useResizableColumns, type GridColumnBase } from "@/ui/components/data-grid";

/** Columns of the result-entry grid that get Excel sort + filter (player code / name / school / pair). */
const ENTRY_FILTER_KEYS = ["pair", "id1", "name1", "school1", "id2", "name2", "school2"];

export interface EntrySlot {
  /** Table/couple number; stable even before the pairing exists (PAIR_RESULT destination). */
  tableNumber: number;
  /** Undefined while the matchup is still unknown (waiting on the source game). */
  pairing?: Pairing;
}

type RowStatus = "pending" | "empty" | "dirty" | "saved";

const EDIT_COLUMNS: GridColumnBase[] = [
  { key: "pair", label: "คู่", min: 44, width: 58 },
  { key: "id1", label: "รหัสฝ่ายที่ 1", min: 76, width: 104 },
  { key: "name1", label: "ชื่อ-นามสกุล", min: 110, width: 184 },
  { key: "school1", label: "โรงเรียน/สถาบัน", min: 110, width: 172 },
  { key: "id2", label: "รหัสฝ่ายที่ 2", min: 76, width: 104 },
  { key: "name2", label: "ชื่อ-นามสกุล", min: 110, width: 184 },
  { key: "school2", label: "โรงเรียน/สถาบัน", min: 110, width: 172 },
  { key: "score1", label: "คะแนนฝ่ายที่ 1", min: 92, width: 120 },
  { key: "score2", label: "คะแนนฝ่ายที่ 2", min: 92, width: 120 },
  { key: "diff", label: "สรุปผลต่าง", min: 96, width: 140 },
  { key: "action", label: "จัดการ", min: 104, width: 138 },
];

const VIEW_COLUMNS: GridColumnBase[] = [
  { key: "pair", label: "คู่", min: 44, width: 58 },
  { key: "id1", label: "รหัสฝ่ายที่ 1", min: 76, width: 104 },
  { key: "name1", label: "ชื่อ-นามสกุล", min: 110, width: 184 },
  { key: "school1", label: "โรงเรียน/สถาบัน", min: 110, width: 172 },
  { key: "id2", label: "รหัสฝ่ายที่ 2", min: 76, width: 104 },
  { key: "name2", label: "ชื่อ-นามสกุล", min: 110, width: 184 },
  { key: "school2", label: "โรงเรียน/สถาบัน", min: 110, width: 172 },
  { key: "score1", label: "คะแนนฝ่ายที่ 1", min: 88, width: 110 },
  { key: "score2", label: "คะแนนฝ่ายที่ 2", min: 88, width: 110 },
  { key: "diff", label: "Diff", min: 76, width: 96 },
  { key: "winner", label: "รหัสผู้ชนะ", min: 92, width: 120 },
];

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

interface Outcome { resultType: "WIN" | "DRAW"; winnerId?: string; diff: number; }

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

export function ResultEntryGrid({ gameNumber, slots, players, maxDiff, pendingNote, storageKey, onSubmit, pairingEdit }: {
  gameNumber: number;
  slots: EntrySlot[];
  players: Map<string, Player>;
  maxDiff: number;
  pendingNote?: string;
  /** Identifies the table so user-resized column widths persist per card+game in sessionStorage. */
  storageKey: string;
  onSubmit: (pairing: Pairing, scoreOne: number, scoreTwo: number, editExisting: boolean) => Promise<void>;
  /** Director-only pairing edit during result collection: swap (>=1 result) or unpair-to-preview (0 results). */
  pairingEdit?: { onSwap: (a: string, b: string) => Promise<boolean>; onUnpair: () => Promise<void> };
}) {
  const controls = useColumnControls();
  const [status, setStatus] = useState<"all" | RowStatus>("all");
  const [drafts, setDrafts] = useState<Record<string, { one: string; two: string }>>({});
  const [editing, setEditing] = useState<Set<string>>(new Set());
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [failedIds, setFailedIds] = useState<Set<string>>(new Set());
  const [savingAll, setSavingAll] = useState(false);
  const [swapOpen, setSwapOpen] = useState(false);
  const [swapA, setSwapA] = useState(""); const [swapB, setSwapB] = useState(""); const [swapping, setSwapping] = useState(false);
  // Quick key-in bar (รหัส A → คะแนน A → รหัส B → คะแนน B → save) + result toast/highlight.
  const [qIdA, setQIdA] = useState(""); const [qScoreA, setQScoreA] = useState("");
  const [qIdB, setQIdB] = useState(""); const [qScoreB, setQScoreB] = useState("");
  const [quickSaving, setQuickSaving] = useState(false);
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const idARef = useRef<HTMLInputElement>(null); const scoreARef = useRef<HTMLInputElement>(null);
  const idBRef = useRef<HTMLInputElement>(null); const scoreBRef = useRef<HTMLInputElement>(null);
  const saveBtnRef = useRef<HTMLButtonElement>(null);
  const { colWidths, totalWidth, scrollRef, startResize } = useResizableColumns(EDIT_COLUMNS, storageKey);

  // Any "this is the pair" highlight + alert clears when the user closes it or keeps entering.
  const clearFlash = () => { setToast(null); setHighlightId(null); };

  const valueOf = (pairing: Pairing) => {
    const draft = drafts[pairing.id];
    return { one: draft?.one ?? pairing.scoreOne?.toString() ?? "", two: draft?.two ?? pairing.scoreTwo?.toString() ?? "" };
  };

  const rows = useMemo(() => slots.map((slot) => {
    const pairing = slot.pairing;
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
    const byColumn = applyColumnControls(rows, accessors, controls.filters, controls.sort);
    return status === "all" ? byColumn : byColumn.filter((row) => row.status === status);
  }, [rows, accessors, controls.filters, controls.sort, status]);

  const { pageSize, setPageSize, page, setPage, size, totalPages } = usePagination(filtered.length, `${JSON.stringify(controls.filters)}|${controls.sort ? controls.sort.key + controls.sort.dir : ""}|${status}`);
  const pageRows = filtered.slice((page - 1) * size, page * size);

  const total = slots.length;
  const start = filtered.length === 0 ? 0 : (page - 1) * size + 1;
  const end = Math.min(page * size, filtered.length);
  const filtersActive = controls.active || status !== "all";
  const savedCount = rows.filter((row) => row.status === "saved").length;
  const dirtyCount = rows.filter((row) => row.status === "dirty").length;
  const filteredSavable = filtered.filter((row) => isCompletePairing(row.pairing) && row.status === "dirty" && calcOutcome(row.one ?? "", row.two ?? "", maxDiff, row.pairing.playerOneId, row.pairing.playerTwoId));

  const setDraft = (id: string, field: "one" | "two", value: string, base: { one: string; two: string }) => {
    clearFlash();
    setFailedIds((prev) => { if (!prev.has(id)) return prev; const next = new Set(prev); next.delete(id); return next; });
    setDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] ?? base), [field]: value } }));
  };

  const saveValues = async (pairing: CompletePairing, one: string, two: string): Promise<boolean> => {
    if (!calcOutcome(one, two, maxDiff, pairing.playerOneId, pairing.playerTwoId)) return false;
    setSavingIds((prev) => new Set(prev).add(pairing.id));
    try {
      await onSubmit(pairing, Number(one), Number(two), isRecorded(pairing));
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

  const saveRow = async (pairing: Pairing): Promise<boolean> => {
    if (!isCompletePairing(pairing)) return false;
    const { one, two } = valueOf(pairing);
    return saveValues(pairing, one, two);
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
    const a = qIdA.trim().toUpperCase(); const b = qIdB.trim().toUpperCase();
    if (!a || !b) { setHighlightId(null); setToast({ type: "error", message: "กรุณากรอกรหัสทั้งสองฝ่ายก่อนบันทึก" }); return; }
    const match = rows.find((row) => isCompletePairing(row.pairing)
      && ((row.pairing.playerOneId.toUpperCase() === a && row.pairing.playerTwoId.toUpperCase() === b)
        || (row.pairing.playerOneId.toUpperCase() === b && row.pairing.playerTwoId.toUpperCase() === a)));
    if (!match || !isCompletePairing(match.pairing)) {
      setHighlightId(null);
      setToast({ type: "error", message: `คู่นี้ไม่เจอกันจริงในเกม ${gameNumber} — รหัส ${a} กับ ${b} ไม่ใช่คู่ที่จับไว้ กรุณาตรวจสอบรหัสอีกครั้ง` });
      return;
    }
    const pairing = match.pairing;
    const aIsOne = pairing.playerOneId.toUpperCase() === a;
    const oneScore = aIsOne ? qScoreA : qScoreB;
    const twoScore = aIsOne ? qScoreB : qScoreA;
    if (!calcOutcome(oneScore, twoScore, maxDiff, pairing.playerOneId, pairing.playerTwoId)) {
      setToast({ type: "error", message: "คะแนนไม่ถูกต้อง — กรอกเป็นจำนวนเต็ม ≥ 0 ทั้งสองฝ่าย" });
      return;
    }
    setQuickSaving(true);
    const ok = await saveValues(pairing, oneScore, twoScore);
    setQuickSaving(false);
    if (!ok) { setToast({ type: "error", message: "บันทึกไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" }); return; }
    const idx = filtered.findIndex((row) => row.pairing?.id === pairing.id);
    if (idx >= 0) setPage(Math.floor(idx / size) + 1);
    setHighlightId(pairing.id);
    const p1 = players.get(pairing.playerOneId); const p2 = players.get(pairing.playerTwoId);
    setToast({ type: "success", message: `บันทึกคู่ที่ ${pairing.tableNumber} แล้ว · ${p1?.id} ${oneScore} : ${twoScore} ${p2?.id}` });
    setQIdA(""); setQScoreA(""); setQIdB(""); setQScoreB("");
    idARef.current?.focus();
  };

  const doSwap = async () => {
    if (!pairingEdit || !swapA.trim() || !swapB.trim()) return;
    setSwapping(true);
    try {
      if (await pairingEdit.onSwap(swapA.trim().toUpperCase(), swapB.trim().toUpperCase())) { setSwapA(""); setSwapB(""); setSwapOpen(false); }
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
      {toast && (
        <div className={`entry-toast entry-toast--${toast.type}`} role="alert" aria-live="assertive">
          {toast.type === "success" ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
          <span>{toast.message}</span>
          <button type="button" className="entry-toast__close" aria-label="ปิดการแจ้งเตือน" onClick={clearFlash}><X size={15} /></button>
        </div>
      )}
      <div className="entry-keyin">
        <span className="entry-keyin__label">คีย์เร็ว</span>
        <input ref={idARef} className="entry-keyin__id" placeholder="รหัส A" value={qIdA} aria-label="รหัสฝ่าย A"
          onChange={(event) => { clearFlash(); setQIdA(event.target.value.toUpperCase()); }}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); scoreARef.current?.focus(); scoreARef.current?.select(); } }} />
        <input ref={scoreARef} type="number" inputMode="numeric" min={0} className="entry-keyin__score" placeholder="คะแนน A" value={qScoreA} aria-label="คะแนนฝ่าย A"
          onChange={(event) => { clearFlash(); setQScoreA(event.target.value); }} onFocus={(event) => event.target.select()}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); idBRef.current?.focus(); idBRef.current?.select(); } }} />
        <span className="entry-keyin__vs">พบ</span>
        <input ref={idBRef} className="entry-keyin__id" placeholder="รหัส B" value={qIdB} aria-label="รหัสฝ่าย B"
          onChange={(event) => { clearFlash(); setQIdB(event.target.value.toUpperCase()); }}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); scoreBRef.current?.focus(); scoreBRef.current?.select(); } }} />
        <input ref={scoreBRef} type="number" inputMode="numeric" min={0} className="entry-keyin__score" placeholder="คะแนน B" value={qScoreB} aria-label="คะแนนฝ่าย B"
          onChange={(event) => { clearFlash(); setQScoreB(event.target.value); }} onFocus={(event) => event.target.select()}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); saveBtnRef.current?.focus(); } }} />
        <Button ref={saveBtnRef} size="sm" variant="success" disabled={quickSaving} onClick={() => void quickSave()}>{quickSaving ? <LoaderCircle className="loading-spinner" size={14} /> : <Save size={14} />}บันทึกคะแนน</Button>
      </div>
      <div className="entry-grid-meta">
        <span className="entry-grid-meta__tags"><Badge tone="success">เซฟแล้ว {savedCount}</Badge>{dirtyCount > 0 && <Badge tone="warning">ยังไม่เซฟ {dirtyCount}</Badge>}</span>
        <div className="entry-grid-meta__actions">
          <label htmlFor={`f-status-${gameNumber}`}>สถานะ</label>
          <select id={`f-status-${gameNumber}`} className="select" value={status} onChange={(event) => setStatus(event.target.value as "all" | RowStatus)}>{STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
          <Button variant="secondary" size="sm" disabled={!filtersActive} onClick={() => { controls.clearAll(); setStatus("all"); }}><X size={14} />ล้างตัวกรอง</Button>
          <Button size="sm" variant="success" disabled={savingAll || filteredSavable.length === 0} onClick={() => void saveAll()}>{savingAll ? <LoaderCircle className="loading-spinner" size={14} /> : <SaveAll size={14} />}บันทึกทั้งหมด ({filteredSavable.length})</Button>
          {pairingEdit && (savedCount > 0
            ? <Button size="sm" variant="secondary" onClick={() => setSwapOpen((open) => !open)} title="สลับผู้เล่นที่ยังไม่กรอกผล (เฉพาะผู้อำนวยการ)"><Shuffle size={14} />สลับผู้เล่น</Button>
            : <Button size="sm" variant="secondary" onClick={() => void pairingEdit.onUnpair()} title="ยกเลิกการจับคู่ กลับไปหน้าแก้ pairing (เฉพาะผู้อำนวยการ)"><Undo2 size={14} />แก้การจับคู่</Button>
          )}
        </div>
      </div>
      {pairingEdit && savedCount > 0 && swapOpen && (
        <div className="entry-swap">
          <span className="entry-swap__label">สลับผู้เล่น (เฉพาะคู่ที่ยังไม่กรอกผล)</span>
          <input className="entry-keyin__id" placeholder="รหัส A" value={swapA} aria-label="รหัสผู้เล่น A ที่จะสลับ" onChange={(event) => setSwapA(event.target.value.toUpperCase())} />
          <span className="entry-keyin__vs">↔</span>
          <input className="entry-keyin__id" placeholder="รหัส B" value={swapB} aria-label="รหัสผู้เล่น B ที่จะสลับ" onChange={(event) => setSwapB(event.target.value.toUpperCase())} />
          <Button size="sm" variant="success" disabled={swapping || !swapA.trim() || !swapB.trim()} onClick={() => void doSwap()}>{swapping ? <LoaderCircle className="loading-spinner" size={14} /> : <Shuffle size={14} />}สลับ</Button>
          <Button size="sm" variant="ghost" aria-label="ปิด" onClick={() => setSwapOpen(false)}><X size={14} /></Button>
        </div>
      )}

      <div className="entry-grid-scroll" ref={scrollRef}>
        <table className="entry-grid" style={{ width: totalWidth }}>
          <GridHead columns={EDIT_COLUMNS} colWidths={colWidths} startResize={startResize} excel={{
            sortable: (key) => ENTRY_FILTER_KEYS.includes(key),
            filterable: (key) => ENTRY_FILTER_KEYS.includes(key),
            sort: controls.sort,
            filters: controls.filters,
            uniqueValues,
            openKey: controls.openKey,
            openAnchor: controls.openAnchor,
            onToggleSort: controls.toggleSort,
            onOpenFilter: controls.openFilter,
            onApply: (key, values) => controls.applyFilter(key, values, uniqueValues[key]?.length ?? 0),
            onClear: controls.clearFilter,
            onClose: () => controls.setOpenKey(null),
          }} />
          <tbody>
            {pageRows.length === 0 ? (
              <tr><td className="egrid-empty" colSpan={EDIT_COLUMNS.length}><strong>ไม่พบคู่ตามตัวกรอง</strong><span>ลองล้างตัวกรองเพื่อดูทุกคู่</span></td></tr>
            ) : pageRows.map((row) => {
              const { slot, pairing } = row;
              if (!isCompletePairing(pairing)) {
                const p1 = pairing?.playerOneId ? players.get(pairing.playerOneId) : undefined;
                const p2 = pairing?.playerTwoId ? players.get(pairing.playerTwoId) : undefined;
                const waitingText = pairing ? "รอคู่แข่งจากอีก row" : "รอผลจากเกมก่อนหน้า";
                return <tr key={pairing?.id ?? `pending-${slot.tableNumber}`} className="egrid-row egrid-row--pending">
                  <td className="egrid-td numeric cell-pair">{slot.tableNumber}</td>
                  <td className="egrid-td cell-id">{p1?.id ?? "—"}</td>
                  <td className="egrid-td" title={`${p1?.firstName ?? ""} ${p1?.lastName ?? ""}`}>{p1 ? `${p1.firstName} ${p1.lastName}` : waitingText}</td>
                  <td className="egrid-td" title={p1?.school}>{p1?.school ?? "—"}</td>
                  <td className="egrid-td cell-id">{p2?.id ?? "—"}</td>
                  <td className="egrid-td" title={`${p2?.firstName ?? ""} ${p2?.lastName ?? ""}`}>{p2 ? `${p2.firstName} ${p2.lastName}` : waitingText}</td>
                  <td className="egrid-td" title={p2?.school}>{p2?.school ?? "—"}</td>
                  <td className="egrid-td"><input className="egrid-score" disabled value="" readOnly placeholder="—" /></td>
                  <td className="egrid-td"><input className="egrid-score" disabled value="" readOnly placeholder="—" /></td>
                  <td className="egrid-td cell-diff">—</td>
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
                <td className="egrid-td numeric cell-pair">{pairing.tableNumber}</td>
                <td className="egrid-td cell-id">{p1?.id}</td>
                <td className="egrid-td" title={`${p1?.firstName ?? ""} ${p1?.lastName ?? ""}`}>{p1?.firstName} {p1?.lastName}</td>
                <td className="egrid-td" title={p1?.school}>{p1?.school}</td>
                <td className="egrid-td cell-id">{p2?.id}</td>
                <td className="egrid-td" title={`${p2?.firstName ?? ""} ${p2?.lastName ?? ""}`}>{p2?.firstName} {p2?.lastName}</td>
                <td className="egrid-td" title={p2?.school}>{p2?.school}</td>
                <td className="egrid-td"><input className="egrid-score" type="number" inputMode="numeric" min={0} aria-label={`คะแนน ${p1?.id}`} placeholder={p1?.id} value={one} disabled={disabled} onChange={(event) => setDraft(pairing.id, "one", event.target.value, base)} onFocus={(event) => event.target.select()} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); focusNext(event.currentTarget, "other"); } }} /></td>
                <td className="egrid-td"><input className="egrid-score" type="number" inputMode="numeric" min={0} aria-label={`คะแนน ${p2?.id}`} placeholder={p2?.id} value={two} disabled={disabled} onChange={(event) => setDraft(pairing.id, "two", event.target.value, base)} onFocus={(event) => event.target.select()} onKeyDown={async (event) => { if (event.key !== "Enter") return; event.preventDefault(); const origin = event.currentTarget; if (await saveRow(pairing)) focusNext(origin, "next"); }} /></td>
                <td className={`egrid-td cell-diff cell-diff--${outcome ? outcome.resultType.toLowerCase() : "pending"}`}>{outcome ? (outcome.resultType === "DRAW" ? "เสมอ · 0" : `${outcome.winnerId} · ±${outcome.diff}`) : "—"}</td>
                <td className="egrid-td cell-action">
                  {locked ? (
                    <Button size="sm" variant="secondary" onClick={() => startEdit(pairing.id)}><Pencil size={13} />แก้ไข</Button>
                  ) : (
                    <div className="cell-action__group">
                      <Button size="sm" variant="success" disabled={!outcome || !changed || saving || savingAll} onClick={() => void saveRow(pairing)}>{saving ? <LoaderCircle className="loading-spinner" size={13} /> : saved ? <Check size={13} /> : <Save size={13} />}เซฟ</Button>
                      {saved && isEditing && <Button size="sm" variant="ghost" aria-label="ยกเลิกแก้ไข" disabled={saving || savingAll} onClick={() => cancelEdit(pairing.id)}><X size={13} /></Button>}
                    </div>
                  )}
                </td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>

      {pendingNote && rows.some((row) => row.status === "pending") && <div className="notice notice--info entry-grid-note"><p><span>{pendingNote}</span></p></div>}

      <GridPagination idBase={`edit-${gameNumber}`} pageSize={pageSize} setPageSize={setPageSize} page={page} totalPages={totalPages} setPage={setPage} total={filtered.length} grandTotal={total} start={start} end={end} unit="คู่" />
    </div>
  );
}

/** Read-only twin of the entry grid: same Excel look, no score inputs, no save/edit, diff-range filter. */
export function ResultViewGrid({ pairings, players, storageKey }: {
  pairings: Pairing[];
  players: Map<string, Player>;
  storageKey: string;
}) {
  const [fPair, setFPair] = useState(""); const [fId, setFId] = useState(""); const [fSchool, setFSchool] = useState(""); const [fName, setFName] = useState("");
  const [dMin, setDMin] = useState(""); const [dMax, setDMax] = useState("");
  const { colWidths, totalWidth, scrollRef, startResize } = useResizableColumns(VIEW_COLUMNS, storageKey);

  const filtered = useMemo(() => pairings.filter((pairing) => {
    if (fPair.trim() && !`${pairing.tableNumber}`.includes(fPair.trim())) return false;
    const p1 = pairing.playerOneId ? players.get(pairing.playerOneId) : undefined;
    const p2 = pairing.playerTwoId ? players.get(pairing.playerTwoId) : undefined;
    const idText = `${p1?.id ?? ""} ${p2?.id ?? ""}`.toLocaleLowerCase("th");
    const schoolText = `${p1?.school ?? ""} ${p2?.school ?? ""}`.toLocaleLowerCase("th");
    const nameText = `${p1?.firstName ?? ""} ${p1?.lastName ?? ""} ${p2?.firstName ?? ""} ${p2?.lastName ?? ""}`.toLocaleLowerCase("th");
    if (fId.trim() && !idText.includes(fId.trim().toLocaleLowerCase("th"))) return false;
    if (fSchool.trim() && !schoolText.includes(fSchool.trim().toLocaleLowerCase("th"))) return false;
    if (fName.trim() && !nameText.includes(fName.trim().toLocaleLowerCase("th"))) return false;
    const min = dMin.trim() === "" ? null : Number(dMin);
    const max = dMax.trim() === "" ? null : Number(dMax);
    if (min !== null || max !== null) {
      const diff = recordedDiff(pairing);
      if (diff === null) return false;
      if (min !== null && diff < min) return false;
      if (max !== null && diff > max) return false;
    }
    return true;
  }), [pairings, players, fPair, fId, fSchool, fName, dMin, dMax]);

  const { pageSize, setPageSize, page, setPage, size, totalPages } = usePagination(filtered.length, `${fPair}|${fId}|${fSchool}|${fName}|${dMin}|${dMax}`);
  const pageRows = filtered.slice((page - 1) * size, page * size);
  const start = filtered.length === 0 ? 0 : (page - 1) * size + 1;
  const end = Math.min(page * size, filtered.length);
  const filtersActive = Boolean(fPair || fId || fSchool || fName || dMin || dMax);

  return (
    <div className="entry-grid-wrap">
      <div className="entry-toolbar">
        <div className="entry-filter"><label htmlFor={`v-pair-${storageKey}`}>หาคู่ที่</label><input id={`v-pair-${storageKey}`} inputMode="numeric" value={fPair} placeholder="เลขคู่" onChange={(event) => setFPair(event.target.value)} /></div>
        <div className="entry-filter"><label htmlFor={`v-id-${storageKey}`}>หารหัส</label><input id={`v-id-${storageKey}`} value={fId} placeholder="เช่น P0042" onChange={(event) => setFId(event.target.value)} /></div>
        <div className="entry-filter"><label htmlFor={`v-school-${storageKey}`}>หาโรงเรียน</label><input id={`v-school-${storageKey}`} value={fSchool} placeholder="ชื่อสถาบัน" onChange={(event) => setFSchool(event.target.value)} /></div>
        <div className="entry-filter"><label htmlFor={`v-name-${storageKey}`}>หาจากชื่อ</label><input id={`v-name-${storageKey}`} value={fName} placeholder="ชื่อหรือนามสกุล" onChange={(event) => setFName(event.target.value)} /></div>
        <div className="entry-filter"><label htmlFor={`v-dmin-${storageKey}`}>Diff ตั้งแต่</label><input id={`v-dmin-${storageKey}`} type="number" inputMode="numeric" min={0} value={dMin} placeholder="ต่ำสุด" onChange={(event) => setDMin(event.target.value)} /></div>
        <div className="entry-filter"><label htmlFor={`v-dmax-${storageKey}`}>Diff ถึง</label><input id={`v-dmax-${storageKey}`} type="number" inputMode="numeric" min={0} value={dMax} placeholder="สูงสุด" onChange={(event) => setDMax(event.target.value)} /></div>
        <div className="entry-toolbar__actions">
          <Button variant="secondary" size="sm" disabled={!filtersActive} onClick={() => { setFPair(""); setFId(""); setFSchool(""); setFName(""); setDMin(""); setDMax(""); }}><X size={14} />ล้างตัวกรอง</Button>
        </div>
      </div>

      <div className="entry-grid-scroll" ref={scrollRef}>
        <table className="entry-grid" style={{ width: totalWidth }}>
          <GridHead columns={VIEW_COLUMNS} colWidths={colWidths} startResize={startResize} />
          <tbody>
            {pageRows.length === 0 ? (
              <tr><td className="egrid-empty" colSpan={VIEW_COLUMNS.length}><strong>ไม่พบคู่ตามตัวกรอง</strong><span>ลองล้างตัวกรองเพื่อดูทุกคู่</span></td></tr>
            ) : pageRows.map((pairing) => {
              const p1 = pairing.playerOneId ? players.get(pairing.playerOneId) : undefined;
              const p2 = pairing.playerTwoId ? players.get(pairing.playerTwoId) : undefined;
              const recorded = isRecorded(pairing);
              const draw = pairing.resultType === "DRAW";
              const diff = recordedDiff(pairing);
              return <tr key={pairing.id} className="egrid-row">
                <td className="egrid-td numeric cell-pair">{pairing.tableNumber}</td>
                <td className="egrid-td cell-id">{p1?.id ?? "—"}</td>
                <td className="egrid-td" title={`${p1?.firstName ?? ""} ${p1?.lastName ?? ""}`}>{p1 ? `${p1.firstName} ${p1.lastName}` : "รอคู่แข่ง"}</td>
                <td className="egrid-td" title={p1?.school}>{p1?.school ?? "—"}</td>
                <td className="egrid-td cell-id">{p2?.id ?? "—"}</td>
                <td className="egrid-td" title={`${p2?.firstName ?? ""} ${p2?.lastName ?? ""}`}>{p2 ? `${p2.firstName} ${p2.lastName}` : "รอคู่แข่ง"}</td>
                <td className="egrid-td" title={p2?.school}>{p2?.school ?? "—"}</td>
                <td className="egrid-td numeric cell-score">{pairing.scoreOne ?? "—"}</td>
                <td className="egrid-td numeric cell-score">{pairing.scoreTwo ?? "—"}</td>
                <td className={`egrid-td numeric cell-diff cell-diff--${!recorded ? "pending" : draw ? "draw" : "win"}`}>{!recorded ? "—" : draw ? "0" : `±${diff}`}</td>
                <td className={`egrid-td${recorded && !draw ? " cell-id" : ""}`}>{!recorded ? "—" : draw ? "เสมอ" : pairing.winnerId ?? "—"}</td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>

      <GridPagination idBase={`view-${storageKey}`} pageSize={pageSize} setPageSize={setPageSize} page={page} totalPages={totalPages} setPage={setPage} total={filtered.length} grandTotal={pairings.length} start={start} end={end} unit="คู่" />
    </div>
  );
}
