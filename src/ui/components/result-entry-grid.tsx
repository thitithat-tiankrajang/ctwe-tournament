"use client";

import { AlertTriangle, Check, CheckCircle2, LoaderCircle, Megaphone, Pencil, Save, SaveAll, Shuffle, Undo2, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Pairing, Player } from "@/domain/tournament/types";
import { matchesPlayerCode, normalizePlayerCode } from "@/domain/tournament/player-code";
import { isVoidPairing } from "@/domain/tournament/pairing-slot";
import { ScoreInput } from "@/ui/components/score-input";
import { isUnusualScore, scoreWarnings } from "@/domain/tournament/score-warnings";
import { appDialog } from "@/application/ui/dialog";
import { useUnsavedChangesWarning } from "@/application/ui/use-unsaved-changes-warning";
import { useTournamentStore, type RemoteResultChange, type RemoteResultNotice } from "@/application/tournament/store";
import { ConfirmDialog } from "@/ui/components/confirm-dialog";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { applyColumnControls, fieldGroupsOf, GridHead, playerCodeKeysOf, uniqueColumnValues, useColumnControls, useResizableColumns, type GridColumnBase } from "@/ui/components/data-grid";
import { FreshSecretInput } from "@/ui/components/fresh-secret-input";

/** Typed something into a row that has no saved result yet — that counts as actively editing. */
export function hasTypedDraft(draft?: { one: string; two: string }): boolean {
  return Boolean(draft && (draft.one.trim() !== "" || draft.two.trim() !== ""));
}

export interface ConflictNotice {
  change: RemoteResultChange;
  actor: string | null;
  actorRoles: string[];
}

/**
 * Which of a remote result event's pairings this user must be interrupted about.
 *
 * Exactly the pairings they are mid-edit on: in explicit edit mode, or with something typed into a
 * row that has no saved result yet. Everything else syncs silently, which is the pre-existing
 * behaviour and the whole reason this is a filter rather than a blanket warning.
 *
 * Already-queued pairings are skipped so a second event about the same row cannot stack two dialogs
 * for one decision. Pure, so the rule is testable without a DOM.
 */
export function selectConflicts(
  notice: RemoteResultNotice,
  editing: ReadonlySet<string>,
  drafts: Record<string, { one: string; two: string }>,
  queued: readonly ConflictNotice[] = [],
): ConflictNotice[] {
  return notice.changes
    .filter((change) => editing.has(change.pairingId) || hasTypedDraft(drafts[change.pairingId]))
    .filter((change) => !queued.some((item) => item.change.pairingId === change.pairingId))
    .map((change) => ({ change, actor: notice.actor, actorRoles: notice.actorRoles }));
}

/** "500 : 433", or a dash when the pairing had no result yet. */
export function formatScore(value: { scoreOne?: number; scoreTwo?: number } | null): string {
  // Loose != : an unscored pairing arrives with the score fields OMITTED, not null.
  if (!value || (value.scoreOne == null && value.scoreTwo == null)) return "ยังไม่มีผล";
  return `${value.scoreOne ?? 0} : ${value.scoreTwo ?? 0}`;
}

/** "somebody - DIRECTOR", from the authenticated identity the event carried. */
export function formatActor(actor: string | null, roles: string[]): string {
  const role = roles.map((item) => item.startsWith("ROLE_") ? item.slice(5) : item).join(" / ");
  if (!actor) return role || "ผู้ใช้อื่น";
  return role ? `${actor} - ${role}` : actor;
}

/**
 * Which columns carry an Excel sort + filter menu: those with a value to match on that are not a
 * mirror of another column.
 *
 * Derived, never listed. Side 2 of a pairing is a mirror — the whole field is filtered from side 1,
 * which matches both seats — and a hand-kept list of keys beside the column definitions is a second
 * statement of that fact, free to fall out of step with the `searchable: false` that removes the
 * menu. When those two disagree the grid still renders, it just filters wrongly.
 */
function menuKeys<T>(columns: readonly GridColumnBase[], accessors: Record<string, T>): string[] {
  return columns.filter((column) => column.searchable !== false && accessors[column.key]).map((column) => column.key);
}

export interface EntrySlot {
  /** Table/couple number; stable even before the pairing exists (PAIR_RESULT destination). */
  tableNumber: number;
  /** Undefined while the matchup is still unknown (waiting on the source game). */
  pairing?: Pairing;
  /** A finalized one-player pairing: the lone player must win. Distinct from a still-pending row. */
  isBye?: boolean;
  /**
   * This slot holds nobody and needs no result. Passed in rather than derived, because a PAIR_RESULT
   * destination whose source pair was voided has NO row of its own to read the flag from — it is
   * void by inheritance, and otherwise indistinguishable from a slot still waiting on its source.
   */
  isVoid?: boolean;
}

interface PairingEditConfig {
  onSwap: (a: string, b: string, password: string) => Promise<boolean>;
  swapDisabled?: boolean;
  swapTitle?: string;
  onUnpair?: () => Promise<void>;
  onPublish?: () => Promise<void>;
  publishDisabled?: boolean;
  publishLabel?: string;
  publishTitle?: string;
}

/**
 * `void` is internal: it has no entry in `STATUS_OPTIONS`, so it shows under "ทุกสถานะ" and is
 * filtered out of every named status. A slot holding nobody is not a state the operator manages —
 * offering "ยังไม่ได้กรอก" for it would invite them to go looking for a match that does not exist.
 */
type RowStatus = "pending" | "empty" | "dirty" | "saved" | "void";

/**
 * Widest rendered width of the จัดการ column, per role, in px.
 *
 * Measured in the browser at 375 / 1280 / 1920. `.button--sm` is a fixed 13px with fixed padding,
 * so the button run itself is viewport-independent — director 165.6px (เซฟ + ✕ + ลงดาบ), staff
 * 102.6px (เซฟ + ✕). Only the cell's own padding moves, and `clamp(2px, .45vw, 6px)` caps it at 6
 * per side, so these numbers are content + 12 + 2. A director gets ลงดาบ on every row and so needs
 * to clear three buttons where a staff member only ever clears two; one shared floor would waste
 * ~60px on every staff screen, and staff are the people who live in this grid.
 *
 * Deliberately NOT `fitContent: true`. `measureContentMins` sizes a column with
 * `Range.selectNodeContents(cell)`, and `.cell-action__group` is a block-level flex box that fills
 * its cell — so the range reports the CELL width, not the content's. Verified: 180px of buttons in
 * an 899.5px cell reported 897. On this column fitting would be a ratchet that can only grow it,
 * re-inflating exactly what this shrinks. The floor does the work, and `width === fitMin` keeps
 * `fitWidths` from handing the column any of the spare space it just gave back.
 */
export const ACTION_WIDTH = { director: 180, staff: 117 } as const;

