"use client";

import { AlertTriangle, ArrowLeft, CheckCircle2, ChevronDown, ChevronRight, Filter, Gamepad2, LoaderCircle, Pencil, Save, SaveAll, Search, Shuffle, Undo2, X } from "lucide-react";
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type ComponentPropsWithRef, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { Pairing, Player } from "@/domain/tournament/types";
import { matchesPlayerCode, normalizePlayerCode, parseSearchQuery } from "@/domain/tournament/player-code";
import { isVoidPairing } from "@/domain/tournament/pairing-slot";
import { ScoreInput } from "@/ui/components/score-input";
import { isUnusualScore, scoreWarnings } from "@/domain/tournament/score-warnings";
import { appDialog } from "@/application/ui/dialog";
import { useUnsavedChangesWarning } from "@/application/ui/use-unsaved-changes-warning";
import { useTournamentStore, type RemoteResultChange, type RemoteResultNotice } from "@/application/tournament/store";
import { ConfirmDialog } from "@/ui/components/confirm-dialog";
import { Badge } from "@/ui/components/badge";
import { useResizableColumns, type GridColumnBase } from "@/ui/components/data-grid";
import { DirectPlayerSwap } from "@/ui/components/direct-player-swap";

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
  waiting?: boolean;
}

interface PairingEditConfig {
  onSwap: (a: string, b: string, password: string) => Promise<boolean>;
  swapDisabled?: boolean;
  swapTitle?: string;
  seats?: boolean;
}

/**
 * `void` is internal: it has no entry in `STATUS_OPTIONS`, so it shows under "ทุกสถานะ" and is
 * filtered out of every named status. A slot holding nobody is not a state the operator manages —
 * offering "ยังไม่ได้กรอก" for it would invite them to go looking for a match that does not exist.
 */
type RowStatus = "pending" | "empty" | "dirty" | "saved" | "void";

/** Revision 19 reserves three icon slots for Director and two for Staff. */
export const ACTION_WIDTH = { director: 110, staff: 78 } as const;

const EDIT_COLUMNS_BASE: GridColumnBase[] = [
  { key: "pair", label: "คู่", min: 32, fitMin: 42, width: 42, align: "center" },
  { key: "id1", label: "รหัส 1", min: 56, fitMin: 66, width: 66, filterKind: "playerCode", field: "code" },
  { key: "name1", label: "ชื่อ-นามสกุล", min: 90, fitMin: 90, width: 150, field: "name" },
  { key: "school1", label: "โรงเรียน/สถาบัน", min: 90, fitMin: 90, width: 140, field: "school" },
  { key: "id2", label: "รหัส 2", min: 56, fitMin: 66, width: 66, filterKind: "playerCode", searchable: false, field: "code" },
  { key: "name2", label: "ชื่อ-นามสกุล", min: 90, fitMin: 90, width: 150, searchable: false, field: "name" },
  { key: "school2", label: "โรงเรียน/สถาบัน", min: 90, fitMin: 90, width: 140, searchable: false, field: "school" },
  { key: "score1", label: "คะแนน 1", min: 52, fitMin: 66, width: 66, align: "center" },
  { key: "score2", label: "คะแนน 2", min: 52, fitMin: 66, width: 66, align: "center" },
  { key: "diff", label: "ผลต่าง", min: 58, fitMin: 65, width: 65, align: "center" },
];

/** The 11 edit columns, with จัดการ floored to whatever the viewer's role can actually put in it. */
export const editColumns = (canPenalty: boolean): GridColumnBase[] => {
  const action = canPenalty ? ACTION_WIDTH.director : ACTION_WIDTH.staff;
  return [...EDIT_COLUMNS_BASE, { key: "action", label: "จัดการ", min: action, fitMin: action, width: action }];
};

const VIEW_COLUMNS: GridColumnBase[] = [
  { key: "pair", label: "คู่", min: 32, width: 42, align: "center" },
  { key: "id1", label: "รหัส 1", min: 58, width: 64, filterKind: "playerCode", field: "code" },
  { key: "name1", label: "ชื่อ-นามสกุล", min: 90, width: 138, field: "name" },
  { key: "school1", label: "โรงเรียน/สถาบัน", min: 90, width: 132, field: "school" },
  { key: "id2", label: "รหัส 2", min: 58, width: 64, filterKind: "playerCode", searchable: false, field: "code" },
  { key: "name2", label: "ชื่อ-นามสกุล", min: 90, width: 138, searchable: false, field: "name" },
  { key: "school2", label: "โรงเรียน/สถาบัน", min: 90, width: 132, searchable: false, field: "school" },
  { key: "score1", label: "คะแนน 1", min: 64, width: 70, fitMin: 64, align: "center" },
  { key: "score2", label: "คะแนน 2", min: 64, width: 70, fitMin: 64, align: "center" },
  { key: "diff", label: "ผลต่าง", min: 50, width: 65, align: "center" },
  { key: "winner", label: "ผู้ชนะ", min: 58, width: 64, filterKind: "playerCode" },
];

const STATUS_OPTIONS: { value: "all" | RowStatus; label: string }[] = [
  { value: "all", label: "ทุกสถานะ" },
  { value: "empty", label: "ยังไม่ได้กรอก" },
  { value: "dirty", label: "กรอกแล้ว ยังไม่บันทึก" },
  { value: "saved", label: "บันทึกแล้ว" },
  { value: "pending", label: "รอผลจากเกมก่อนหน้า" },
];

const SCORE_FIELDS = {
  code: { label: "รหัสผู้เล่น", placeholder: "เช่น 16, 19 หรือ B016", hint: "พิมพ์รหัสเต็มหรือเลขท้ายแบบตรงตัว คั่นหลายรหัสด้วยเว้นวรรคหรือจุลภาค" },
  name: { label: "ชื่อ-นามสกุล", placeholder: "พิมพ์ชื่อหรือนามสกุล", hint: "ถ้าชื่อคล้ายกัน ใช้รหัสและโรงเรียนใต้ชื่อช่วยเลือก" },
  school: { label: "โรงเรียน/สถาบัน", placeholder: "พิมพ์ชื่อโรงเรียนหรือสถาบัน", hint: "เลือกหนึ่งหรือหลายสถาบันเพื่อดูทุกคู่ที่มีผู้เล่นจากสถาบันนั้น" },
} as const;

