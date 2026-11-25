"use client";

import { AlertTriangle, LoaderCircle, Shuffle, Undo2, UserMinus, UserPlus, Users, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { isBadPassword, useTournamentStore } from "@/application/tournament/store";
import type {
  PairingChangeSet,
  PairingValidation,
  Player,
  ScreeningHold,
  ScreeningReason,
  SlotState,
  TournamentCard,
} from "@/domain/tournament/types";
import { Button } from "@/ui/components/button";
import { ConfirmDialog } from "@/ui/components/confirm-dialog";
import { FreshSecretInput } from "@/ui/components/fresh-secret-input";
import { ForceCommitConfirm } from "@/ui/components/force-commit-confirm";
import { PairingDiffSheet } from "@/ui/components/pairing-diff-sheet";
import { type RosterEntry, buildRoster, seatsByPlayer } from "@/ui/components/pairing-roster";
import { SplitStack } from "@/ui/components/split-stack";
import { type SlotRow, type Staged, editedSlots, liveSlots, usePairingBaseline } from "@/ui/components/use-pairing-baseline";
import { useModalDialog } from "@/ui/overlay/use-modal-dialog";

/**
 * The Screening Pool and Multi Switching: one tool, two entry points.
 *
 *  - SCREEN mode — bulk-select players who have not turned up and hold them.
 *  - PLACE mode  — swap two competitors' seats, or move one into an empty one; repair the board.
 *
 * Both build the same change set, take the same path through validate → diff → commit, and produce
 * the same audit record. Staging is client-only and never persisted: the server holds the one source
 * of truth for pairings, and a server-side draft would be a second one.
 */

type Mode = "screen" | "place";
type Filter = "all" | "problems";

const REASONS: { value: ScreeningReason; label: string }[] = [
  { value: "NO_SHOW", label: "ไม่มาแข่ง" },
  { value: "LATE", label: "มาสาย" },
  { value: "MEDICAL", label: "เหตุสุขภาพ" },
  { value: "OTHER", label: "อื่น ๆ" },
];

/** Below this the tool does not render. A cramped version of an operation that can destroy
 *  competition results is worse than no version. */
const MIN_WIDTH = 1024;

const keyOf = (game: number, table: number) => `${game}:${table}`;

interface Props {
  card: TournamentCard;
  mode: Mode;
  open: boolean;
  onClose: () => void;
}

export function PairingTool({ card, mode, open, onClose }: Props) {
  const validatePairingChange = useTournamentStore((state) => state.validatePairingChange);
  const commitPairingChange = useTournamentStore((state) => state.commitPairingChange);
  const announcePairingPresence = useTournamentStore((state) => state.announcePairingPresence);
  const presence = useTournamentStore((state) => state.pairingPresence);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [staged, setStaged] = useState<Staged>(new Map());
  const [available, setAvailable] = useState<string[]>([]);
  const [held, setHeld] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [reason, setReason] = useState<ScreeningReason>("NO_SHOW");
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<PairingValidation | null>(null);
  /** Acknowledged warnings carried into the force confirmation, so nothing is re-asked there. */
  const [forcing, setForcing] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [wideEnough, setWideEnough] = useState(true);

  const dialog = useModalDialog({ open, onDismiss: onClose, dismissible: !busy });
  const { baseline, conflicts, conflictOf, rebase } = usePairingBaseline(card, open);

  useEffect(() => {
    const check = () => setWideEnough(window.innerWidth >= MIN_WIDTH);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // Reset staging on every open: a change set built against a board last seen ten minutes ago is
  // exactly what the per-slot precondition exists to reject, and it should not get that far.
  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setStaged(new Map());
    setAvailable([]);
    setHeld(null);
    setPreview(null);
    setForcing(null);
    setError("");
    setNote("");
    // Open on the problem filter only when there ARE problems. Defaulting to it unconditionally
    // greets a director with an empty list on a healthy board, which reads as a broken tool.
    const problems = liveSlots(card).filter(isProblem(new Map())).length;
    setFilter(mode === "place" && problems > 0 ? "problems" : "all");
  }, [open, mode]);

  // Announce arrival and departure so a second director sees the overlap before committing rather
  // than at it. Advisory only — it grants nothing and blocks nothing.
  useEffect(() => {
    if (!open) return;
    void announcePairingPresence(card.id, true);
    const leave = () => { void announcePairingPresence(card.id, false); };
    window.addEventListener("beforeunload", leave);
    return () => {
      window.removeEventListener("beforeunload", leave);
      leave();
    };
  }, [open, card.id, announcePairingPresence]);

  const players = useMemo(
    () => new Map(card.players.map((player) => [player.id, player])),
    [card.players],
  );
  const pool = card.screeningPool ?? [];
  const poolIds = useMemo(() => new Set(pool.map((hold) => hold.player)), [pool]);

  // What the operator sees: the frozen baseline with this session's staging applied on top.
  const rows: SlotRow[] = useMemo(() => baseline.map((slot) => {
    const override = staged.get(keyOf(slot.game, slot.table));
    return override ? { ...slot, one: override.one, two: override.two } : slot;
  }), [baseline, staged]);

  const rowIndex = useMemo(
    () => new Map(rows.map((slot) => [keyOf(slot.game, slot.table), slot])),
    [rows],
  );
  const seats = useMemo(() => seatsByPlayer(rows), [rows]);

  // Slots that differ from the board this session opened on — NOT slots that were merely touched.
  // Everything downstream keys off this: the blue row, the count, and what the commit carries.
  const edited = useMemo(
    () => editedSlots(baseline, staged, conflicts),
    [baseline, staged, conflicts],
  );

  // Every competitor on the board, always — the roster is derived from the same staged rows the left
  // column draws, so a swap reorders it the moment it is staged. Nobody has to be lifted first.
  const roster = useMemo(
    () => buildRoster(rows, available, (game, table) => conflicts.has(keyOf(game, table))),
    [rows, available, conflicts],
  );

  const others = presence?.cardId === card.id ? presence.actors : [];

  if (!open) return null;

  if (!wideEnough) {
    return (
      <div className="dialog-backdrop" role="presentation" onMouseDown={dialog.onBackdropMouseDown}>
        <section
          ref={dialog.ref as React.RefObject<HTMLElement>}
          tabIndex={-1}
          className="confirm-dialog pairing-tool pairing-tool--narrow"
          role="dialog"
          aria-modal="true"
          aria-labelledby={dialog.titleId}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <h2 id={dialog.titleId}>ต้องใช้จอที่กว้างกว่านี้</h2>
          <p className="page-description">
            เครื่องมือจัดคู่และ Screening Pool ใช้ได้บนเดสก์ท็อปและแท็บเล็ตเท่านั้น
            การย่อหน้าจอที่กดพลาดได้ง่ายไม่เหมาะกับงานที่แก้คู่การแข่งขันจริง
          </p>
          <footer>
            <Button variant="secondary" onClick={onClose}>ปิด</Button>
          </footer>
        </section>
      </div>
    );
  }

  // ---- staging -------------------------------------------------------------

  /** Write several seats in one transaction — a swap touches two, sometimes on the same slot. */
  const setSeats = (writes: { game: number; table: number; side: 1 | 2; code: string | null }[]) =>
    setStaged((current) => {
      const next = new Map(current);
      for (const write of writes) {
        const key = keyOf(write.game, write.table);
        const row = rowIndex.get(key);
        const now = next.get(key) ?? { one: row?.one ?? null, two: row?.two ?? null };
        next.set(key, write.side === 1 ? { ...now, one: write.code } : { ...now, two: write.code });
      }
      return next;
    });

  /**
   * Put the selected player into a seat.
   *
   * An occupied seat is a SWAP: the two players trade places, and the board never loses a seat. An
   * empty seat is a move, which is the same swap against nobody. Only a player who holds no seat of
   * their own — one coming back from the Screening Pool — can displace an occupant, and the occupant
   * they displace lands at the head of the roster and becomes the player in hand, so the gesture
   * chains until everybody is seated again. Available blocks the commit until they are, which is what
   * the "no active-but-unpaired" rule requires.
   */
  const place = (slot: SlotRow, side: 1 | 2) => {
    if (held === null) return;
    const occupant = side === 1 ? slot.one : slot.two;
    if (occupant === held) { setHeld(null); return; }

    const origin = seats.get(held) ?? null;
    // Half a swap is worse than none: a change to a conflicted slot is suspended from the commit, so
    // writing only the other half would seat one player twice and unseat the other for good.
    if (origin && conflicts.has(keyOf(origin.game, origin.table))) return;

    const writes: { game: number; table: number; side: 1 | 2; code: string | null }[] = [
      { game: slot.game, table: slot.table, side, code: held },
    ];
    // The player already sits somewhere: whoever was in the target seat takes the seat they vacate.
    if (origin) writes.push({ ...origin, code: occupant });

    setSeats(writes);
    setAvailable((list) => {
      const without = list.filter((code) => code !== held);
      return !origin && occupant !== null && !without.includes(occupant) ? [...without, occupant] : without;
    });
    setHeld(origin ? null : occupant);
  };

  const seatClick = (slot: SlotRow, side: 1 | 2) => {
    // A scored slot IS reachable in place mode — repairing a table that has already been played is
    // exactly what force commit exists for, and locking it here would make that path unreachable.
    // The collision surfaces in the diff sheet, where destroying the result takes its own
    // confirmation. Screen mode keeps it locked: screening must never destroy a result.
    if (conflictOf(slot.game, slot.table)) return;
    const occupant = side === 1 ? slot.one : slot.two;
    // Nothing in hand: pick this player up WITHOUT vacating their seat. Leaving a hole behind was the
    // old gesture and it made every single move a two-step repair.
    if (held !== null) place(slot, side);
    else if (occupant !== null) setHeld(occupant);
  };

  const pick = (code: string) => setHeld(held === code ? null : code);

  /**
   * Take a held player back out of the pair they were staged into.
   *
   * The seat they vacate goes empty rather than handing itself to whoever they displaced: guessing
   * which of the unseated belongs there would be wrong exactly when the board is most tangled. The
   * commit stays blocked until every unseated player has somewhere to sit, so nothing is lost by
   * making that placement explicit.
   */
  const recall = (code: string) => {
    const at = seats.get(code);
    if (!at || conflicts.has(keyOf(at.game, at.table))) return;
    setSeats([{ ...at, code: null }]);
    setAvailable((list) => list.filter((entry) => entry !== code));
    if (held === code) setHeld(null);
  };

  const toggle = (code: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });

  // ---- change set ----------------------------------------------------------

  const changeSet = (acknowledged: string[] = []): PairingChangeSet => {
    // A conflicted slot's staged change is suspended: the operator has not seen what it holds now,
    // so submitting it would be acting on a picture that is no longer true.
    const live = new Map(rows.map((slot) => [keyOf(slot.game, slot.table), slot]));
    const touched = new Set<string>();
    for (const key of edited) touched.add(key);
    for (const slot of baseline)
      if (occupants(slot).some((code) => code !== null && selected.has(code)))
        touched.add(keyOf(slot.game, slot.table));

    const expect: SlotState[] = [];
    const slots: SlotState[] = [];
    for (const key of touched) {
      const before = baseline.find((slot) => keyOf(slot.game, slot.table) === key);
      const after = live.get(key);
      if (!before || !after) continue;
      expect.push({ game: before.game, table: before.table, one: before.one, two: before.two });
      if (edited.has(key)) slots.push({ game: after.game, table: after.table, one: after.one, two: after.two });
    }

    const seatedNow = new Set(rows.flatMap((slot) => occupants(slot).filter((code): code is string => code !== null)));
    return {
      expect,
      slots,
      screen: [...selected].map((player) => ({ player, reason, note: note.trim() || undefined })),
      // Pool players who now occupy a seat leave the pool as part of this same commit.
      release: [...poolIds].filter((code) => seatedNow.has(code)),
      confirmWarnings: acknowledged,
    };
  };

  const stagedCount = edited.size;
  const nothingToDo = selected.size === 0 && stagedCount === 0;
  const blockedByAvailable = available.length > 0;

  const review = async () => {
    setBusy(true);
    setError("");
    try {
      setPreview(await validatePairingChange(card.id, changeSet()));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "ตรวจสอบไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  const commit = async (password: string, acknowledged: string[], force = false) => {
    setBusy(true);
    setError("");
    try {
      await commitPairingChange(card.id, changeSet(acknowledged), password, crypto.randomUUID(), force);
      onClose();
    } catch (failure) {
      setError(isBadPassword(failure) ? "รหัสผ่านไม่ถูกต้อง"
        : failure instanceof Error ? failure.message : "บันทึกไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Re-run the dry run WITH force, so the confirmation lists exactly what the forced commit will
   * destroy. The non-forced preview reports the collision; only the forced one reports whether each
   * result can actually be unwound.
   */
  const prepareForce = async (acknowledged: string[]) => {
    setBusy(true);
    setError("");
    try {
      const forced = await validatePairingChange(card.id, changeSet(acknowledged), true);
      setPreview(forced);
      if (forced.forceAvailable && forced.resultsToRemove.length > 0) setForcing(acknowledged);
      else setError("ลบผลของคู่เหล่านี้ไม่ได้ — มีผลอื่นที่คำนวณต่อจากผลนี้ไปแล้ว");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "ตรวจสอบไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  // Filter, never reorder: an operator finds table 7 by counting to 7, and re-sorting the list
  // destroys their map of the room at the moment they most need it.
  const problem = isProblem(conflicts);
  const visible = filter === "all" ? rows : rows.filter(problem);
  const problemCount = rows.filter(problem).length;

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={dialog.onBackdropMouseDown}>
      <section
        ref={dialog.ref as React.RefObject<HTMLElement>}
        tabIndex={-1}
        className="confirm-dialog pairing-tool"
        role="dialog"
        aria-modal="true"
        aria-labelledby={dialog.titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="pairing-tool__eyebrow">
              {mode === "screen" ? "Screening Mode" : "Multi Switching"}
            </span>
            <h2 id={dialog.titleId}>
              {mode === "screen" ? "พักผู้เล่นออกจากคู่ชั่วคราว" : "ย้ายผู้เล่นระหว่างคู่"} · เกม {card.currentGame}
            </h2>
          </div>
          <button type="button" className="confirm-dialog__close" onClick={onClose} aria-label="ปิด"><X size={18} /></button>
        </header>

        {others.length > 0 && (
          <p className="pairing-tool__presence" role="status">
            <Users size={14} /> {others.join(", ")} กำลังเปิดเครื่องมือนี้อยู่เช่นกัน — ตรวจสอบก่อนบันทึกเพื่อไม่ให้แก้ซ้ำกัน
          </p>
        )}

        <div className="pairing-tool__cols">
          <section className="pairing-tool__col" aria-label="คู่แข่งขันปัจจุบัน">
            <div className="pairing-tool__filters">
              <p className="pairing-tool__h">
                คู่แข่งขันปัจจุบัน
                {mode === "screen" ? ` · เลือกผู้เล่นที่ยังไม่มา (${selected.size} คน)` : ` · แก้ไขแล้ว ${stagedCount} คู่`}
              </p>
              <div className="pairing-tool__toggle" role="group" aria-label="ตัวกรองคู่แข่งขัน">
                <button type="button" className={filter === "all" ? "is-on" : ""} onClick={() => setFilter("all")}>
                  ทั้งหมด ({rows.length})
                </button>
                <button type="button" className={filter === "problems" ? "is-on" : ""} onClick={() => setFilter("problems")}>
                  ต้องแก้ ({problemCount})
                </button>
              </div>
            </div>

            {visible.length === 0 && <p className="page-description">ไม่มีคู่ที่ตรงกับตัวกรองนี้</p>}
            <ul className="pairing-tool__slots">
              {visible.map((slot) => {
                const conflict = conflictOf(slot.game, slot.table);
                const key = keyOf(slot.game, slot.table);
                return (
                  <li key={key} className={slotClass(slot, !!conflict, edited.has(key))}>
                    <span className="pairing-tool__no">คู่ที่ {slot.table}</span>
                    <span className="pairing-tool__pair">
                      <Seat code={slot.one} side={1} slot={slot} mode={mode} players={players}
                            selected={selected} held={held} locked={!!conflict}
                            onToggle={toggle} onClick={seatClick} />
                      <span className="pairing-tool__vs">พบ</span>
                      <Seat code={slot.two} side={2} slot={slot} mode={mode} players={players}
                            selected={selected} held={held} locked={!!conflict}
                            onToggle={toggle} onClick={seatClick} />
                    </span>
                    {slot.hasResult && <span className="pairing-tool__tag">กรอกผลแล้ว</span>}
                    {slot.voided && <span className="pairing-tool__tag">ยกเลิกคู่</span>}
                    {conflict && (
                      <span className="pairing-tool__conflict">
                        {conflict.actor ?? "ผู้ใช้อื่น"} แก้ไปแล้ว
                        <button type="button" onClick={() => rebase(slot.game, slot.table)}>ใช้ค่าปัจจุบัน</button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          {mode === "place" ? (
            <div className="pairing-tool__col pairing-tool__col--split">
              <SplitStack
                top={{
                  label: "รายชื่อผู้เข้าแข่งขัน",
                  title: <>ผู้เข้าแข่งขัน · {roster.length} คน{available.length > 0 ? ` · ยังไม่มีที่นั่ง ${available.length}` : ""}</>,
                  body: (
                    <ul className="pairing-tool__roster">
                      {roster.map((entry) => (
                        <RosterRow
                          key={entry.code}
                          entry={entry}
                          player={players.get(entry.code)}
                          picked={held === entry.code}
                          onPick={() => pick(entry.code)}
                        />
                      ))}
                    </ul>
                  ),
                }}
                bottom={{
                  label: "Screening Pool",
                  title: <>Screening Pool · {pool.length} คน</>,
                  body: (
                    <div className="pairing-tool__pool">
                      {pool.length === 0 && <p className="page-description">ยังไม่มีผู้เล่นถูกพักไว้</p>}
                      {pool.map((hold) => (
                        <PoolCard
                          key={hold.player}
                          hold={hold}
                          players={players}
                          selectable
                          picked={held === hold.player}
                          seatedAt={seats.get(hold.player)?.table ?? null}
                          onPick={() => pick(hold.player)}
                          onRecall={() => recall(hold.player)}
                        />
                      ))}
                    </div>
                  ),
                }}
              />
            </div>
          ) : (
            <section className="pairing-tool__col pairing-tool__col--scroll" aria-label="ผู้เล่นที่รอจัดคู่">
              <p className="pairing-tool__h">Screening Pool · {pool.length} คน</p>
              {pool.length === 0 && <p className="page-description">ยังไม่มีผู้เล่นถูกพักไว้</p>}
              {pool.map((hold) => (
                <PoolCard
                  key={hold.player}
                  hold={hold}
                  players={players}
                  selectable={false}
                  picked={false}
                  seatedAt={null}
                  onPick={() => undefined}
                  onRecall={() => undefined}
                />
              ))}

              <p className="pairing-tool__h">เหตุผลที่พัก</p>
              <div className="pairing-tool__reasons">
                {REASONS.map((option) => (
                  <label key={option.value} className="pairing-tool__reason">
                    <input
                      type="radio"
                      name="screening-reason"
                      value={option.value}
                      checked={reason === option.value}
                      onChange={() => setReason(option.value)}
                    />
                    {option.label}
                  </label>
                ))}
              </div>
              <input
                className="input"
                placeholder="บันทึกเพิ่มเติม (ไม่บังคับ)"
                value={note}
                maxLength={280}
                onChange={(event) => setNote(event.target.value)}
                aria-label="บันทึกเพิ่มเติมเกี่ยวกับการพักผู้เล่น"
              />
            </section>
          )}
        </div>

        {error && <p className="confirm-dialog__error" role="alert">{error}</p>}

        <footer>
          <span className="pairing-tool__hint">
            {blockedByAvailable
              ? `ต้องจัดที่นั่งให้ผู้เล่นที่ยังไม่มีที่นั่ง (${available.join(", ")}) ก่อนจึงจะบันทึกได้`
              : conflicts.size > 0
                ? `มี ${conflicts.size} คู่ที่ผู้ใช้อื่นแก้ไปแล้ว — การแก้ของคุณในคู่นั้นถูกพักไว้`
                : pool.length > 0
                  ? "ต้องจัดการผู้เล่นใน Screening Pool ให้ครบก่อนจึงจะ Review เกมนี้ได้"
                  : ""}
          </span>
          <Button variant="secondary" onClick={onClose}>ยกเลิก</Button>
          <Button onClick={() => void review()} disabled={busy || nothingToDo || blockedByAvailable}>
            {busy ? <LoaderCircle className="loading-spinner" size={14} /> : <UserMinus size={14} />}
            ตรวจสอบผลกระทบ
          </Button>
        </footer>

        {preview && forcing === null && (
          <PairingDiffSheet
            validation={preview}
            players={players}
            busy={busy}
            onCancel={() => setPreview(null)}
            onConfirm={commit}
            onForce={(acknowledged) => void prepareForce(acknowledged)}
          />
        )}

        {preview && forcing !== null && (
          <ForceCommitConfirm
            results={preview.resultsToRemove}
            players={players}
            busy={busy}
            onCancel={() => setForcing(null)}
            onConfirm={(password) => void commit(password, forcing, true)}
          />
        )}
      </section>
    </div>
  );
}

function Seat({
  code, side, slot, mode, players, selected, held, locked, onToggle, onClick,
}: {
  code: string | null;
  side: 1 | 2;
  slot: SlotRow;
  mode: Mode;
  players: Map<string, Player>;
  selected: Set<string>;
  held: string | null;
  locked: boolean;
  onToggle: (code: string) => void;
  onClick: (slot: SlotRow, side: 1 | 2) => void;
}) {
  const player = code ? players.get(code) : undefined;
  // Screen mode refuses a scored seat outright. Place mode allows it and lets the diff sheet decide,
  // because rearranging a played table is a legitimate (if heavy) repair.
  const disabled = locked || (mode === "screen" && slot.hasResult);

  if (mode === "screen") {
    if (code === null) return <span className="pairing-tool__empty">— ว่าง —</span>;
    return (
      <label className={`pairing-tool__seat${selected.has(code) ? " is-selected" : ""}${disabled ? " is-locked" : ""}`}>
        <input
          type="checkbox"
          checked={selected.has(code)}
          disabled={disabled}
          onChange={() => onToggle(code)}
          aria-label={`พัก ${code} ${player ? `${player.firstName} ${player.lastName}` : ""} คู่ที่ ${slot.table}`}
        />
        <span className="pairing-tool__code">{code}</span>
        {player && <span className="pairing-tool__name">{player.firstName} {player.lastName}</span>}
        {player?.school && <span className="pairing-tool__school" title={player.school}>{player.school}</span>}
      </label>
    );
  }

  // Place mode: click to pick up, click to put down. Not drag — unreliable on a tablet, with no
  // recoverable state mid-gesture, and every move here is consequential.
  const canDrop = held !== null && held !== code && !disabled;
  const picked = code !== null && held === code;
  return (
    <button
      type="button"
      className={`pairing-tool__seat pairing-tool__seat--btn${canDrop ? " is-target" : ""}${picked ? " is-held" : ""}${disabled ? " is-locked" : ""}`}
      disabled={disabled}
      onClick={() => onClick(slot, side)}
      aria-pressed={picked}
      aria-label={code
        ? `${held && held !== code ? "สลับที่นั่งกับ" : "เลือก"} ${code} คู่ที่ ${slot.table}`
        : `วางผู้เล่นลงที่ว่าง คู่ที่ ${slot.table}`}
    >
      {code === null
        ? <span className="pairing-tool__empty">— ว่าง —</span>
        : <>
            <span className="pairing-tool__code">{code}</span>
            {player && <span className="pairing-tool__name">{player.firstName} {player.lastName}</span>}
            {player?.school && <span className="pairing-tool__school" title={player.school}>{player.school}</span>}
          </>}
    </button>
  );
}

/**
 * One competitor in the pick list: seat, code, name, school.
 *
 * Rows carry their own reason for being where they are — no seat at all, or nobody sitting opposite —
 * because the order they appear in is the whole argument for reading the list top-down.
 */
function RosterRow({
  entry, player, picked, onPick,
}: {
  entry: RosterEntry;
  player: Player | undefined;
  picked: boolean;
  onPick: () => void;
}) {
  const name = player ? `${player.firstName} ${player.lastName}` : "";
  return (
    <li>
      <button
        type="button"
        className={`pairing-tool__row${picked ? " is-held" : ""}${entry.seat === null ? " is-unseated" : entry.lonely ? " is-lonely" : ""}`}
        disabled={entry.locked}
        onClick={onPick}
        aria-pressed={picked}
        aria-label={`เลือก ${entry.code} ${name} ${entry.seat === null ? "ยังไม่มีที่นั่ง" : `ที่นั่ง ${entry.seat}`}`}
      >
        <span className="pairing-tool__row-seat">{entry.seat ?? "—"}</span>
        <span className="pairing-tool__code">{entry.code}</span>
        <span className="pairing-tool__name">{name}</span>
        {player?.school && <span className="pairing-tool__school" title={player.school}>{player.school}</span>}
        {entry.seat === null && <span className="pairing-tool__tag">ไม่มีที่นั่ง</span>}
        {entry.seat !== null && entry.lonely && <span className="pairing-tool__tag">ไม่มีคู่</span>}
        {entry.locked && <span className="pairing-tool__tag">ถูกแก้แล้ว</span>}
      </button>
    </li>
  );
}

/**
 * One held player, and the single action that makes sense for them right now.
 *
 * A pool player who has been put into a pair is the one move this tool used to be unable to undo:
 * they are no longer in the pool list's gift, and the roster treats them as any other seated
 * competitor. So the row's button changes with their state — select them while they are waiting,
 * call them back out of the pair once they are in one.
 */
function PoolCard({
  hold, players, selectable, picked, seatedAt, onPick, onRecall,
}: {
  hold: ScreeningHold;
  players: Map<string, Player>;
  selectable: boolean;
  picked: boolean;
  /** The pair number they have been staged into, or `null` while they are still waiting. */
  seatedAt: number | null;
  onPick: () => void;
  onRecall: () => void;
}) {
  const player = players.get(hold.player);
  const label = REASONS.find((option) => option.value === hold.reason)?.label ?? hold.reason;
  const name = player ? `${player.firstName} ${player.lastName}` : hold.player;

  return (
    <div className={`pairing-tool__hold${picked ? " is-held" : ""}${seatedAt !== null ? " is-seated" : ""}`}>
      <div className="pairing-tool__hold-top">
        <span className="pairing-tool__code">{hold.player}</span>
        {player && <span className="pairing-tool__name">{player.firstName} {player.lastName}</span>}
        <span className="pairing-tool__reason-tag">{label}</span>
      </div>
      <p className="pairing-tool__hold-ctx">
        {new Date(hold.screenedAt).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" })}
        {hold.originTable !== null && (
          hold.originStale
            ? " · คู่เดิมถูกแก้ไขไปแล้ว"
            : ` · เดิมคู่ที่ ${hold.originTable}${hold.originOpponent ? ` พบ ${hold.originOpponent}` : ""}`
        )}
      </p>
      {hold.note && <p className="pairing-tool__hold-ctx">{hold.note}</p>}
      {selectable && (seatedAt !== null ? (
        <button
          type="button"
          className="pairing-tool__hold-action is-recall"
          onClick={onRecall}
          aria-label={`เรียก ${hold.player} ${name} กลับออกจากคู่ที่ ${seatedAt}`}
        >
          <Undo2 size={13} /> เรียกกลับจากคู่ที่ {seatedAt}
        </button>
      ) : (
        <button
          type="button"
          className="pairing-tool__hold-action"
          onClick={onPick}
          aria-pressed={picked}
          aria-label={`เลือก ${hold.player} ${name} เพื่อนำกลับเข้าคู่`}
        >
          {picked ? "กำลังถืออยู่ — เลือกคู่ทางซ้าย" : "เลือกเพื่อจัดลงคู่"}
        </button>
      ))}
    </div>
  );
}

const occupants = (slot: SlotRow) => [slot.one, slot.two];

/** A slot needing attention: an empty seat, a void, or someone else's edit. */
const isProblem = (conflicts: Map<string, unknown>) => (slot: SlotRow) =>
  conflicts.has(keyOf(slot.game, slot.table))
  || slot.voided
  || (!slot.hasResult && (slot.one === null || slot.two === null));

function slotClass(slot: SlotRow, conflicted: boolean, edited: boolean): string {
  const base = "pairing-tool__slot";
  if (conflicted) return `${base} is-conflict`;
  if (slot.voided) return `${base} is-void`;
  if (slot.hasResult) return `${base} is-locked`;
  if (edited) return `${base} is-edited`;
  if (slot.one === null || slot.two === null) return `${base} is-empty`;
  return base;
}

/**
 * The warning shown before generating a pairing while anyone is held.
 *
 * Held players are excluded from the generated field, and re-seating them afterwards requires
 * regenerating — which stops being possible the moment any result is entered. Saying so here turns a
 * dead end discovered at the worst moment into a choice made at a calm one.
 */
export function ScreeningGenerationWarning({ pool }: { pool: ScreeningHold[] }) {
  if (pool.length === 0) return null;
  return (
    <div className="screening-warning" role="status">
      <AlertTriangle size={15} />
      <div>
        <strong>มีผู้เล่นถูกพักไว้ {pool.length} คน ({pool.map((hold) => hold.player).join(", ")})</strong>
        <p>
          ผู้เล่นเหล่านี้จะไม่อยู่ในคู่ที่กำลังจะสร้าง หากต้องการให้กลับเข้าคู่ในเกมนี้
          ต้องยกเลิกการจับคู่แล้วสุ่มใหม่ — และเมื่อกรอกผลคู่ใดคู่หนึ่งแล้วจะทำไม่ได้อีก
        </p>
      </div>
    </div>
  );
}

/**
 * Every stage the pairing tool accepts: before generation (the preferred flow), during preview, and
 * during result collection — a no-show for a round already underway. Shared so the players page and
 * the tables page can never disagree about when the tool is reachable.
 */
export const canOpenScreening = (card: TournamentCard) =>
  card.runtimeStage === "TABLE_PAIRING"
  || card.runtimeStage === "PAIRING_PREVIEW"
  || card.runtimeStage === "RESULT_COLLECTION";

/**
 * Entry points for the tool, one button per mode.
 *
 * Screening belongs with the players (it is a fact about who turned up) and Multi Switching with the
 * pairs (it is a fact about the board), so the two pages each ask for the button they own.
 */
export function PairingToolButtons({
  card, modes = ["screen", "place"],
}: {
  card: TournamentCard;
  modes?: Mode[];
}) {
  const openPairingSession = useTournamentStore((state) => state.openPairingSession);
  const [mode, setMode] = useState<Mode | null>(null);
  const [asking, setAsking] = useState<Mode | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pool = card.screeningPool ?? [];

  const authenticate = async () => {
    if (!asking) return;
    setBusy(true);
    setError("");
    try {
      await openPairingSession(card.id, password);
      setPassword("");
      setMode(asking);
      setAsking(null);
    } catch (failure) {
      setError(isBadPassword(failure) ? "รหัสผ่านไม่ถูกต้อง" : "เปิดเครื่องมือไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {modes.includes("screen") && (
        <Button variant="secondary" onClick={() => setAsking("screen")}>
          <UserPlus size={14} />
          Screening Pool{pool.length > 0 ? ` (${pool.length})` : ""}
        </Button>
      )}
      {modes.includes("place") && (
        <Button variant="secondary" onClick={() => setAsking("place")}>
          <Shuffle size={14} />
          Multi Switching
        </Button>
      )}

      <ConfirmDialog
        open={asking !== null}
        title="ยืนยันรหัสผ่านผู้อำนวยการ"
        description="การพักผู้เล่นและการแก้คู่เป็นสิทธิ์ของผู้อำนวยการ ระบบจะขอรหัสผ่านอีกครั้งตอนบันทึก"
        eyebrow={asking === "place" ? "Multi Switching" : "Screening Pool"}
        icon={asking === "place" ? <Shuffle size={20} /> : <UserPlus size={20} />}
        confirmLabel="เปิดเครื่องมือ"
        busy={busy}
        busyLabel="กำลังตรวจสอบ…"
        error={error}
        onConfirm={() => void authenticate()}
        onCancel={() => { setAsking(null); setPassword(""); setError(""); }}
      >
        <label className="form-label" htmlFor="screening-password">รหัสผ่านผู้อำนวยการ</label>
        <FreshSecretInput
          id="screening-password"
          placeholder="รหัสผ่านผู้อำนวยการ"
          value={password}
          aria-label="รหัสผ่านผู้อำนวยการเพื่อเปิดเครื่องมือจัดคู่"
          onChange={(event) => setPassword(event.target.value)}
        />
      </ConfirmDialog>

      {mode && <PairingTool card={card} mode={mode} open onClose={() => setMode(null)} />}
    </>
  );
}
