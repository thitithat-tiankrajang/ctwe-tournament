"use client";

import { Check, LoaderCircle, Pencil, Save, SaveAll, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { Pairing, Player } from "@/domain/tournament/types";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { GridHead, GridPagination, usePagination, useResizableColumns, type GridColumnBase } from "@/ui/components/data-grid";

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

export function ResultEntryGrid({ gameNumber, slots, players, maxDiff, pendingNote, storageKey, onSubmit }: {
  gameNumber: number;
  slots: EntrySlot[];
  players: Map<string, Player>;
  maxDiff: number;
  pendingNote?: string;
  /** Identifies the table so user-resized column widths persist per card+game in sessionStorage. */
  storageKey: string;
  onSubmit: (pairing: Pairing, scoreOne: number, scoreTwo: number, editExisting: boolean) => Promise<void>;
}) {
  const [fPair, setFPair] = useState(""); const [fId, setFId] = useState(""); const [fSchool, setFSchool] = useState(""); const [fName, setFName] = useState("");
  const [status, setStatus] = useState<"all" | RowStatus>("all");
  const [drafts, setDrafts] = useState<Record<string, { one: string; two: string }>>({});
  const [editing, setEditing] = useState<Set<string>>(new Set());
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [failedIds, setFailedIds] = useState<Set<string>>(new Set());
  const [savingAll, setSavingAll] = useState(false);
  const { colWidths, totalWidth, scrollRef, startResize } = useResizableColumns(EDIT_COLUMNS, storageKey);

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

  const filtered = useMemo(() => rows.filter((row) => {
    if (status !== "all" && row.status !== status) return false;
    if (fPair.trim() && !`${row.slot.tableNumber}`.includes(fPair.trim())) return false;
    const p1 = row.pairing?.playerOneId ? players.get(row.pairing.playerOneId) : undefined;
    const p2 = row.pairing?.playerTwoId ? players.get(row.pairing.playerTwoId) : undefined;
    const idText = `${p1?.id ?? ""} ${p2?.id ?? ""}`.toLocaleLowerCase("th");
    const schoolText = `${p1?.school ?? ""} ${p2?.school ?? ""}`.toLocaleLowerCase("th");
    const nameText = `${p1?.firstName ?? ""} ${p1?.lastName ?? ""} ${p2?.firstName ?? ""} ${p2?.lastName ?? ""}`.toLocaleLowerCase("th");
    if (fId.trim() && !idText.includes(fId.trim().toLocaleLowerCase("th"))) return false;
    if (fSchool.trim() && !schoolText.includes(fSchool.trim().toLocaleLowerCase("th"))) return false;
    if (fName.trim() && !nameText.includes(fName.trim().toLocaleLowerCase("th"))) return false;
    return true;
  }), [rows, status, fPair, fId, fSchool, fName, players]);

  const { pageSize, setPageSize, page, setPage, size, totalPages } = usePagination(filtered.length, `${fPair}|${fId}|${fSchool}|${fName}|${status}`);
  const pageRows = filtered.slice((page - 1) * size, page * size);

  const total = slots.length;
  const start = filtered.length === 0 ? 0 : (page - 1) * size + 1;
  const end = Math.min(page * size, filtered.length);
  const filtersActive = Boolean(fPair || fId || fSchool || fName) || status !== "all";
  const savedCount = rows.filter((row) => row.status === "saved").length;
  const dirtyCount = rows.filter((row) => row.status === "dirty").length;
  const filteredSavable = filtered.filter((row) => isCompletePairing(row.pairing) && row.status === "dirty" && calcOutcome(row.one ?? "", row.two ?? "", maxDiff, row.pairing.playerOneId, row.pairing.playerTwoId));

  const setDraft = (id: string, field: "one" | "two", value: string, base: { one: string; two: string }) => {
    setFailedIds((prev) => { if (!prev.has(id)) return prev; const next = new Set(prev); next.delete(id); return next; });
    setDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] ?? base), [field]: value } }));
  };

  const saveRow = async (pairing: Pairing): Promise<boolean> => {
    if (!isCompletePairing(pairing)) return false;
    const { one, two } = valueOf(pairing);
    const outcome = calcOutcome(one, two, maxDiff, pairing.playerOneId, pairing.playerTwoId);
    if (!outcome) return false;
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
      <div className="entry-toolbar">
        <div className="entry-filter"><label htmlFor={`f-pair-${gameNumber}`}>หาคู่ที่</label><input id={`f-pair-${gameNumber}`} inputMode="numeric" value={fPair} placeholder="เลขคู่" onChange={(event) => setFPair(event.target.value)} /></div>
        <div className="entry-filter"><label htmlFor={`f-id-${gameNumber}`}>หารหัส</label><input id={`f-id-${gameNumber}`} value={fId} placeholder="เช่น P0042" onChange={(event) => setFId(event.target.value)} /></div>
        <div className="entry-filter"><label htmlFor={`f-school-${gameNumber}`}>หาโรงเรียน</label><input id={`f-school-${gameNumber}`} value={fSchool} placeholder="ชื่อสถาบัน" onChange={(event) => setFSchool(event.target.value)} /></div>
        <div className="entry-filter"><label htmlFor={`f-name-${gameNumber}`}>หาจากชื่อ</label><input id={`f-name-${gameNumber}`} value={fName} placeholder="ชื่อหรือนามสกุล" onChange={(event) => setFName(event.target.value)} /></div>
        <div className="entry-filter"><label htmlFor={`f-status-${gameNumber}`}>กรองสถานะ</label><select id={`f-status-${gameNumber}`} className="select" value={status} onChange={(event) => setStatus(event.target.value as "all" | RowStatus)}>{STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>
        <div className="entry-toolbar__actions">
          <Button variant="secondary" size="sm" disabled={!filtersActive} onClick={() => { setFPair(""); setFId(""); setFSchool(""); setFName(""); setStatus("all"); }}><X size={14} />ล้างตัวกรอง</Button>
          <Button size="sm" variant="success" disabled={savingAll || filteredSavable.length === 0} onClick={() => void saveAll()}>{savingAll ? <LoaderCircle className="loading-spinner" size={14} /> : <SaveAll size={14} />}บันทึกทั้งหมด ({filteredSavable.length})</Button>
        </div>
      </div>
      <div className="entry-grid-meta">
        <span className="entry-grid-meta__tags"><Badge tone="success">เซฟแล้ว {savedCount}</Badge>{dirtyCount > 0 && <Badge tone="warning">ยังไม่เซฟ {dirtyCount}</Badge>}</span>
      </div>

      <div className="entry-grid-scroll" ref={scrollRef}>
        <table className="entry-grid" style={{ width: totalWidth }}>
          <GridHead columns={EDIT_COLUMNS} colWidths={colWidths} startResize={startResize} />
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
                  <td className="egrid-td"><input className="egrid-score" disabled placeholder="—" /></td>
                  <td className="egrid-td"><input className="egrid-score" disabled placeholder="—" /></td>
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
              return <tr key={pairing.id} className={`egrid-row${changed ? " egrid-row--dirty" : ""}${locked ? " egrid-row--locked" : ""}${failed ? " egrid-row--failed" : ""}`}>
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