type ScoreFilterKey = keyof typeof SCORE_FIELDS;
type ScoreFilters = Partial<Record<ScoreFilterKey, ReadonlySet<string>>>;
type ScoreFilterOption = { value: string; title: string; detail: string };
type ScoreFilterMenu = { trigger: HTMLElement; field?: ScoreFilterKey; kind: "filter" | "help" };

function ScorePopover({ menu, title, width, children, onClose }: {
  menu: ScoreFilterMenu; title: string; width: number; children: React.ReactNode; onClose: (restoreFocus?: boolean) => void;
}) {
  const popup = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{ style: CSSProperties; side?: "up" | "down"; sheet?: boolean }>({ style: { visibility: "hidden" } });

  useEffect(() => {
    const position = (event?: Event) => {
      if (event?.target instanceof Node && popup.current?.contains(event.target)) return;
      const rect = menu.trigger.getBoundingClientRect();
      const maxWidth = Math.min(window.innerWidth - 16, width);
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const minHeight = menu.kind === "help" ? 60 : 160;
      if (Math.max(above, below) < minHeight) { setPlacement({ style: {}, sheet: true }); return; }
      const up = below < Math.min(minHeight * 1.6, popup.current?.scrollHeight ?? 0) && above > below;
      const left = Math.max(8, Math.min(window.innerWidth - maxWidth - 8, rect.left + maxWidth <= window.innerWidth - 8 ? rect.left : rect.right - maxWidth));
      setPlacement({ side: up ? "up" : "down", style: {
        width: maxWidth,
        maxHeight: up ? above : below,
        left,
        ...(up ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
      } });
    };
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !popup.current?.contains(event.target) && !menu.trigger.contains(event.target)) onClose(false);
    };
    position();
    const focus = window.requestAnimationFrame(() => {
      const initial = popup.current?.querySelector<HTMLElement>("input[data-initial-focus], input:checked") ?? popup.current?.querySelector("button");
      initial?.focus({ preventScroll: true });
    });
    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.cancelAnimationFrame(focus);
      document.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [menu, onClose, width]);

  return createPortal(<>
    {placement.sheet && <div className="pop-scrim" aria-hidden="true" />}
    <div ref={popup} className={`pop pop--${menu.kind === "help" ? "help" : "director-filter"}${placement.sheet ? " pop--sheet" : ""}`}
      role="dialog" aria-label={title} data-side={placement.side} style={placement.style}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
      {placement.sheet && <div className="pop__head"><strong>{title}</strong><button type="button" className="pop__x" aria-label="ปิด" onClick={() => onClose()}><X size={18} /></button></div>}
      {children}
    </div>
  </>, menu.trigger.closest(".ctwe-prototype") ?? document.body);
}