const EDIT_COLUMNS_BASE: GridColumnBase[] = [
  { key: "pair", label: "คู่", min: 32, fitMin: 32, width: 42, align: "center" },
  { key: "id1", label: "รหัส 1", min: 58, fitMin: 58, width: 72, filterKind: "playerCode", field: "code" },
  { key: "name1", label: "ชื่อ-นามสกุล", min: 90, fitMin: 90, width: 138, field: "name" },
  { key: "school1", label: "โรงเรียน/สถาบัน", min: 90, fitMin: 90, width: 132, field: "school" },
  { key: "id2", label: "รหัส 2", min: 58, fitMin: 58, width: 72, filterKind: "playerCode", searchable: false, field: "code" },
  { key: "name2", label: "ชื่อ-นามสกุล", min: 90, fitMin: 90, width: 138, searchable: false, field: "name" },
  { key: "school2", label: "โรงเรียน/สถาบัน", min: 90, fitMin: 90, width: 132, searchable: false, field: "school" },
  { key: "score1", label: "คะแนน 1", min: 48, fitMin: 48, width: 62, align: "center" },
  { key: "score2", label: "คะแนน 2", min: 48, fitMin: 48, width: 62, align: "center" },
  { key: "diff", label: "Diff", min: 52, fitMin: 52, width: 68, align: "center" },
];

/** The 11 edit columns, with จัดการ floored to whatever the viewer's role can actually put in it. */
export const editColumns = (canPenalty: boolean): GridColumnBase[] => {
  const action = canPenalty ? ACTION_WIDTH.director : ACTION_WIDTH.staff;
  return [...EDIT_COLUMNS_BASE, { key: "action", label: "จัดการ", min: action, fitMin: action, width: action }];
};

const VIEW_COLUMNS: GridColumnBase[] = [
  { key: "pair", label: "คู่", min: 32, width: 42, align: "center" },
  { key: "id1", label: "รหัส 1", min: 58, width: 72, filterKind: "playerCode", field: "code" },
  { key: "name1", label: "ชื่อ-นามสกุล", min: 90, width: 138, field: "name" },
  { key: "school1", label: "โรงเรียน/สถาบัน", min: 90, width: 132, field: "school" },
  { key: "id2", label: "รหัส 2", min: 58, width: 72, filterKind: "playerCode", searchable: false, field: "code" },
  { key: "name2", label: "ชื่อ-นามสกุล", min: 90, width: 138, searchable: false, field: "name" },
  { key: "school2", label: "โรงเรียน/สถาบัน", min: 90, width: 132, searchable: false, field: "school" },
  { key: "score1", label: "คะแนน 1", min: 64, width: 64, fitMin: 64, align: "center" },
  { key: "score2", label: "คะแนน 2", min: 64, width: 64, fitMin: 64, align: "center" },
  { key: "diff", label: "Diff", min: 50, width: 64, align: "center" },
  { key: "winner", label: "ผู้ชนะ", min: 58, width: 72, filterKind: "playerCode" },
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

/** For a bye (exactly one player present), which slot holds that player. */
function byeSide(pairing: Pairing | undefined): "one" | "two" | null {
  if (!pairing) return null;
  const one = Boolean(pairing.playerOneId);
  const two = Boolean(pairing.playerTwoId);
  return one && !two ? "one" : two && !one ? "two" : null;
}

export interface Outcome { resultType: "WIN" | "DRAW"; winnerId?: string; diff: number; }
type SaveResult = { ok: true } | { ok: false; reason: string };

/** Widest score a real match may record. Mirrors the DTO bounds and the SMALLINT column. */
export const MIN_SCORE = -30000;
export const MAX_SCORE = 30000;

export function calcOutcome(one: string, two: string, maxDiff: number, p1: string, p2: string): Outcome | null {
  if (one.trim() === "" || two.trim() === "") return null;
  const a = Number(one); const b = Number(two);
  // A real match may be negative: a player can finish a game below zero. A BYE may not — that rule
  // lives on the bye path, which has no opponent and still requires a score above zero.
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < MIN_SCORE || b < MIN_SCORE || a > MAX_SCORE || b > MAX_SCORE) return null;
  if (a === b) return { resultType: "DRAW", diff: 0 };
  return { resultType: "WIN", winnerId: a > b ? p1 : p2, diff: Math.min(Math.abs(a - b), maxDiff) };
}

function recordedDiff(pairing: Pairing) {
  if (!isRecorded(pairing)) return null;
  return pairing.resultType === "DRAW" ? 0 : pairing.calculatedDiff ?? 0;
}

function PlayerNameWithGibsonMark({ player, fallback, gibsonized }: {
  player?: Player;
  fallback: string;
  gibsonized?: boolean;
}) {
  const name = player ? `${player.firstName} ${player.lastName}` : fallback;
  return <span className="pairing-name-with-mark"><span>{name}</span>{gibsonized && <span className="gibson-mark">GIB</span>}</span>;
}

interface ResultEntryRowProps {
  slot: EntrySlot;
  pairing: Pairing | undefined;
  players: Map<string, Player>;
  maxDiff: number;
  one: string;
  two: string;
  saved: boolean;
  changed: boolean;
  isEditing: boolean;
  saving: boolean;
  failed: boolean;
  savingAll: boolean;
  highlight: boolean;
  onDraft: (id: string, field: "one" | "two", value: string, base: { one: string; two: string }) => void;
  onSaveRow: (pairing: Pairing) => Promise<boolean>;
  onSaveBye: (pairing: Pairing) => Promise<boolean>;
  onStartEdit: (id: string) => void;
  onCancelEdit: (id: string) => void;
  onFocusNext: (origin: HTMLElement, direction: "other" | "next") => void;
  onPenalty?: (pairing: Pairing) => void;
  onRevokePenalty?: (pairing: Pairing) => void;
}

/**
 * One result-entry row, memoized. All inputs are primitives or references that stay stable while
 * another cell is being typed (the pairing, the players map, the callbacks), so React skips
 * re-rendering every other row on each keystroke — only the row whose score/flags changed updates.
 */