function ScoreFilter({ menu, status, counts, filters, options, onApplyStatus, onFilter, onClear, onClose }: {
  menu: ScoreFilterMenu; status: RowStatus | "all"; counts: Record<string, number>; filters: ScoreFilters;
  options: Record<ScoreFilterKey, ScoreFilterOption[]>; onApplyStatus: (status: RowStatus | "all") => void;
  onFilter: (field: ScoreFilterKey, values: ReadonlySet<string>) => void; onClear: () => void; onClose: (restoreFocus?: boolean) => void;
}) {
  const [field, setField] = useState(menu.field);
  const [pendingStatus, setPendingStatus] = useState(status);
  const [search, setSearch] = useState("");
  const [manual, setManual] = useState(false);
  const [draft, setDraft] = useState<ReadonlySet<string>>(() => new Set(menu.field ? filters[menu.field] : undefined));
  const heading = field ? SCORE_FIELDS[field].label : "ตัวกรองการแข่งขัน";
  const terms = search.trim().toLocaleLowerCase("th").split(/\s+/);
  const codeSearch = parseSearchQuery(search);
  const visible = field ? options[field].filter(({ value, title }) => !search.trim() || (field === "code" ? codeSearch.kind === "codes" && codeSearch.tokens.some((code) => matchesPlayerCode(value, code)) : terms.every((term) => title.toLocaleLowerCase("th").includes(term)))) : [];
  const selected = search.trim() && !manual ? new Set(visible.map((option) => option.value)) : draft;
  const hasFilters = status !== "all" || Object.keys(filters).length > 0;
  const allVisibleSelected = visible.length > 0 && visible.every(({ value }) => draft.has(value));

  const selectField = (next?: ScoreFilterKey) => {
    setField(next);
    setSearch("");
    setManual(false);
    setDraft(new Set(next ? filters[next] : undefined));
  };
  const toggle = (values: Iterable<string>, checked: boolean) => {
    setManual(true);
    setDraft((previous) => {
      const next = new Set(previous);
      for (const value of values) { if (checked) next.add(value); else next.delete(value); }
      return next;
    });
  };
  const apply = () => {
    if (field && selected.size === 0) return;
    if (field) onFilter(field, selected.size === options[field].length ? new Set() : selected);
    onApplyStatus(pendingStatus);
    onClose();
  };
  const clear = () => {
    if (field) onFilter(field, new Set());
    else onClear();
    onClose();
  };

  return <ScorePopover menu={menu} title={heading} width={340} onClose={onClose}>
    <div className="dir-filter-ui">
      <div className="dir-filter-head"><span>
        {field && !menu.field && <button type="button" className="btn btn--sm btn--ghost" aria-label="กลับไปตัวกรองทั้งหมด" onClick={() => selectField()}><ArrowLeft size={15} /></button>}
        <h3>{heading}</h3>
      </span><button type="button" className="btn btn--sm btn--ghost" data-pop-close aria-label="ปิดตัวกรอง" onClick={() => onClose()}><X size={16} /></button></div>
      {field ? <>
        <p className="dir-filter-hint">{SCORE_FIELDS[field].hint} · ใช้กับผู้เล่นทั้งสองฝั่ง</p>
        <label className="cf__search"><Search size={15} /><input key={field} type="search" autoFocus data-initial-focus autoComplete="off"
          placeholder={SCORE_FIELDS[field].placeholder} aria-label={`ค้นหา${heading}`} value={search} onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); apply(); } }} /></label>
        <div className="dir-filter-select"><button type="button" className="btn btn--ghost btn--sm" disabled={!visible.length}
          onClick={() => toggle(visible.map(({ value }) => value), !allVisibleSelected)}>{allVisibleSelected ? "ยกเลิกเลือกในรายการ" : "เลือกทั้งหมดในรายการ"}</button>
          <span role="status">{search.trim() && !manual ? `พบ ${visible.length} รายการ` : `เลือก ${draft.size} รายการ`}</span></div>
        <div className="dir-filter-list" aria-label={heading}>
          {visible.length ? visible.map(({ value, title, detail }) => <label className="dir-filter-option" key={value}>
            <input type="checkbox" checked={draft.has(value)} onChange={(event) => toggle([value], event.target.checked)} />
            <span className="dir-filter-value"><b>{title}</b><small>{detail}</small></span>
          </label>) : <p className="dir-filter-empty">ไม่พบรายการที่ตรงกับคำค้น</p>}
        </div>
      </> : <>
        <fieldset className="dir-filter-status"><legend>สถานะการบันทึก</legend>
          {STATUS_OPTIONS.filter(({ value }) => value !== "pending" || counts.pending > 0 || pendingStatus === "pending").map(({ value, label }) => <label className="dir-filter-option" key={value}>
            <input type="radio" name="score-filter-status" checked={pendingStatus === value} onChange={() => setPendingStatus(value)} /><span>{label}</span><small>{counts[value] ?? 0}</small>
          </label>)}
        </fieldset>
        <div className="dir-filter-keys">{(Object.keys(SCORE_FIELDS) as ScoreFilterKey[]).map((key) => <button type="button" key={key} onClick={() => selectField(key)}>
          <span>{SCORE_FIELDS[key].label}{filters[key] && <small> · {filters[key].size} ค่า</small>}</span><ChevronRight size={15} />
        </button>)}</div>
      </>}
      <div className="dir-filter-footer"><button type="button" className="btn btn--ghost" disabled={!field && !hasFilters} onClick={clear}>{field ? "ล้างตัวกรองนี้" : "ล้างทั้งหมด"}</button>
        <button type="button" className="btn btn--primary" disabled={Boolean(field && !selected.size)} onClick={apply}>ใช้ตัวกรอง</button></div>
    </div>
  </ScorePopover>;
}

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

function EntryScoreInput({ onChange, onBlur, value, ...props }: ComponentPropsWithRef<"input">) {
  const [checked, setChecked] = useState(false);
  const text = String(value ?? "");
  const invalid = checked && text !== "" && (!/^-?\d+$/.test(text) || Number(text) < Number(props.min ?? MIN_SCORE) || Number(text) > MAX_SCORE);
  return <ScoreInput {...props} type="text" inputMode="numeric" value={value}
    aria-invalid={invalid || undefined} title={invalid ? `กรอกจำนวนเต็มระหว่าง ${props.min ?? MIN_SCORE} ถึง ${MAX_SCORE}` : props.title}
    onChange={(event) => {
      if (!/^-?\d*$/.test(event.target.value)) return;
      setChecked(false);
      onChange?.(event);
    }}
    onBlur={(event) => { setChecked(true); onBlur?.(event); }} />;
}

function QuickCodeInput({ prefix, side, value, ref, onChange, onKeyDown }: {
  prefix: string; side: string; value: string; ref: React.RefObject<HTMLInputElement | null>;
  onChange: (value: string) => void; onKeyDown: React.KeyboardEventHandler<HTMLInputElement>;
}) {
  const [checked, setChecked] = useState(false);
  const invalid = checked && value.length > 4;
  return <label className="dir-field score-code-field">
    <span className="score-code-prefix" aria-hidden="true">{prefix}</span>
    <input ref={ref} className="kid" inputMode="numeric" autoComplete="off" placeholder="เลขรหัส" value={value}
      aria-label={`เลขท้ายรหัสฝ่าย ${side} ขึ้นต้นด้วย ${prefix}`} aria-invalid={invalid || undefined}
      title={invalid ? "เลขท้ายรหัสต้องไม่เกิน 4 หลัก" : undefined}
      onChange={(event) => {
        if (!/^\d*$/.test(event.target.value)) return;
        setChecked(false);
        onChange(event.target.value);
      }} onBlur={() => setChecked(true)} onKeyDown={onKeyDown} />
  </label>;
}

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
  onForceBye?: (pairing: Pairing) => void;
}

export function PenaltySword({ size = 16 }: { size?: number }) {
  return <svg className="i" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 2v5M8 7h8M10 7v8l2 4 2-4V7M4 21h16M7 18l-2-2m12 2 2-2" />
  </svg>;
}

function ScoreRowActions({ locked, saving, editable, valid, onSave, onEdit, onCancel, onPenalty }: {
  locked: boolean; saving: boolean; editable: boolean; valid: boolean;
  onSave: () => void; onEdit: () => void; onCancel: () => void; onPenalty?: () => void;
}) {
  return <span className="acts-cell score-row-actions">
    {locked ? <button type="button" className="btn btn--sm btn--secondary dir-row-icon" data-act="edit" aria-label="แก้ไขคะแนน" title="แก้ไขคะแนน" onClick={onEdit}><Pencil size={15} /></button>
      : <button type="button" className="btn btn--sm btn--success dir-row-icon" data-act="save-row" aria-label="บันทึกคู่" title={saving ? "กำลังบันทึก" : "บันทึกคะแนน"} disabled={!valid || saving} onClick={onSave}>
        {saving ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}
      </button>}
    {!locked && editable && <button type="button" className="btn btn--sm btn--ghost dir-row-icon" data-act="cancel-edit" aria-label="ยกเลิกแก้ไข" title="ยกเลิกแก้ไข" disabled={saving} onClick={onCancel}><X size={15} /></button>}
    {onPenalty && <button type="button" className="btn btn--sm btn--penalty dir-row-icon" data-act="penalty" aria-label="ลงดาบ" title="ลงดาบ บังคับแพ้ทั้งคู่" disabled={saving} onClick={onPenalty}><PenaltySword /></button>}
  </span>;
}

/**
 * One result-entry row, memoized. All inputs are primitives or references that stay stable while
 * another cell is being typed (the pairing, the players map, the callbacks), so React skips
 * re-rendering every other row on each keystroke — only the row whose score/flags changed updates.
 */