const ResultEntryRow = memo(function ResultEntryRow({
  slot, pairing, players, maxDiff, one, two, saved, changed, isEditing, saving, failed, savingAll,
  highlight, onDraft, onSaveRow, onSaveBye, onStartEdit, onCancelEdit, onFocusNext, onPenalty, onRevokePenalty,
}: ResultEntryRowProps) {
  // A slot holding nobody: no players, no result to enter, and nothing to wait for. It keeps its
  // row so pair numbers still line up with the printed table cards and the source game beside it,
  // and says nothing else — a "รอ…" here would describe a match that does not exist, and a badge
  // would make a non-event look like a state the operator has to clear.
  if (slot.isVoid || isVoidPairing(pairing)) {
    return <tr className="egrid-row">
      <td className="egrid-td egrid-td--center cell-pair">{slot.tableNumber}</td>
      <td className="egrid-td cell-id">—</td>
      <td className="egrid-td cell-person-name">—</td>
      <td className="egrid-td cell-person-school">—</td>
      <td className="egrid-td cell-id">—</td>
      <td className="egrid-td cell-person-name">—</td>
      <td className="egrid-td cell-person-school">—</td>
      <td className="egrid-td egrid-td--center cell-score">—</td>
      <td className="egrid-td egrid-td--center cell-score">—</td>
      <td className="egrid-td egrid-td--center cell-diff">—</td>
      <td className="egrid-td cell-action" />
    </tr>;
  }
  if (pairing?.resultType === "PENALTY") {
    const p1 = pairing.playerOneId ? players.get(pairing.playerOneId) : undefined;
    const p2 = pairing.playerTwoId ? players.get(pairing.playerTwoId) : undefined;
    const penalty = pairing.calculatedDiff ?? 0;
    return <tr className={`egrid-row egrid-row--locked egrid-row--penalty${pairing.playerOneGibsonized || pairing.playerTwoGibsonized ? " egrid-row--gibson" : ""}`}>
      <td className="egrid-td egrid-td--center cell-pair">{pairing.tableNumber}</td>
      <td className="egrid-td cell-id">{p1?.id ?? "—"}</td>
      <td className={`egrid-td cell-person-name${pairing.playerOneGibsonized ? " cell-gibsonized" : ""}`} title={`${p1?.firstName ?? ""} ${p1?.lastName ?? ""}`}><PlayerNameWithGibsonMark player={p1} fallback="บาย (ไม่มีคู่แข่ง)" gibsonized={pairing.playerOneGibsonized} /></td>
      <td className="egrid-td cell-person-school" title={p1?.school}>{p1?.school ?? "—"}</td>
      <td className="egrid-td cell-id">{p2?.id ?? "—"}</td>
      <td className={`egrid-td cell-person-name${pairing.playerTwoGibsonized ? " cell-gibsonized" : ""}`} title={`${p2?.firstName ?? ""} ${p2?.lastName ?? ""}`}><PlayerNameWithGibsonMark player={p2} fallback="บาย (ไม่มีคู่แข่ง)" gibsonized={pairing.playerTwoGibsonized} /></td>
      <td className="egrid-td cell-person-school" title={p2?.school}>{p2?.school ?? "—"}</td>
      <td className="egrid-td egrid-td--center cell-score">-</td>
      <td className="egrid-td egrid-td--center cell-score">-</td>
      <td className="egrid-td egrid-td--center cell-diff cell-diff--penalty">-{penalty}</td>
      <td className="egrid-td cell-action">
        {onRevokePenalty
          ? <Button size="sm" variant="secondary" title="ถอนดาบเพื่อกลับไปกรอกผลใหม่" onClick={() => onRevokePenalty(pairing)}>ถอนดาบ</Button>
          : <Badge tone="danger">ล็อกโดยผู้อำนวยการ</Badge>}
      </td>
    </tr>;
  }
  const side = slot.isBye ? byeSide(pairing) : null;
  if (side && pairing) {
    const present = players.get((side === "one" ? pairing.playerOneId : pairing.playerTwoId) ?? "");
    const value = side === "one" ? one : two;
    const locked = saved && !isEditing;
    const disabled = locked || saving || savingAll;
    const scoreNum = Number(value);
    const valid = value.trim() !== "" && Number.isInteger(scoreNum) && scoreNum > 0;
    const base = { one, two };
    const presentCell = (
      <>
        <td className="egrid-td cell-id">{present?.id ?? "—"}</td>
        <td className={`egrid-td cell-person-name${(side === "one" ? pairing.playerOneGibsonized : pairing.playerTwoGibsonized) ? " cell-gibsonized" : ""}`} title={`${present?.firstName ?? ""} ${present?.lastName ?? ""}`}><PlayerNameWithGibsonMark player={present} fallback="—" gibsonized={side === "one" ? pairing.playerOneGibsonized : pairing.playerTwoGibsonized} /></td>
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
      <td className="egrid-td"><ScoreInput className="egrid-score" type="number" inputMode="numeric" min={1} aria-label={`คะแนน ${present?.id}`} placeholder="คะแนน" value={value} disabled={disabled}
        onChange={(event) => onDraft(pairing.id, side, event.target.value, base)} onFocus={(event) => event.target.select()}
        onKeyDown={async (event) => { if (event.key !== "Enter") return; event.preventDefault(); await onSaveBye(pairing); }} /></td>
    );
    const byeScore = <td className="egrid-td"><input className="egrid-score" disabled value="" readOnly placeholder="บาย" /></td>;
    return <tr className={`egrid-row egrid-row--bye${pairing.playerOneGibsonized || pairing.playerTwoGibsonized ? " egrid-row--gibson" : ""}${changed ? " egrid-row--dirty" : ""}${locked ? " egrid-row--locked" : ""}${failed ? " egrid-row--failed" : ""}`}>
      <td className="egrid-td egrid-td--center cell-pair">{pairing.tableNumber}</td>
      {side === "one" ? presentCell : byeCell}
      {side === "one" ? byeCell : presentCell}
      {side === "one" ? scoreInput : byeScore}
      {side === "one" ? byeScore : scoreInput}
      <td className={`egrid-td egrid-td--center cell-diff cell-diff--${valid ? "win" : "pending"}`}>{valid ? `${present?.id} · ${Math.min(scoreNum, maxDiff)}` : "ต้องชนะ"}</td>
      <td className="egrid-td cell-action">
        {locked ? (
          <div className="cell-action__group">
            <Button size="sm" variant="secondary" onClick={() => onStartEdit(pairing.id)}><Pencil size={13} />แก้ไข</Button>
            {onPenalty && <Button size="sm" variant="danger" title="ลงดาบ (บังคับแพ้)" onClick={() => onPenalty(pairing)}>ลงดาบ</Button>}
          </div>
        ) : (
          <div className="cell-action__group">
            <Button size="sm" variant="success" disabled={!valid || !changed || saving || savingAll} onClick={() => void onSaveBye(pairing)}>{saving ? <LoaderCircle className="loading-spinner" size={13} /> : saved ? <Check size={13} /> : <Save size={13} />}เซฟ</Button>
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
    return <tr className={`egrid-row egrid-row--pending${pairing?.playerOneGibsonized || pairing?.playerTwoGibsonized ? " egrid-row--gibson" : ""}`}>
      <td className="egrid-td egrid-td--center cell-pair">{slot.tableNumber}</td>
      <td className="egrid-td cell-id">{p1?.id ?? "—"}</td>
      <td className={`egrid-td cell-person-name${pairing?.playerOneGibsonized ? " cell-gibsonized" : ""}`} title={`${p1?.firstName ?? ""} ${p1?.lastName ?? ""}`}><PlayerNameWithGibsonMark player={p1} fallback={waitingText} gibsonized={pairing?.playerOneGibsonized} /></td>
      <td className="egrid-td cell-person-school" title={p1?.school}>{p1?.school ?? "—"}</td>
      <td className="egrid-td cell-id">{p2?.id ?? "—"}</td>
      <td className={`egrid-td cell-person-name${pairing?.playerTwoGibsonized ? " cell-gibsonized" : ""}`} title={`${p2?.firstName ?? ""} ${p2?.lastName ?? ""}`}><PlayerNameWithGibsonMark player={p2} fallback={waitingText} gibsonized={pairing?.playerTwoGibsonized} /></td>
      <td className="egrid-td cell-person-school" title={p2?.school}>{p2?.school ?? "—"}</td>
      <td className="egrid-td"><input className="egrid-score" disabled value="" readOnly placeholder="—" /></td>
      <td className="egrid-td"><input className="egrid-score" disabled value="" readOnly placeholder="—" /></td>
      <td className="egrid-td egrid-td--center cell-diff">—</td>
      <td className="egrid-td cell-action"><Badge tone="neutral">{pairing ? "รออีกฝั่ง" : "รอข้อมูล"}</Badge></td>
    </tr>;
  }
  const p1 = players.get(pairing.playerOneId); const p2 = players.get(pairing.playerTwoId);
  const locked = saved && !isEditing;
  const disabled = locked || saving || savingAll;
  const outcome = calcOutcome(one, two, maxDiff, pairing.playerOneId, pairing.playerTwoId);
  const base = { one, two };
  // Which side's typed score is outside the normal band right now — a hint while typing, not a gate.
  const unusual = [
    one.trim() !== "" && isUnusualScore(Number(one)) ? p1?.id : null,
    two.trim() !== "" && isUnusualScore(Number(two)) ? p2?.id : null,
  ].filter((code): code is string => Boolean(code));
  return <tr className={`egrid-row${pairing.playerOneGibsonized || pairing.playerTwoGibsonized ? " egrid-row--gibson" : ""}${changed ? " egrid-row--dirty" : ""}${locked ? " egrid-row--locked" : ""}${failed ? " egrid-row--failed" : ""}${highlight ? " egrid-row--flash" : ""}`}>
    <td className="egrid-td egrid-td--center cell-pair">{pairing.tableNumber}</td>
    <td className="egrid-td cell-id">{p1?.id}</td>
    <td className={`egrid-td cell-person-name${pairing.playerOneGibsonized ? " cell-gibsonized" : ""}`} title={`${p1?.firstName ?? ""} ${p1?.lastName ?? ""}`}><PlayerNameWithGibsonMark player={p1} fallback="—" gibsonized={pairing.playerOneGibsonized} /></td>
    <td className="egrid-td cell-person-school" title={p1?.school}>{p1?.school}</td>
    <td className="egrid-td cell-id">{p2?.id}</td>
    <td className={`egrid-td cell-person-name${pairing.playerTwoGibsonized ? " cell-gibsonized" : ""}`} title={`${p2?.firstName ?? ""} ${p2?.lastName ?? ""}`}><PlayerNameWithGibsonMark player={p2} fallback="—" gibsonized={pairing.playerTwoGibsonized} /></td>
    <td className="egrid-td cell-person-school" title={p2?.school}>{p2?.school}</td>
    <td className="egrid-td"><ScoreInput className="egrid-score" type="number" inputMode="text" aria-label={`คะแนน ${p1?.id}`} placeholder={p1?.id} value={one} disabled={disabled} onChange={(event) => onDraft(pairing.id, "one", event.target.value, base)} onFocus={(event) => event.target.select()} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); onFocusNext(event.currentTarget, "other"); } }} /></td>
    <td className="egrid-td"><ScoreInput className="egrid-score" type="number" inputMode="text" aria-label={`คะแนน ${p2?.id}`} placeholder={p2?.id} value={two} disabled={disabled} onChange={(event) => onDraft(pairing.id, "two", event.target.value, base)} onFocus={(event) => event.target.select()} onKeyDown={async (event) => { if (event.key !== "Enter") return; event.preventDefault(); const origin = event.currentTarget; if (await onSaveRow(pairing)) onFocusNext(origin, "next"); }} /></td>
    <td className={`egrid-td egrid-td--center cell-diff cell-diff--${outcome ? outcome.resultType.toLowerCase() : "pending"}`}>
      {outcome ? (outcome.resultType === "DRAW" ? "เสมอ · 0" : `${outcome.winnerId} · ${outcome.diff}`) : "—"}
      {unusual.length > 0 && <span className="cell-score-warning" title={unusual.map((code) => `คะแนน ${code} ผิดปกติ`).join(" · ")} aria-label={`คะแนนผิดปกติ: ${unusual.join(", ")}`}>!</span>}
    </td>
    <td className="egrid-td cell-action">
      {locked ? (
        <div className="cell-action__group">
          <Button size="sm" variant="secondary" onClick={() => onStartEdit(pairing.id)}><Pencil size={13} />แก้ไข</Button>
          {onPenalty && <Button size="sm" variant="danger" title="ลงดาบ (บังคับแพ้ทั้งคู่)" onClick={() => onPenalty(pairing)}>ลงดาบ</Button>}
        </div>
      ) : (
        <div className="cell-action__group">
          <Button size="sm" variant="success" disabled={!outcome || !changed || saving || savingAll} onClick={() => void onSaveRow(pairing)}>{saving ? <LoaderCircle className="loading-spinner" size={13} /> : saved ? <Check size={13} /> : <Save size={13} />}เซฟ</Button>
          {saved && isEditing && <Button size="sm" variant="ghost" aria-label="ยกเลิกแก้ไข" disabled={saving || savingAll} onClick={() => onCancelEdit(pairing.id)}><X size={13} /></Button>}
          {onPenalty && <Button size="sm" variant="danger" title="ลงดาบ (บังคับแพ้ทั้งคู่)" onClick={() => onPenalty(pairing)}>ลงดาบ</Button>}
        </div>
      )}
    </td>
  </tr>;
});