const ResultEntryRow = memo(function ResultEntryRow({
  slot, pairing, players, maxDiff, one, two, saved, changed, isEditing, saving, failed, savingAll,
  highlight, onDraft, onSaveRow, onSaveBye, onStartEdit, onCancelEdit, onFocusNext, onPenalty, onRevokePenalty, onForceBye,
}: ResultEntryRowProps) {
  // A slot holding nobody: no players, no result to enter, and nothing to wait for. It keeps its
  // row so pair numbers still line up with the printed table cards and the source game beside it,
  // and says nothing else — a "รอ…" here would describe a match that does not exist, and a badge
  // would make a non-event look like a state the operator has to clear.
  if (slot.isVoid || (!slot.waiting && isVoidPairing(pairing))) {
    return <tr className="egrid-row">
      <td className="c egrid-td egrid-td--center cell-pair"><b>{slot.tableNumber}</b></td>
      <td className="cid egrid-td cell-id">—</td>
      <td className="egrid-td cell-person-name">—</td>
      <td className="egrid-td cell-person-school">—</td>
      <td className="cid egrid-td cell-id">—</td>
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
    return <tr className={`egrid-row locked egrid-row--locked egrid-row--penalty${pairing.playerOneGibsonized || pairing.playerTwoGibsonized ? " gibson egrid-row--gibson" : ""}`}>
      <td className="c egrid-td egrid-td--center cell-pair"><b>{pairing.tableNumber}</b></td>
      <td className="cid egrid-td cell-id">{p1?.id ?? "—"}</td>
      <td className={`egrid-td cell-person-name${pairing.playerOneGibsonized ? " gibcell cell-gibsonized" : ""}`} title={`${p1?.firstName ?? ""} ${p1?.lastName ?? ""}`}><PlayerNameWithGibsonMark player={p1} fallback="บาย (ไม่มีคู่แข่ง)" gibsonized={pairing.playerOneGibsonized} /></td>
      <td className="egrid-td cell-person-school" title={p1?.school}>{p1?.school ?? "—"}</td>
      <td className="cid egrid-td cell-id">{p2?.id ?? "—"}</td>
      <td className={`egrid-td cell-person-name${pairing.playerTwoGibsonized ? " gibcell cell-gibsonized" : ""}`} title={`${p2?.firstName ?? ""} ${p2?.lastName ?? ""}`}><PlayerNameWithGibsonMark player={p2} fallback="บาย (ไม่มีคู่แข่ง)" gibsonized={pairing.playerTwoGibsonized} /></td>
      <td className="egrid-td cell-person-school" title={p2?.school}>{p2?.school ?? "—"}</td>
      <td className="score-cell"><input className="sc" disabled placeholder="ลงดาบ" /></td>
      <td className="score-cell"><input className="sc" disabled placeholder="ลงดาบ" /></td>
      <td className="c diff-pen">-{penalty}</td>
      <td className="egrid-td cell-action"><span className="acts-cell">
        {onRevokePenalty
          ? <button type="button" className="btn btn--sm btn--secondary dir-row-icon" aria-label="ถอนดาบเพื่อกลับไปกรอกผลใหม่" title="ถอนดาบเพื่อกลับไปกรอกผลใหม่" onClick={() => onRevokePenalty(pairing)}><Undo2 size={15} /></button>
          : <span className="badge badge--danger">ลงดาบ</span>}
      </span></td>
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
        <td className="cid egrid-td cell-id">{present?.id ?? "—"}</td>
        <td className={`egrid-td cell-person-name${(side === "one" ? pairing.playerOneGibsonized : pairing.playerTwoGibsonized) ? " gibcell cell-gibsonized" : ""}`} title={`${present?.firstName ?? ""} ${present?.lastName ?? ""}`}><PlayerNameWithGibsonMark player={present} fallback="—" gibsonized={side === "one" ? pairing.playerOneGibsonized : pairing.playerTwoGibsonized} /></td>
        <td className="egrid-td cell-person-school" title={present?.school}>{present?.school ?? "—"}</td>
      </>
    );
    const byeCell = (
      <>
        <td className="cid egrid-td cell-id">—</td>
        <td className="egrid-td cell-person-name cell-bye">บาย (ไม่มีคู่แข่ง)</td>
        <td className="egrid-td cell-person-school">—</td>
      </>
    );
    const scoreInput = (
      <td className="score-cell"><EntryScoreInput className="sc egrid-score" min={1} aria-label={`คะแนน ${present?.id}`} placeholder="คะแนน" value={value} disabled={disabled}
        onChange={(event) => onDraft(pairing.id, side, event.target.value, base)} onFocus={(event) => event.target.select()}
        onKeyDown={async (event) => { if (event.key !== "Enter") return; event.preventDefault(); await onSaveBye(pairing); }} /></td>
    );
    const byeScore = <td className="score-cell"><input className="sc egrid-score" disabled value="" readOnly placeholder="บาย" /></td>;
    return <tr id={`entry-${pairing.id}`} className={`egrid-row egrid-row--bye${pairing.playerOneGibsonized || pairing.playerTwoGibsonized ? " gibson egrid-row--gibson" : ""}${changed ? " dirty" : ""}${locked ? " locked" : ""}${failed ? " failed" : ""}`}>
      <td className="c egrid-td egrid-td--center cell-pair"><b>{pairing.tableNumber}</b></td>
      {side === "one" ? presentCell : byeCell}
      {side === "one" ? byeCell : presentCell}
      {side === "one" ? scoreInput : byeScore}
      {side === "one" ? byeScore : scoreInput}
      <td className="c">—</td>
      <td><ScoreRowActions locked={locked} saving={saving || savingAll} editable={saved && isEditing} valid={valid && changed}
        onSave={() => void onSaveBye(pairing)} onEdit={() => onStartEdit(pairing.id)} onCancel={() => onCancelEdit(pairing.id)}
        onPenalty={onPenalty && (() => onPenalty(pairing))} /></td>
    </tr>;
  }
  if (!isCompletePairing(pairing)) {
    const p1 = pairing?.playerOneId ? players.get(pairing.playerOneId) : undefined;
    const p2 = pairing?.playerTwoId ? players.get(pairing.playerTwoId) : undefined;
    const waitingText = p1 || p2 ? "รอคู่แข่งจากอีก row" : "รอผลจากเกมก่อนหน้า";
    return <tr className={`egrid-row egrid-row--pending${pairing?.playerOneGibsonized || pairing?.playerTwoGibsonized ? " egrid-row--gibson" : ""}`}>
      <td className="c egrid-td egrid-td--center cell-pair"><b>{slot.tableNumber}</b></td>
      <td className="cid egrid-td cell-id">{p1?.id ?? "—"}</td>
      <td className={`egrid-td cell-person-name${pairing?.playerOneGibsonized ? " gibcell cell-gibsonized" : ""}`} title={`${p1?.firstName ?? ""} ${p1?.lastName ?? ""}`}><PlayerNameWithGibsonMark player={p1} fallback={waitingText} gibsonized={pairing?.playerOneGibsonized} /></td>
      <td className="egrid-td cell-person-school" title={p1?.school}>{p1?.school ?? "—"}</td>
      <td className="cid egrid-td cell-id">{p2?.id ?? "—"}</td>
      <td className={`egrid-td cell-person-name${pairing?.playerTwoGibsonized ? " gibcell cell-gibsonized" : ""}`} title={`${p2?.firstName ?? ""} ${p2?.lastName ?? ""}`}><PlayerNameWithGibsonMark player={p2} fallback={waitingText} gibsonized={pairing?.playerTwoGibsonized} /></td>
      <td className="egrid-td cell-person-school" title={p2?.school}>{p2?.school ?? "—"}</td>
      <td className="score-cell"><input className="sc egrid-score" disabled value="" readOnly placeholder="—" /></td>
      <td className="score-cell"><input className="sc egrid-score" disabled value="" readOnly placeholder="—" /></td>
      <td className="egrid-td egrid-td--center cell-diff">—</td>
      <td className="egrid-td cell-action">{onForceBye && pairing && (p1 || p2) && !pairing.resultType
        ? <button type="button" className="btn btn--sm btn--secondary" data-force-bye={pairing.id} onClick={() => onForceBye(pairing)}>ให้บาย</button>
        : <Badge tone="neutral">{p1 || p2 ? "รออีกฝั่ง" : "รอข้อมูล"}</Badge>}</td>
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
  return <tr id={`entry-${pairing.id}`} className={`egrid-row${pairing.playerOneGibsonized || pairing.playerTwoGibsonized ? " gibson egrid-row--gibson" : ""}${changed ? " dirty" : ""}${locked ? " locked" : ""}${failed ? " failed" : ""}${highlight ? " flash" : ""}`}>
    <td className="c egrid-td egrid-td--center cell-pair"><b>{pairing.tableNumber}</b></td>
    <td className="cid egrid-td cell-id">{p1?.id}</td>
    <td className={`egrid-td cell-person-name${pairing.playerOneGibsonized ? " gibcell cell-gibsonized" : ""}`} title={`${p1?.firstName ?? ""} ${p1?.lastName ?? ""}`}><PlayerNameWithGibsonMark player={p1} fallback="—" gibsonized={pairing.playerOneGibsonized} /></td>
    <td className="egrid-td cell-person-school" title={p1?.school}>{p1?.school}</td>
    <td className="cid egrid-td cell-id">{p2?.id}</td>
    <td className={`egrid-td cell-person-name${pairing.playerTwoGibsonized ? " gibcell cell-gibsonized" : ""}`} title={`${p2?.firstName ?? ""} ${p2?.lastName ?? ""}`}><PlayerNameWithGibsonMark player={p2} fallback="—" gibsonized={pairing.playerTwoGibsonized} /></td>
    <td className="egrid-td cell-person-school" title={p2?.school}>{p2?.school}</td>
    <td className="score-cell"><EntryScoreInput className="sc egrid-score" aria-label={`คะแนน ${p1?.id}`} placeholder={p1?.id} value={one} disabled={disabled} onChange={(event) => onDraft(pairing.id, "one", event.target.value, base)} onFocus={(event) => event.target.select()} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); onFocusNext(event.currentTarget, "other"); } }} /></td>
    <td className="score-cell"><EntryScoreInput className="sc egrid-score" aria-label={`คะแนน ${p2?.id}`} placeholder={p2?.id} value={two} disabled={disabled} onChange={(event) => onDraft(pairing.id, "two", event.target.value, base)} onFocus={(event) => event.target.select()} onKeyDown={async (event) => { if (event.key !== "Enter") return; event.preventDefault(); const origin = event.currentTarget; if (await onSaveRow(pairing)) onFocusNext(origin, "next"); }} /></td>
    <td className="c num">
      {outcome ? (!outcome.diff ? "0" : `±${outcome.diff}`) : "—"}
      {unusual.length > 0 && <span className="warn-mark" title={unusual.map((code) => `คะแนน ${code} ผิดปกติ`).join(" · ")} aria-label={`คะแนนผิดปกติ: ${unusual.join(", ")}`}>!</span>}
    </td>
    <td><ScoreRowActions locked={locked} saving={saving || savingAll} editable={saved && isEditing} valid={Boolean(outcome && changed)}
      onSave={() => void onSaveRow(pairing)} onEdit={() => onStartEdit(pairing.id)} onCancel={() => onCancelEdit(pairing.id)}
      onPenalty={onPenalty && (() => onPenalty(pairing))} /></td>
  </tr>;
});

export function ResultEntryGrid({ gameNumber, slots, players, maxDiff, storageKey, onSubmit, onPenalty, onRevokePenalty, onForceBye, pairingEdit, codePrefix = "P" }: {
  gameNumber: number;
  codePrefix?: string;
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
  onForceBye?: (pairing: Pairing) => void;
  /** Director-only pairing edit during result collection. Swaps require password re-authentication. */
  pairingEdit?: PairingEditConfig;
}) {
  const quickId = useId();
  const swapId = useId();
  const [status, setStatus] = useState<"all" | RowStatus>("all");
  const [filters, setFilters] = useState<ScoreFilters>({});
  const [menu, setMenu] = useState<ScoreFilterMenu | null>(null);
  const closeMenu = useCallback((restoreFocus = true) => {
    setMenu(null);
    if (restoreFocus) menu?.trigger.focus({ preventScroll: true });
  }, [menu]);
  const toggleMenu = (trigger: HTMLElement, kind: ScoreFilterMenu["kind"], field?: ScoreFilterKey) => {
    setMenu((previous) => previous?.trigger === trigger ? null : { trigger, kind, field });
  };
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
  const { colWidths, totalWidth, scrollRef, startResize } = useResizableColumns(columns, `${storageKey}:rev19:${canPenalty ? "dir" : "staff"}`);
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
    if (slot.isVoid || (!slot.waiting && isVoidPairing(pairing))) return { slot, pairing, status: "void" as RowStatus };
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

  // Count and list each school once per match, even when both players attend it. The name filter
  // retains player IDs so two players with the same name can be selected independently.
  const filterOptions = useMemo(() => {
    const codes = new Map<string, Player>();
    const schools = new Map<string, number>();
    for (const { pairing } of slots) {
      const pairSchools = new Set<string>();
      for (const id of [pairing?.playerOneId, pairing?.playerTwoId]) {
        const player = id ? players.get(id) : undefined;
        if (!player) continue;
        codes.set(player.id, player);
        if (player.school) pairSchools.add(player.school);
      }
      for (const school of pairSchools) schools.set(school, (schools.get(school) ?? 0) + 1);
    }
    const order = (a: ScoreFilterOption, b: ScoreFilterOption) => a.title.localeCompare(b.title, "th", { numeric: true });
    return {
      code: [...codes.values()].map((player) => ({ value: player.id, title: player.id, detail: `${player.firstName} ${player.lastName}` })).sort(order),
      name: [...codes.values()].map((player) => ({ value: player.id, title: `${player.firstName} ${player.lastName}`, detail: `${player.id} · ${player.school}` })).sort(order),
      school: [...schools].map(([school, count]) => ({ value: school, title: school, detail: `${count} คู่` })).sort(order),
    };
  }, [slots, players]);
  const filtered = useMemo(() => {
    const chosen = Object.entries(filters);
    return rows.filter((row) => (status === "all" || row.status === status) && chosen.every(([field, values]) =>
      [row.pairing?.playerOneId, row.pairing?.playerTwoId].some((id) => id && values.has(field === "school" ? players.get(id)?.school ?? "" : id))));
  }, [rows, filters, players, status]);

  const filterCount = Object.keys(filters).length + Number(status !== "all");
  const statusCounts = rows.reduce<Record<string, number>>((counts, row) => { counts[row.status] = (counts[row.status] ?? 0) + 1; return counts; }, { all: rows.length });
  const savedCount = rows.filter((row) => row.status !== "void" && row.pairing && isRecorded(row.pairing)).length;
  const liveCount = rows.length - (statusCounts.void ?? 0);
  const dirtyCount = statusCounts.dirty ?? 0;
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
    if (![a, b].every((code) => /^\d{1,4}$/.test(code))) {
      setQuickFeedback({ type: "error", message: "เลขท้ายรหัสต้องเป็นตัวเลขไม่เกิน 4 หลัก" });
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

  const startEdit = useCallback((id: string) => {
    setEditing((previous) => new Set(previous).add(id));
    window.requestAnimationFrame(() => document.getElementById(`entry-${id}`)?.querySelector<HTMLInputElement>("input.egrid-score:not(:disabled)")?.focus({ preventScroll: true }));
  }, []);
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

  useEffect(() => {
    const focusRequestedPair = () => {
      const hash = window.location.hash.slice(1);
      if (!/^entry-g\d+t\d+$/.test(hash)) return;
      const row = document.getElementById(hash);
      const input = row?.querySelector<HTMLInputElement>("input.egrid-score:not(:disabled)");
      if (input) {
        row?.scrollIntoView({ block: "center", inline: "nearest" });
        input.focus({ preventScroll: true });
      }
    };
    const frame = window.requestAnimationFrame(focusRequestedPair);
    window.addEventListener("hashchange", focusRequestedPair);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", focusRequestedPair);
    };
  }, [gameNumber]);

  const conflict = conflicts[0] ?? null;

  return (
    <div className="entry-grid-wrap">
      <ConfirmDialog
        appearance="prototype"
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
        appearance="prototype"
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

      <div className="director-tools">
        <div className="dir-tool-head">
          {pairingEdit ? <div className="dir-tool-tabs" role="group" aria-label="เครื่องมือกรอกผล">
            <button type="button" aria-pressed={!swapOpen} aria-controls={quickId} onClick={() => {
              setSwapOpen(false);
              window.requestAnimationFrame(() => idARef.current?.focus({ preventScroll: true }));
            }}><Gamepad2 className="i" size={15} />คีย์เร็ว</button>
            <button type="button" aria-pressed={swapOpen} aria-controls={swapId} disabled={pairingEdit.swapDisabled}
              title={pairingEdit.swapTitle} onClick={() => {
                setSwapOpen(true);

              }}><Shuffle className="i" size={15} />สลับผู้เล่น</button>
          </div> : <span className="quick-entry-caption"><Gamepad2 className="i" size={15} />คีย์เร็ว</span>}
          <span><button type="button" className="help" aria-label={swapOpen ? "วิธีสลับผู้เล่น" : "วิธีคีย์เร็ว"} aria-haspopup="dialog"
            aria-expanded={menu?.kind === "help"} onClick={(event) => toggleMenu(event.currentTarget, "help")}>?</button></span>
        </div>
        <div id={quickId} data-score-tool="quick" className={`keyin entry-keyin${quickFeedback ? ` keyin--${quickFeedback.type}` : ""}`} hidden={swapOpen}>
          <div className="dir-tool-fields">
            <QuickCodeInput ref={idARef} prefix={codePrefix} side="A" value={qIdA}
              onChange={(value) => { clearFlash(); setQIdA(value); }}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); scoreARef.current?.focus(); scoreARef.current?.select(); } }} />
            <span className="dir-field"><EntryScoreInput ref={scoreARef} className="ksc" placeholder="คะแนน A" autoComplete="off" value={qScoreA} aria-label="คะแนนฝ่าย A"
              onChange={(event) => { clearFlash(); setQScoreA(event.target.value); }} onFocus={(event) => event.target.select()}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); idBRef.current?.focus(); idBRef.current?.select(); } }} /></span>
            <span className="dir-tool-join" aria-hidden="true"><ChevronRight className="i" size={15} /></span>
            <QuickCodeInput ref={idBRef} prefix={codePrefix} side="B" value={qIdB}
              onChange={(value) => { clearFlash(); setQIdB(value); }}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); scoreBRef.current?.focus(); scoreBRef.current?.select(); } }} />
            <span className="dir-field"><EntryScoreInput ref={scoreBRef} className="ksc" placeholder="คะแนน B" autoComplete="off" value={qScoreB} aria-label="คะแนนฝ่าย B"
              onChange={(event) => { clearFlash(); setQScoreB(event.target.value); }} onFocus={(event) => event.target.select()}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void quickSave(); } }} /></span>
            <button type="button" className="btn btn--success dir-tool-submit" disabled={quickSaving} onClick={() => void quickSave()}>
              {quickSaving ? <LoaderCircle className="i spin" size={15} /> : <Save className="i" size={15} />}บันทึกคะแนน
            </button>
            <span className="dir-tool-feedback" data-score-message="quick" role="status" title={quickFeedback?.message}>
              {quickFeedback && <>{quickFeedback.type === "success" ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}{quickFeedback.message}</>}
            </span>
          </div>
        </div>
        {pairingEdit && swapOpen && <div id={swapId} data-score-tool="swap">
          <DirectPlayerSwap players={[...players.values()]} pairings={slots.flatMap((slot) => slot.pairing ? [slot.pairing] : [])}
            game={gameNumber} seats={pairingEdit.seats} disabled={pairingEdit.swapDisabled || savingAll} autoFocus onSwap={pairingEdit.onSwap}
            lockReason={(pairing) => savingIds.has(pairing.id) ? "กำลังบันทึกผล" : rows.find((row) => row.pairing?.id === pairing.id)?.changed ? "มีร่างคะแนน" : undefined} />
        </div>}
      </div>

      {menu?.kind === "help" && <ScorePopover menu={menu} title={swapOpen ? "สลับผู้เล่น" : "คีย์เร็ว"} width={300} onClose={closeMenu}>
        <div className="dir-filter-ui">
          <div className="dir-filter-head"><h3>{swapOpen ? "สลับผู้เล่น" : "คีย์เร็ว"}</h3>
            <button type="button" className="btn btn--sm btn--ghost" data-pop-close aria-label="ปิดคำแนะนำ" onClick={() => closeMenu()}><X size={16} /></button></div>
          <p className="dir-filter-hint">{swapOpen
            ? "กรอกรหัสผู้เล่นสองคนแล้วกด Enter เพื่อไปช่องถัดไป ยืนยันด้วยรหัสผ่านผู้อำนวยการ ใช้ได้กับคู่ที่ยังไม่ได้กรอกผล"
            : "กรอกเฉพาะเลขท้ายรหัสผู้เล่น ใช้เลขนำหน้าศูนย์ได้หรือข้ามก็ได้ กด Enter ไล่ช่องแล้วบันทึก"}</p>
        </div>
      </ScorePopover>}
      {menu?.kind === "filter" && <ScoreFilter menu={menu} status={status} counts={statusCounts} filters={filters} options={filterOptions}
        onApplyStatus={setStatus} onFilter={(field, values) => setFilters((previous) => {
          const next = { ...previous };
          if (values.size) next[field] = values; else delete next[field];
          return next;
        })} onClear={() => { setFilters({}); setStatus("all"); }} onClose={closeMenu} />}

      <div className="gmeta director-gmeta">
        <span data-score-progress role="status">บันทึกแล้ว {savedCount}/{liveCount} คู่</span>
        {!pairingEdit && liveCount > 0 && savedCount === liveCount && <span className="meta">รอผู้อำนวยการตรวจและเผยแพร่</span>}
        {filterCount > 0 && <span className="meta">แสดง {filtered.length} คู่</span>}
        <span className="acts">
          <button type="button" className={`btn btn--secondary${filterCount ? " is-active" : ""}`} aria-haspopup="dialog"
            aria-expanded={menu?.kind === "filter" && !menu.field} onClick={(event) => toggleMenu(event.currentTarget, "filter")}>
            <Filter className="i" size={15} /><span>ตัวกรอง{filterCount ? ` (${filterCount})` : ""}</span>
          </button>
          <button type="button" className="btn btn--success" title="บันทึกคู่ที่กรอกครบในรายการที่แสดง" disabled={savingAll || filteredSavable.length === 0} onClick={() => void saveAll()}>
            {savingAll ? <LoaderCircle className="i spin" size={15} /> : <SaveAll className="i" size={15} />}บันทึกทั้งหมด
          </button>
        </span>
      </div>
      <div className="gscroll entry-grid-scroll--result-entry" ref={scrollRef}>
        <table className="eg score-entry-table" style={{ minWidth: totalWidth }} aria-label="กรอกผลการแข่งขัน">
          <colgroup>{columns.map((column, index) => <col key={column.key} style={{ width: colWidths[index] }} />)}</colgroup>
          <thead><tr>{columns.map((column, index) => {
            const field = column.field as ScoreFilterKey | undefined;
            const filter = field ? SCORE_FIELDS[field] : undefined;
            const active = Boolean(field && filters[field]);
            return <th key={column.key} scope="col">
              {filter ? <button type="button" className={`thb dir-column${active ? " on" : ""}`} aria-label={`กรอง${filter.label}ทั้งสองฝั่ง`}
                aria-haspopup="dialog" aria-expanded={Boolean(menu?.kind === "filter" && menu.field === field)}
                onClick={(event) => toggleMenu(event.currentTarget, "filter", field)}>
                <span>{column.label}</span><span className="fi">{active ? <Filter size={12} /> : <ChevronDown size={12} />}</span>
              </button> : <span className="thb thb--plain">{column.label}</span>}
              {index < columns.length - 1 && <span className="rz" aria-hidden="true" onPointerDown={(event) => {
                event.preventDefault(); document.body.classList.add("col-resizing"); startResize(index, event.clientX);
              }} />}
            </th>;
          })}</tr></thead>
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
                onForceBye={onForceBye}
                onRevokePenalty={onRevokePenalty}
              />;
            })}
          </tbody>
        </table>
      </div>

    </div>
  );
}