export function ResultEntryGrid({ gameNumber, slots, players, maxDiff, storageKey, onSubmit, onPenalty, onRevokePenalty, pairingEdit }: {
  gameNumber: number;
  slots: EntrySlot[];
  players: Map<string, Player>;
  maxDiff: number;
  /** Identifies the table so user-resized column widths persist per card+game in sessionStorage. */
  storageKey: string;
  onSubmit: (pairing: Pairing, scoreOne: number, scoreTwo: number, editExisting: boolean) => Promise<void>;
  /** Director-only "ลงดาบ" penalty for a pairing (incl. a bye). Opens the page's penalty dialog. */
  onPenalty?: (pairing: Pairing) => void;
  /** Director-only withdrawal. A penalized row cannot otherwise be edited. */
  onRevokePenalty?: (pairing: Pairing) => void;
  /** Director-only pairing edit during result collection. Swaps require password re-authentication. */
  pairingEdit?: PairingEditConfig;
}) {
  const controls = useColumnControls();
  const [status, setStatus] = useState<"all" | RowStatus>("all");
  const [drafts, setDrafts] = useState<Record<string, { one: string; two: string }>>({});
  const [editing, setEditing] = useState<Set<string>>(new Set());
  /**
   * A pairing this user is mid-edit on that somebody else has just committed a result for.
   *
   * Held in LOCAL state rather than read straight off the store notice: once captured it must
   * survive later events, and it must be answered explicitly rather than replaced by the next
   * publish. Nothing here reconciles data — the store was already reconciled by applyResultPatch
   * or by the version-gap resync before this ever renders.
   */
  const [conflicts, setConflicts] = useState<ConflictNotice[]>([]);
  /**
   * Someone rearranged the PAIRING of a row this user is mid-edit on — a different event from a
   * result being overwritten, and it needs its own words: there are no "before" scores to show,
   * because what changed is who is sitting there.
   */
  const [pairingConflict, setPairingConflict] = useState<{ pairingId: string; table: number; actor: string | null } | null>(null);
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
  // ลงดาบ is director-only, so the จัดการ floor is too. `Boolean(onPenalty)` rather than the
  // callback itself: the parent passes an inline arrow, so the identity changes every render.
  const canPenalty = Boolean(onPenalty);
  const columns = useMemo(() => editColumns(canPenalty), [canPenalty]);
  // Role is part of the layout identity: a director and a staff member have different floors, and
  // a restored width array bypasses fitting entirely. Without this, logging out of a director
  // account and into a staff one in the same tab would restore the director's wider จัดการ.
  const { colWidths, totalWidth, scrollRef, startResize } = useResizableColumns(columns, `${storageKey}:${canPenalty ? "dir" : "staff"}`);
  // Row callbacks read the latest drafts through a ref so they can stay referentially stable
  // (useCallback with no per-keystroke deps) — that is what lets memoized rows skip re-rendering
  // while another cell is being typed.
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  // Read through refs inside the notice effect so it depends on the EVENT only: re-running it on
  // every keystroke could re-raise a warning the user just acknowledged.
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const remoteResult = useTournamentStore((state) => state.remoteResult);
  const remotePairing = useTournamentStore((state) => state.remotePairing);
  const handledSeqRef = useRef(0);
  const handledPairingSeqRef = useRef(0);

  // Any "this is the pair" highlight + inline feedback clears when closed or the next entry starts.
  const clearFlash = useCallback(() => { setQuickFeedback(null); setHighlightId(null); }, []);

  const rows = useMemo(() => slots.map((slot) => {
    const pairing = slot.pairing;
    // Ahead of every other case: a void slot must not fall into `pending`, which is what made the
    // review gate uncompletable — and it is neither empty (nothing to fill in) nor saved.
    if (slot.isVoid || isVoidPairing(pairing)) return { slot, pairing, status: "void" as RowStatus };
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

  const accessors = useMemo<Record<string, (row: { slot: EntrySlot; pairing?: Pairing }) => string | number>>(() => ({
    pair: (row) => row.slot.tableNumber,
    id1: (row) => players.get(row.pairing?.playerOneId ?? "")?.id ?? "—",
    name1: (row) => { const player = players.get(row.pairing?.playerOneId ?? ""); return player ? `${player.firstName} ${player.lastName}` : "—"; },
    school1: (row) => players.get(row.pairing?.playerOneId ?? "")?.school ?? "—",
    id2: (row) => players.get(row.pairing?.playerTwoId ?? "")?.id ?? "—",
    name2: (row) => { const player = players.get(row.pairing?.playerTwoId ?? ""); return player ? `${player.firstName} ${player.lastName}` : "—"; },
    school2: (row) => players.get(row.pairing?.playerTwoId ?? "")?.school ?? "—",
  }), [players]);
  // Filter-dropdown options depend only on the pairings' identity (codes/names/schools/table), not
  // on the scores being typed, so derive them from slots — not `rows` — to avoid recomputing the
  // unique-value sets on every keystroke.
  const identityRows = useMemo(() => slots.map((slot) => ({ slot, pairing: slot.pairing })), [slots]);
  const filterKeys = useMemo(() => menuKeys(columns, accessors), [columns, accessors]);
  const uniqueValues = useMemo(() => uniqueColumnValues(identityRows, accessors, filterKeys), [identityRows, accessors, filterKeys]);
  const codeKeys = useMemo(() => playerCodeKeysOf(columns), [columns]);
  const fieldGroups = useMemo(() => fieldGroupsOf(columns), [columns]);
  const filtered = useMemo(() => {
    const byColumn = applyColumnControls(rows, accessors, controls.filters, controls.sort, controls.textFilters, codeKeys, fieldGroups);
    return status === "all" ? byColumn : byColumn.filter((row) => row.status === status);
  }, [rows, accessors, controls.filters, controls.textFilters, controls.sort, status, codeKeys, fieldGroups]);

  const filtersActive = controls.active || status !== "all";
  const savedCount = rows.filter((row) => row.status === "saved").length;
  const dirtyCount = rows.filter((row) => row.status === "dirty").length;
  // Scores typed but not yet saved must survive an accidental refresh/close.
  useUnsavedChangesWarning(dirtyCount > 0);
  const filteredSavable = filtered.filter((row) => {
    if (!row.pairing || row.status !== "dirty") return false;
    const side = row.slot.isBye ? byeSide(row.pairing) : null;
    if (side) {
      const value = drafts[row.pairing.id]?.[side]
        ?? (side === "one" ? row.pairing.scoreOne : row.pairing.scoreTwo)?.toString()
        ?? "";
      return value.trim() !== "" && Number.isInteger(Number(value)) && Number(value) > 0;
    }
    return isCompletePairing(row.pairing)
      && Boolean(calcOutcome(row.one ?? "", row.two ?? "", maxDiff, row.pairing.playerOneId, row.pairing.playerTwoId));
  });

  const setDraft = useCallback((id: string, field: "one" | "two", value: string, base: { one: string; two: string }) => {
    clearFlash();
    setFailedIds((prev) => { if (!prev.has(id)) return prev; const next = new Set(prev); next.delete(id); return next; });
    setDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] ?? base), [field]: value } }));
  }, [clearFlash]);

  /**
   * Unusual scores are flagged, never blocked. The operator sees which player's score looks odd
   * and confirms once; the save then proceeds exactly as it would have.
   */
  const confirmUnusualScores = useCallback(async (entries: { playerId: string; score: number }[]): Promise<boolean> => {
    const warnings = scoreWarnings(entries);
    if (warnings.length === 0) return true;
    return appDialog.confirm(warnings.map((warning) => warning.message).join("\n"), {
      title: "ตรวจสอบคะแนนก่อนบันทึก",
      confirmLabel: "บันทึกต่อ",
    });
  }, []);

  const saveValues = useCallback(async (pairing: CompletePairing, one: string, two: string): Promise<SaveResult> => {
    if (!calcOutcome(one, two, maxDiff, pairing.playerOneId, pairing.playerTwoId))
      return { ok: false, reason: `คะแนนต้องเป็นจำนวนเต็มระหว่าง ${MIN_SCORE} ถึง ${MAX_SCORE}` };
    if (!await confirmUnusualScores([
      { playerId: pairing.playerOneId, score: Number(one) },
      { playerId: pairing.playerTwoId, score: Number(two) },
    ])) return { ok: false, reason: "ยกเลิกการบันทึก" };
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
  }, [maxDiff, onSubmit, confirmUnusualScores]);

  const saveRow = useCallback(async (pairing: Pairing): Promise<boolean> => {
    if (!isCompletePairing(pairing)) return false;
    const draft = draftsRef.current[pairing.id];
    const one = draft?.one ?? pairing.scoreOne?.toString() ?? "";
    const two = draft?.two ?? pairing.scoreTwo?.toString() ?? "";
    return (await saveValues(pairing, one, two)).ok;
  }, [saveValues]);

  // A bye: the lone player must win. We send their entered score in their slot and 0 in the empty slot.
  const saveByeRow = useCallback(async (pairing: Pairing): Promise<boolean> => {
    const side = byeSide(pairing);
    if (!side) return false;
    const draft = draftsRef.current[pairing.id];
    const value = draft?.[side] ?? (side === "one" ? pairing.scoreOne : pairing.scoreTwo)?.toString() ?? "";
    const score = Number(value);
    // A bye keeps its own rule: the lone player must win, so a score of 0 or less is never a result.
    if (!Number.isInteger(score) || score <= 0) return false;
    const lonePlayerId = (side === "one" ? pairing.playerOneId : pairing.playerTwoId) ?? "";
    if (!await confirmUnusualScores([{ playerId: lonePlayerId, score }])) return false;
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
  }, [onSubmit, confirmUnusualScores]);

  const saveAll = async () => {
    if (filteredSavable.length === 0) return;
    setSavingAll(true);
    try {
      for (const row of filteredSavable) {
        if (!row.pairing) continue;
        if (row.slot.isBye && byeSide(row.pairing)) await saveByeRow(row.pairing);
        else await saveRow(row.pairing);
      }
    } finally {
      setSavingAll(false);
    }
  };

  // Quick key-in: validate that A vs B is a real pairing this game (either side), then save + highlight.
  const quickSave = async () => {
    if (quickSaving) return;
    const a = qIdA.trim(); const b = qIdB.trim();
    // A code within one card always shares the same letter prefix, so a bare number ("16") matches
    // the player just as well as the full code ("A16"); matchesPlayerCode compares prefix-agnostically.
    if (!a || !b) {
      setHighlightId(null);
      setQuickFeedback({ type: "error", message: "ไม่สำเร็จ · กรุณากรอกรหัส A และ B" });
      return;
    }
    const match = rows.find((row) => isCompletePairing(row.pairing)
      && ((matchesPlayerCode(row.pairing.playerOneId, a) && matchesPlayerCode(row.pairing.playerTwoId, b))
        || (matchesPlayerCode(row.pairing.playerOneId, b) && matchesPlayerCode(row.pairing.playerTwoId, a))));
    if (!match || !isCompletePairing(match.pairing)) {
      setHighlightId(null);
      setQuickFeedback({ type: "error", message: `ไม่สำเร็จ · ${normalizePlayerCode(a)} กับ ${normalizePlayerCode(b)} ไม่ใช่คู่ในเกม ${gameNumber}` });
      return;
    }
    const pairing = match.pairing;
    if (pairing.resultType === "PENALTY") {
      setHighlightId(pairing.id);
      setQuickFeedback({ type: "error", message: `ไม่สำเร็จ · คู่ที่ ${pairing.tableNumber} ถูกลงดาบและล็อกแล้ว` });
      return;
    }
    const aIsOne = matchesPlayerCode(pairing.playerOneId, a);
    const oneScore = aIsOne ? qScoreA : qScoreB;
    const twoScore = aIsOne ? qScoreB : qScoreA;
    if (!calcOutcome(oneScore, twoScore, maxDiff, pairing.playerOneId, pairing.playerTwoId)) {
      setQuickFeedback({ type: "error", message: `ไม่สำเร็จ · คะแนนต้องเป็นจำนวนเต็มระหว่าง ${MIN_SCORE} ถึง ${MAX_SCORE}` });
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
    if (!pairingEdit || pairingEdit.swapDisabled || !swapA.trim() || !swapB.trim() || !swapPassword) return;
    setSwapping(true);
    try {
      if (await pairingEdit.onSwap(normalizePlayerCode(swapA), normalizePlayerCode(swapB), swapPassword)) {
        setSwapA(""); setSwapB(""); setSwapPassword(""); setSwapOpen(false);
      }
    } finally { setSwapping(false); }
  };

  const startEdit = useCallback((id: string) => setEditing((prev) => new Set(prev).add(id)), []);
  const cancelEdit = useCallback((id: string) => {
    setEditing((prev) => { const next = new Set(prev); next.delete(id); return next; });
    setDrafts((prev) => { const next = { ...prev }; delete next[id]; return next; });
    setFailedIds((prev) => { if (!prev.has(id)) return prev; const next = new Set(prev); next.delete(id); return next; });
  }, []);

  // ---- Concurrent-draft warning (P4) -------------------------------------------------------
  // Purely a notification. The store was already reconciled before this runs — by applyResultPatch
  // when the delta landed on version + 1, or by the version-gap resync when it did not — so this
  // never decides what the data IS, only whether to interrupt someone mid-edit.
  useEffect(() => {
    if (!remoteResult || remoteResult.seq === handledSeqRef.current) return;
    handledSeqRef.current = remoteResult.seq;
    setConflicts((prev) => {
      const mine = selectConflicts(remoteResult, editingRef.current, draftsRef.current, prev);
      // A pairing nobody here is editing syncs silently, exactly as it did before this feature.
      return mine.length === 0 ? prev : [...prev, ...mine];
    });
  }, [remoteResult]);

  // ---- Pairing changed under an open draft (P3) ---------------------------------------------
  // The pairing tool can move players out of a row while staff are typing its score. Before this,
  // the save just failed with a validation message about byes — which is true but useless. Lock the
  // row instead, say who changed it, and drop the draft so nothing stale can be submitted.
  useEffect(() => {
    if (!remotePairing || remotePairing.seq === handledPairingSeqRef.current) return;
    handledPairingSeqRef.current = remotePairing.seq;
    for (const change of remotePairing.changedSlots) {
      const pairingId = `g${change.game}t${change.table}`;
      const busyHere = editingRef.current.has(pairingId) || hasTypedDraft(draftsRef.current[pairingId]);
      if (!busyHere) continue;   // a row nobody is editing syncs silently, as it always has
      setPairingConflict({ pairingId, table: change.table, actor: remotePairing.actor });
      break;
    }
  }, [remotePairing]);

  const acknowledgePairingConflict = useCallback(() => {
    setPairingConflict((current) => {
      if (current) cancelEdit(current.pairingId);
      return null;
    });
  }, [cancelEdit]);

  /**
   * "รับทราบ": the draft is gone and the row leaves edit mode, so what is on screen afterwards is
   * the committed result and nothing else. `cancelEdit` is the same path the row's own Cancel uses —
   * it drops the draft, the edit flag and any failed marker together, which is exactly the
   * "never keep a stale draft" rule. Continuing requires pressing Edit again.
   */
  const acknowledgeConflict = useCallback(() => {
    setConflicts((prev) => {
      const [current, ...rest] = prev;
      if (current) cancelEdit(current.change.pairingId);
      return rest;
    });
  }, [cancelEdit]);

  const focusNext = useCallback((origin: HTMLElement, direction: "other" | "next") => {
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
  }, []);

  const conflict = conflicts[0] ?? null;

  return (
    <div className="entry-grid-wrap">
      <ConfirmDialog
        open={Boolean(pairingConflict)}
        hideCancel
        title="คู่แข่งขันนี้ถูกเปลี่ยนโดยผู้ใช้อื่น"
        description={pairingConflict
          ? `${pairingConflict.actor ?? "ผู้ใช้อื่น"} เปลี่ยนผู้เล่นของคู่ที่ ${pairingConflict.table}`
          : undefined}
        confirmLabel="รับทราบ"
        onConfirm={acknowledgePairingConflict}
        onCancel={acknowledgePairingConflict}
      >
        {pairingConflict && <p className="entry-conflict-explanation">เพื่อป้องกันการบันทึกคะแนนให้ผู้เล่นผิดคู่ ระบบจะทิ้งค่าที่กรอกค้างไว้และโหลดสถานะคู่ปัจจุบันใหม่ กดรับทราบแล้วตรวจสอบแถวนี้ก่อนเริ่มกรอกอีกครั้ง</p>}
      </ConfirmDialog>
      {/*
        Blocking on purpose: this fires only when somebody else committed a result for the very
        pairing this user is mid-edit on, and the draft on screen is about to be thrown away. One
        button, because there is nothing to decide — the committed result has already won.
      */}
      <ConfirmDialog
        open={Boolean(conflict)}
        hideCancel
        title="ผลของคู่นี้ถูกแก้ไขโดยผู้ใช้อื่น"
        description={conflict
          ? `${formatActor(conflict.actor, conflict.actorRoles)} ทำการแก้ไขผลของคู่ที่ ${conflict.change.tableNumber}`
          : undefined}
        confirmLabel="รับทราบ"
        onConfirm={acknowledgeConflict}
        onCancel={acknowledgeConflict}
      >
        {conflict && (
          <>
            <p className="entry-conflict-scores">
              จาก <strong>{formatScore(conflict.change.before)}</strong> เป็น <strong>{formatScore(conflict.change.after)}</strong>
            </p>
            <p className="entry-conflict-explanation">เพื่อไม่ให้เขียนทับผลล่าสุด ค่าที่กรอกค้างไว้จะไม่ถูกส่งต่อ กดรับทราบเพื่อใช้ผลปัจจุบัน แล้วกดแก้ไขหากยังต้องการปรับใหม่</p>
          </>
        )}
      </ConfirmDialog>

      <div className={`entry-keyin${quickFeedback ? ` entry-keyin--${quickFeedback.type}` : ""}`}>
        <span className="entry-keyin__label">คีย์เร็ว</span>
        <input ref={idARef} className="entry-keyin__id" inputMode="numeric" placeholder="รหัส A เช่น 16" value={qIdA} aria-label="รหัสฝ่าย A"
          onChange={(event) => { clearFlash(); setQIdA(event.target.value.toUpperCase()); }}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); scoreARef.current?.focus(); scoreARef.current?.select(); } }} />
        <ScoreInput ref={scoreARef} type="number" inputMode="text" className="entry-keyin__score" placeholder="คะแนน A" value={qScoreA} aria-label="คะแนนฝ่าย A"
          onChange={(event) => { clearFlash(); setQScoreA(event.target.value); }} onFocus={(event) => event.target.select()}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); idBRef.current?.focus(); idBRef.current?.select(); } }} />
        <span className="entry-keyin__vs">พบ</span>
        <input ref={idBRef} className="entry-keyin__id" inputMode="numeric" placeholder="รหัส B เช่น 16" value={qIdB} aria-label="รหัสฝ่าย B"
          onChange={(event) => { clearFlash(); setQIdB(event.target.value.toUpperCase()); }}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); scoreBRef.current?.focus(); scoreBRef.current?.select(); } }} />
        <ScoreInput ref={scoreBRef} type="number" inputMode="text" className="entry-keyin__score" placeholder="คะแนน B" value={qScoreB} aria-label="คะแนนฝ่าย B"
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
          {pairingEdit && (
            <Button size="sm" variant="secondary" disabled={pairingEdit.swapDisabled} onClick={() => setSwapOpen((open) => !open)} title={pairingEdit.swapTitle ?? "สลับผู้เล่นในคู่ที่ยังไม่กรอกผล (เฉพาะผู้อำนวยการ)"}>
              <Shuffle size={14} />สลับผู้เล่น
            </Button>
          )}
          {pairingEdit?.onPublish && (
            <Button size="sm" variant="secondary" disabled={pairingEdit.publishDisabled} onClick={() => void pairingEdit.onPublish?.()} title={pairingEdit.publishTitle ?? "เผยแพร่ pairing นี้ไปยังหน้าภาพรวม"}>
              <Megaphone size={14} />{pairingEdit.publishLabel ?? "Publish Pairing"}
            </Button>
          )}
          {pairingEdit?.onUnpair && savedCount === 0 && <Button size="sm" variant="secondary" onClick={() => void pairingEdit.onUnpair?.()} title="ลบ pairing ปัจจุบันและกลับไปสถานะรอกด Pairing ใหม่ (เฉพาะผู้อำนวยการ)"><Undo2 size={14} />Unpairing</Button>}
        </div>
      </div>
      {pairingEdit && swapOpen && (
        <div className="entry-swap">
          <span className="entry-swap__label">สลับผู้เล่น (เฉพาะคู่ที่ยังไม่กรอกผล)</span>
          <input className="entry-keyin__id" inputMode="numeric" placeholder="รหัส A เช่น 16" value={swapA} aria-label="รหัสผู้เล่น A ที่จะสลับ" onChange={(event) => setSwapA(event.target.value.toUpperCase())} />
          <span className="entry-keyin__vs">↔</span>
          <input className="entry-keyin__id" inputMode="numeric" placeholder="รหัส B เช่น 16" value={swapB} aria-label="รหัสผู้เล่น B ที่จะสลับ" onChange={(event) => setSwapB(event.target.value.toUpperCase())} />
          <FreshSecretInput className="entry-swap__password" wrapperClassName="entry-swap__password-field" placeholder="รหัสผ่านผู้อำนวยการ" value={swapPassword} aria-label="รหัสผ่านผู้อำนวยการเพื่อยืนยันการสลับคู่" onChange={(event) => setSwapPassword(event.target.value)} />
          <Button size="sm" variant="success" disabled={swapping || pairingEdit.swapDisabled || !swapA.trim() || !swapB.trim() || !swapPassword} onClick={() => void doSwap()}>{swapping ? <LoaderCircle className="loading-spinner" size={14} /> : <Shuffle size={14} />}ยืนยันการสลับ</Button>
          <Button size="sm" variant="ghost" aria-label="ปิด" onClick={() => { setSwapOpen(false); setSwapPassword(""); }}><X size={14} /></Button>
        </div>
      )}

      <div className="entry-grid-scroll entry-grid-scroll--result-entry" ref={scrollRef}>
        <table className="entry-grid entry-grid--match" style={{ width: totalWidth }} aria-label="กรอกผลการแข่งขัน">
          <GridHead columns={columns} colWidths={colWidths} startResize={startResize} excel={{
            sortable: (key) => filterKeys.includes(key),
            filterable: (key) => filterKeys.includes(key),
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
              <tr><td className="egrid-empty" colSpan={columns.length}><strong>ไม่พบคู่ตามตัวกรอง</strong><span>ลองล้างตัวกรองเพื่อดูทุกคู่</span></td></tr>
            ) : filtered.map((row) => {
              const { slot, pairing } = row;
              const draft = pairing ? drafts[pairing.id] : undefined;
              const one = draft?.one ?? pairing?.scoreOne?.toString() ?? "";
              const two = draft?.two ?? pairing?.scoreTwo?.toString() ?? "";
              return <ResultEntryRow
                key={pairing?.id ?? `pending-${slot.tableNumber}`}
                slot={slot}
                pairing={pairing}
                players={players}
                maxDiff={maxDiff}
                one={one}
                two={two}
                saved={Boolean(row.saved)}
                changed={Boolean(row.changed)}
                isEditing={pairing ? editing.has(pairing.id) : false}
                saving={pairing ? savingIds.has(pairing.id) : false}
                failed={pairing ? failedIds.has(pairing.id) : false}
                savingAll={savingAll}
                highlight={Boolean(pairing) && highlightId === pairing!.id}
                onDraft={setDraft}
                onSaveRow={saveRow}
                onSaveBye={saveByeRow}
                onStartEdit={startEdit}
                onCancelEdit={cancelEdit}
                onFocusNext={focusNext}
                onPenalty={onPenalty}
                onRevokePenalty={onRevokePenalty}
              />;
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
    winner: (pairing) => pairing.resultWithdrawn ? "ถอนผล"
      : pairing.resultType === "DRAW" ? "เสมอ" : pairing.winnerId ?? "—",
  }), [players]);
  const filterKeys = useMemo(() => menuKeys(viewColumns, accessors), [viewColumns, accessors]);
  const uniqueValues = useMemo(
    () => uniqueColumnValues(pairings, accessors, filterKeys),
    [pairings, accessors, filterKeys],
  );
  const codeKeys = useMemo(() => playerCodeKeysOf(viewColumns), [viewColumns]);
  const fieldGroups = useMemo(() => fieldGroupsOf(viewColumns), [viewColumns]);
  const filtered = useMemo(
    () => applyColumnControls(pairings, accessors, controls.filters, controls.sort, controls.textFilters, codeKeys, fieldGroups),
    [pairings, accessors, controls.filters, controls.sort, controls.textFilters, codeKeys, fieldGroups],
  );

  return (
    <div className="entry-grid-scroll" ref={scrollRef}>
      <table className="entry-grid entry-grid--match" style={{ width: totalWidth }} aria-label="ผลการแข่งขัน">
        <GridHead columns={viewColumns} colWidths={colWidths} startResize={startResize} excel={{
            sortable: (key) => filterKeys.includes(key),
            filterable: (key) => filterKeys.includes(key),
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
              // "ไม่มีคู่แข่ง" describes a bye — one player with nobody across the board. A void
              // slot has no player at all, so it says nothing rather than describing half a match.
              const absentText = isVoidPairing(pairing) ? "—" : recorded ? "-" : "ไม่มีคู่แข่ง";
              return <tr key={pairing.id} className={`egrid-row${pairing.playerOneGibsonized || pairing.playerTwoGibsonized ? " egrid-row--gibson" : ""}`}>
                <td className="egrid-td egrid-td--center cell-pair">{pairing.tableNumber}</td>
                <td className="egrid-td cell-id">{p1?.id ?? "—"}</td>
                <td className={`egrid-td cell-person-name${pairing.playerOneGibsonized ? " cell-gibsonized" : ""}`} title={`${p1?.firstName ?? ""} ${p1?.lastName ?? ""}`}><PlayerNameWithGibsonMark player={p1} fallback={absentText} gibsonized={pairing.playerOneGibsonized} /></td>
                <td className="egrid-td cell-person-school" title={p1?.school}>{p1?.school ?? "—"}</td>
                <td className="egrid-td cell-id">{p2?.id ?? "—"}</td>
                <td className={`egrid-td cell-person-name${pairing.playerTwoGibsonized ? " cell-gibsonized" : ""}`} title={`${p2?.firstName ?? ""} ${p2?.lastName ?? ""}`}><PlayerNameWithGibsonMark player={p2} fallback={absentText} gibsonized={pairing.playerTwoGibsonized} /></td>
                <td className="egrid-td cell-person-school" title={p2?.school}>{p2?.school ?? "—"}</td>
                <td className="egrid-td egrid-td--center cell-score">{penalty ? "-" : pairing.scoreOne ?? "—"}</td>
                <td className="egrid-td egrid-td--center cell-score">{penalty ? "-" : pairing.scoreTwo ?? "—"}</td>
                <td className={`egrid-td egrid-td--center cell-diff cell-diff--${!recorded ? "pending" : penalty ? "penalty" : draw ? "draw" : "win"}`}>{!recorded ? "—" : penalty ? `-${diff ?? 0}` : draw ? "0" : `${diff}`}</td>
                <td className={`egrid-td${recorded && !draw && !penalty ? " cell-id" : ""}`}>{pairing.resultWithdrawn ? <span className="result-withdrawn">ถอนผล</span> : !recorded ? "—" : penalty ? "ลงดาบ" : draw ? "เสมอ" : pairing.winnerId ?? "—"}</td>
              </tr>;
            })}
        </tbody>
      </table>
    </div>
  );
}