/** Revision 19 score sheet shared by review and the authenticated historical editor. */
export function ResultViewGrid({ pairings, players, renderScore }: {
  pairings: Pairing[];
  players: Map<string, Player>;
  renderScore?: (pairing: Pairing, side: "one" | "two", fallback: React.ReactNode) => React.ReactNode;
}) {
  return <div className="gscroll entry-grid-scroll">
    <table className="eg score-review-table" aria-label="ผลการแข่งขัน">
      <colgroup>{VIEW_COLUMNS.map((column) => <col key={column.key} style={column.field === "name" || column.field === "school" ? undefined : { width: column.width }} />)}</colgroup>
      <thead><tr>{VIEW_COLUMNS.map((column) => <th key={column.key} scope="col"><span className="thb thb--plain">{column.label}</span></th>)}</tr></thead>
      <tbody>
        {!pairings.length && <tr><td className="c score-empty" colSpan={VIEW_COLUMNS.length}>ยังไม่มีผลที่เผยแพร่</td></tr>}
        {pairings.map((pairing) => {
          const p1 = pairing.playerOneId ? players.get(pairing.playerOneId) : undefined;
          const p2 = pairing.playerTwoId ? players.get(pairing.playerTwoId) : undefined;
          const recorded = isRecorded(pairing);
          const draw = pairing.resultType === "DRAW";
          const penalty = pairing.resultType === "PENALTY";
          const diff = recordedDiff(pairing);
          const absentText = isVoidPairing(pairing) ? "—" : "บาย (ไม่มีคู่แข่ง)";
          const one = penalty ? "—" : p1 ? pairing.scoreOne ?? "—" : "บาย";
          const two = penalty ? "—" : p2 ? pairing.scoreTwo ?? "—" : "บาย";
          return <tr key={pairing.id} className={pairing.playerOneGibsonized || pairing.playerTwoGibsonized ? "gibson" : undefined}>
            <td className="c"><b>{pairing.tableNumber}</b></td>
            <td className="cid">{p1?.id}</td>
            <td className={pairing.playerOneGibsonized ? "gibcell" : undefined} title={p1 ? `${p1.firstName} ${p1.lastName}` : undefined}>
              <PlayerNameWithGibsonMark player={p1} fallback={isVoidPairing(pairing) ? "—" : ""} gibsonized={pairing.playerOneGibsonized} /></td>
            <td title={p1?.school}>{p1?.school}</td>
            <td className="cid">{p2?.id}</td>
            <td className={pairing.playerTwoGibsonized ? "gibcell" : undefined} title={p2 ? `${p2.firstName} ${p2.lastName}` : undefined}>
              <PlayerNameWithGibsonMark player={p2} fallback={absentText} gibsonized={pairing.playerTwoGibsonized} /></td>
            <td title={p2?.school}>{p2?.school}</td>
            <td className="c">{renderScore ? renderScore(pairing, "one", one) : one}</td>
            <td className="c">{renderScore ? renderScore(pairing, "two", two) : two}</td>
            <td className="c num">{penalty ? <span className="diff-pen">-{diff ?? 0}</span> : !recorded || !p1 || !p2 ? "—" : diff ? `±${diff}` : "0"}</td>
            <td className="c cid">{pairing.resultWithdrawn ? <span className="result-withdrawn">ถอนผล</span> : !recorded || penalty ? "—" : draw ? "เสมอ" : pairing.winnerId ?? "—"}</td>
          </tr>;
        })}
      </tbody>
    </table>
  </div>;
}
