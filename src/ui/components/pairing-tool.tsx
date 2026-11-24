"use client";

import { AlertTriangle, ChevronDown, LoaderCircle, LockKeyhole, Search, Shuffle, Undo2, UserPlus, Users, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { matchesPlayerCode, comparePlayerCodes } from "@/domain/tournament/player-code";
import { clearPairingDraft, readPairingDraft, savePairingDraft } from "@/ui/components/pairing-ui-draft";
import { ConfirmDialog } from "@/ui/components/confirm-dialog";
import { FreshSecretInput } from "@/ui/components/fresh-secret-input";
import { ForceCommitConfirm } from "@/ui/components/force-commit-confirm";
import { PairingDiffSheet } from "@/ui/components/pairing-diff-sheet";
import { buildRoster, seatsByPlayer } from "@/ui/components/pairing-roster";
import { type SlotRow, type Staged, editedSlots, liveSlots, usePairingBaseline } from "@/ui/components/use-pairing-baseline";
import { editableResultGames, rosterBlockScopes } from "@/domain/tournament/flow";
import { RosterBlockScope } from "./roster-block-scope";
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
const occupants = (slot: SlotRow) => [slot.one, slot.two];

const REASONS: { value: ScreeningReason; label: string }[] = [
  { value: "NO_SHOW", label: "ไม่มาแข่ง" },
  { value: "LATE", label: "มาสาย" },
  { value: "MEDICAL", label: "เหตุสุขภาพ" },
  { value: "OTHER", label: "อื่น ๆ" },
];

const keyOf = (game: number, table: number) => `${game}:${table}`;

interface Props {
  card: TournamentCard;
  mode: Mode;
  open: boolean;
  onClose: () => void;
  initialGame?: number;
}

export function PairingTool({ card, mode, open, onClose, initialGame }: Props) {
  const validatePairingChange = useTournamentStore((state) => state.validatePairingChange);
  const commitPairingChange = useTournamentStore((state) => state.commitPairingChange);
  const announcePairingPresence = useTournamentStore((state) => state.announcePairingPresence);
  const presence = useTournamentStore((state) => state.pairingPresence);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [staged, setStaged] = useState<Staged>(new Map());
  const [availableByGame, setAvailableByGame] = useState<Record<number, string[]>>({});
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [chosenGame, setChosenGame] = useState(initialGame);
  const [chosenFromGame, setFromGame] = useState<number>();
  const scopes = rosterBlockScopes(card);
  const fromGame = scopes.find((scope) => scope.game === chosenFromGame)?.game ?? scopes[0]?.game;
  const [held, setHeld] = useState<string | null>(null);
  const [reason, setReason] = useState<ScreeningReason>("NO_SHOW");
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<PairingValidation | null>(null);
  /** Acknowledged warnings carried into the force confirmation, so nothing is re-asked there. */
  const [forcing, setForcing] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"seat" | "code" | "name">("seat");
  const [descending, setDescending] = useState(false);
  const [lookup, setLookup] = useState<{ key: string; side: 1 | 2; term: string } | null>(null);

  const dialog = useModalDialog({ open, onDismiss: onClose, dismissible: !busy });
  const { baseline, conflicts, conflictOf, rebase } = usePairingBaseline(card, open);

  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    const saved = mode === "place" ? readPairingDraft(card) : null;
    setStaged(saved?.staged ?? new Map());
    setAvailableByGame(saved?.available ?? {});
    setCleared(new Set(saved?.cleared));
    setChosenGame(saved?.selectedGame ?? initialGame);
    setFromGame(undefined);
    setSearch("");
    setLookup(null);
    setHeld(null);
    setPreview(null);
    setForcing(null);
    setError("");
    setNote("");
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
  const editable = editableResultGames(card);
  const games = editable.filter((game) => baseline.some((slot) => slot.game === game));
  const selectedGame = games.find((game) => game === chosenGame) ?? games[0] ?? card.currentGame;
  const available = availableByGame[selectedGame] ?? [];
  const setAvailable = (update: (current: string[]) => string[]) =>
    setAvailableByGame((current) => ({ ...current, [selectedGame]: update(current[selectedGame] ?? []) }));
  const pool = (card.screeningPool ?? []).filter((hold) => hold.fromGame == null || hold.fromGame <= selectedGame);
  const poolIds = new Set(pool.map((hold) => hold.player));

  // What the operator sees: the frozen baseline with this session's staging applied on top.
  const rows: SlotRow[] = useMemo(() => baseline.map((slot) => {
    const override = staged.get(keyOf(slot.game, slot.table));
    return override ? { ...slot, one: override.one, two: override.two } : slot;
  }), [baseline, staged]);

  const rowIndex = useMemo(
    () => new Map(rows.map((slot) => [keyOf(slot.game, slot.table), slot])),
    [rows],
  );
  const board = useMemo(() => rows.filter((slot) => slot.game === selectedGame), [rows, selectedGame]);
  const seats = useMemo(() => seatsByPlayer(board), [board]);
  const resultLocked = (slot: SlotRow | undefined) => Boolean(slot?.hasResult && !cleared.has(keyOf(slot.game, slot.table)));

  // Slots that differ from the board this session opened on — NOT slots that were merely touched.
  // Everything downstream keys off this: the blue row, the count, and what the commit carries.
  const edited = useMemo(
    () => editedSlots(baseline, staged, conflicts),
    [baseline, staged, conflicts],
  );

  // Every competitor on the board, always — the roster is derived from the same staged rows the left
  // column draws, so a swap reorders it the moment it is staged. Nobody has to be lifted first.
  const newlyRecorded = useMemo(() => {
    const unrecorded = new Set(baseline.filter((slot) => !slot.hasResult).map((slot) => keyOf(slot.game,slot.table)));
    return new Set(liveSlots(card).filter((live) => live.hasResult && unrecorded.has(keyOf(live.game,live.table))).map((slot) => keyOf(slot.game,slot.table)));
  }, [card,baseline]);
  const liveAffected = new Set<string>();
  for (const slot of baseline) {
    const key = keyOf(slot.game,slot.table);
    if (!newlyRecorded.has(key) || !edited.has(key)) continue;
    liveAffected.add(key);
    for (const code of [slot.one, slot.two]) {
      const moved = code ? seatsByPlayer(rows.filter((row) => row.game === slot.game)).get(code) : null;
      if (moved) liveAffected.add(keyOf(moved.game,moved.table));
    }
  }
  const roster = useMemo(
    () => buildRoster(board, available, (game, table) => conflicts.has(keyOf(game, table))),
    [board, available, conflicts],
  );

  const others = presence?.cardId === card.id ? presence.actors : [];

  if (!open) return null;

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
  const place = (slot: SlotRow, side: 1 | 2, code = held) => {
    if (code === null || resultLocked(slot) || newlyRecorded.has(keyOf(slot.game,slot.table)) || conflicts.has(keyOf(slot.game,slot.table))) return;
    const occupant = side === 1 ? slot.one : slot.two;
    if (occupant === code) { setHeld(null); return; }

    const origin = seats.get(code) ?? null;
    // Half a swap is worse than none: a change to a conflicted slot is suspended from the commit, so
    // writing only the other half would seat one player twice and unseat the other for good.
    if (origin) {
      const originKey = keyOf(origin.game, origin.table);
      if (conflicts.has(originKey) || newlyRecorded.has(originKey) || resultLocked(rowIndex.get(originKey))) return;
    }

    const writes: { game: number; table: number; side: 1 | 2; code: string | null }[] = [
      { game: slot.game, table: slot.table, side, code },
    ];
    // The player already sits somewhere: whoever was in the target seat takes the seat they vacate.
    if (origin) writes.push({ ...origin, code: occupant });

    setSeats(writes);
    setAvailable((list) => {
      const without = list.filter((entry) => entry !== code);
      return !origin && occupant !== null && !without.includes(occupant) ? [...without, occupant] : without;
    });
    setHeld(origin ? null : occupant);
  };

  const seatClick = (slot: SlotRow, side: 1 | 2) => {
    if (resultLocked(slot) || conflictOf(slot.game, slot.table) || newlyRecorded.has(keyOf(slot.game,slot.table))) return;
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
    if (!at || conflicts.has(keyOf(at.game, at.table)) || newlyRecorded.has(keyOf(at.game, at.table)) || resultLocked(rowIndex.get(keyOf(at.game, at.table)))) return;
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
    for (const key of cleared) touched.add(key);
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

    const release = (card.screeningPool ?? []).filter((hold) =>
      rows.some((slot) => slot.game >= (hold.fromGame ?? 1) && occupants(slot).includes(hold.player))).map((hold) => hold.player);
    return {
      expect,
      slots,
      screen: [...selected].map((player) => ({ player, reason, note: note.trim() || undefined, fromGame })),
      // Pool players who now occupy a seat leave the pool as part of this same commit.
      release,
      clearResults: expect.filter((item) => cleared.has(keyOf(item.game, item.table))),
      confirmWarnings: acknowledged,
    };
  };

  const stagedCount = edited.size;
  const nothingToDo = selected.size === 0 && stagedCount === 0 && cleared.size === 0;
  const outstanding = Object.values(availableByGame).flat();
  const blockedByAvailable = outstanding.length > 0;

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
      clearPairingDraft(card.id);
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

  const matches = (code: string, q: string) => {
    const player = players.get(code);
    return /^[A-Za-z]*\d+$/.test(q)
      ? matchesPlayerCode(code, q)
      : `${code} ${player?.firstName ?? ""} ${player?.lastName ?? ""} ${player?.school ?? ""}`.toLowerCase().includes(q.toLowerCase());
  };
  const visible = rows.filter((slot) => {
    const q = search.trim();
    return (fromGame == null || slot.game >= fromGame) && (!q || slot.one && matches(slot.one, q) || slot.two && matches(slot.two, q) || q === `คู่ ${slot.table}`);
  });
  const lookupOptions = lookup?.term.trim() ? [...new Set([...roster.map((entry) => entry.code), ...poolIds])]
    .filter((code) => matches(code,lookup.term.trim()))
    .filter((code) => {
      const origin = seats.get(code);
      if (!origin) return true;
      const key = keyOf(origin.game, origin.table);
      return !newlyRecorded.has(key) && !conflicts.has(key) && !resultLocked(rowIndex.get(key));
    }).slice(0,10) : [];
  const rosterSorted = [...card.players].sort((one, two) => {
    const a = seats.get(one.id);
    const b = seats.get(two.id);
    if (sort === "seat" && Boolean(a) !== Boolean(b)) return a ? -1 : 1;
    const compare = sort === "name" ? `${one.firstName} ${one.lastName}`.localeCompare(`${two.firstName} ${two.lastName}`, "th")
      : sort === "seat" && a && b ? a.table - b.table || a.side - b.side : comparePlayerCodes(one.id, two.id);
    return (descending ? -1 : 1) * (compare || comparePlayerCodes(one.id, two.id));
  });
  const selectLookupPlayer = (slot: SlotRow, code: string) => {
    if (!lookup) return;
    place(slot,lookup.side,code);
    setLookup(null);
  };
  const switchGame = (game: number) => { setChosenGame(game); setHeld(null); setLookup(null); };
  const resetAffected = () => {
    const kept = new Map([...staged].filter(([key]) => !liveAffected.has(key)));
    setStaged(kept);
    setAvailableByGame((byGame) => Object.fromEntries(Object.entries(byGame).map(([game, codes]) => {
      const seated = new Set(baseline.filter((slot) => slot.game === Number(game)).flatMap((slot) => {
        const next = kept.get(keyOf(slot.game, slot.table)) ?? slot;
        return [next.one, next.two];
      }));
      return [game, codes.filter((code) => !seated.has(code))];
    })));
    setHeld(null);
  };
  const locked = (slot: SlotRow) => {
    const key = keyOf(slot.game, slot.table);
    return resultLocked(slot) || newlyRecorded.has(key) || conflicts.has(key) || liveAffected.has(key);
  };
  const location = (code: string) => {
    const position = seats.get(code);
    return position && rowIndex.get(keyOf(position.game, position.table));
  };
  const availableCodes = new Set(roster.map((entry) => entry.code));
  const rosterButton = (player: Player, inPool = false) => {
    const seat = seats.get(player.id);
    const slot = location(player.id);
    const onBoard = Boolean(slot);
    const withdrawn = player.terminated && (player.withdrawnFromGame ?? 0) <= selectedGame;
    const disabled = Boolean(withdrawn || slot && locked(slot) || !inPool && !availableCodes.has(player.id));
    const seatLabel = seat ? card.slotLabel === "SEAT" ? `ที่นั่ง ${(seat.table - 1) * 2 + seat.side}` : `คู่ ${seat.table}` : inPool ? "พัก" : "—";
    return <div key={player.id} className="msw-roster-item">
      <button type="button" className="msw-roster-row" data-linked={held === player.id ? "true" : undefined}
        aria-pressed={held === player.id} aria-disabled={disabled || undefined} disabled={disabled} onClick={() => pick(player.id)}>
        <small className="msw-pos">{seatLabel}</small><span className="code">{player.id}</span>
        <span className="msw-person"><b>{player.firstName} {player.lastName}</b><small>{player.school}
          {onBoard && slot && locked(slot) ? " · ล็อกผลแล้ว" : withdrawn ? " · ถอนแล้ว" : ""}</small></span>
      </button>
      {inPool && onBoard && !disabled && <button type="button" className="btn btn--ghost msw-recall" onClick={() => recall(player.id)}>
        <Undo2 className="i" size={14} />นำกลับเข้าคัดชั่วคราว</button>}
    </div>;
  };
  const seatButton = (slot: SlotRow, side: 1 | 2) => {
    const code = side === 1 ? slot.one : slot.two;
    const player = code ? players.get(code) : undefined;
    const key = keyOf(slot.game, slot.table);
    return <td><button type="button" className="msw-seat" aria-pressed={Boolean(code && held === code)}
      aria-label={`คู่ ${slot.table} ผู้เล่น ${side}${code ? ` ${code}` : " ว่าง"}`}
      data-linked={code && held === code ? "true" : undefined} aria-disabled={locked(slot) || undefined} disabled={locked(slot)}
      onClick={() => seatClick(slot, side)} onKeyDown={(event) => {
        if (event.key.length !== 1 || event.key === " " || event.metaKey || event.ctrlKey || event.altKey) return;
        event.preventDefault();
        setLookup({ key, side, term: event.key });
      }}>{player ? <><span className="code">{code}</span><span title={`${player.firstName} ${player.lastName}`}>{player.firstName} {player.lastName}</span></> : <span className="meta">ว่าง</span>}</button>
      {lookup?.key === key && lookup.side === side && !locked(slot) && <div className="msw-find msw-inline-find" data-pairing-search>
        <label className="cf__search"><Search className="i" size={14} /><input className="input" autoFocus
          aria-label="ค้นหาผู้เล่นเพื่อสลับ" placeholder="รหัส ชื่อ หรือโรงเรียน" value={lookup.term}
          onChange={(event) => setLookup({ ...lookup, term: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter" && lookupOptions.length === 1) { event.preventDefault(); selectLookupPlayer(slot, lookupOptions[0]); }
            if (event.key === "Escape") { event.stopPropagation(); setLookup(null); }
          }} /></label>
        {lookupOptions.length ? lookupOptions.map((id) => <button type="button" key={id} className="msw-roster-row"
          onClick={() => selectLookupPlayer(slot, id)}><span className="code">{id}</span>
          <span className="msw-person"><b>{players.get(id)?.firstName} {players.get(id)?.lastName}</b><small>{players.get(id)?.school}</small></span>
        </button>) : <p className="meta msw-empty">ไม่พบผู้เล่นที่สลับได้</p>}
      </div>}
    </td>;
  };
  const playerName = (id: string) => {
    const player = players.get(id);
    return player ? `${player.firstName} ${player.lastName}` : id;
  };

  return <div className="scrim prototype-dialog-scrim" role="presentation" onMouseDown={dialog.onBackdropMouseDown}>
    <section ref={dialog.ref as React.RefObject<HTMLElement>} className={`dialog dialog--consequential ${mode === "place" ? "dialog--wide dialog--msw" : "dialog--roster-tool dialog--roster-pick"}`}
      tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={dialog.titleId} onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => {
        if (event.target instanceof Element && !event.target.closest("button,input,select,label,summary,[data-pairing-search]")) { setHeld(null); setLookup(null); }
      }}>
      <header className="dlg-head"><span className="dlg-eyebrow"><LockKeyhole className="i" size={14} />ตรวจสอบก่อนดำเนินการ</span>
        <h2 id={dialog.titleId}>{mode === "place" ? "Multi Switching" : "คัดชั่วคราว"} · เกม {games.length > 1 ? `${games[0]}–${games.at(-1)}` : selectedGame}</h2></header>
      <div className="dlg-body">
        {others.length > 0 && <p className="meta" role="status"><Users className="i" size={14} /> {others.join(", ")} กำลังเปิดเครื่องมือนี้อยู่เช่นกัน</p>}
        {mode === "place" ? <div className="msw">
          <div className="msw-bar">{games.length > 1 && <div className="block-game-buttons" role="group" aria-label="เลือกเกมในชุดนี้">
            {games.map((game) => {
              const count = new Set([...edited,...cleared].filter((id) => id.startsWith(`${game}:`))).size;
              return <button type="button" key={game} className="btn btn--sm btn--secondary" aria-pressed={selectedGame === game}
                onClick={() => switchGame(game)}>เกม {game}{count > 0 && <span className="block-game-count">{count}</span>}</button>;
            })}
          </div>}<span className="meta">{new Set([...edited,...cleared]).size} คู่ที่แก้ไข</span>
            {liveAffected.size > 0 && <div className="msw-alert" role="status"><strong>ชนกับผลล่าสุด {liveAffected.size} แถว</strong>
              <button type="button" className="btn btn--sm btn--secondary" onClick={resetAffected}>คืนเฉพาะส่วนที่ชนกัน</button></div>}
          </div>
          <div className="msw-panels">
            <section className="msw-side"><header><h3>คู่แข่งขัน</h3><span className="meta">คลิกช่องแล้วพิมพ์เพื่อค้นหาผู้เล่น</span></header>
              <div className="msw-scroll"><table className="dt" aria-label="ตารางสำหรับสลับคู่"><thead><tr><th scope="col" className="c">คู่</th><th scope="col">ผู้เล่น 1</th><th scope="col">ผู้เล่น 2</th><th scope="col">สถานะ</th></tr></thead>
                <tbody>{board.map((slot) => {
                  const key = keyOf(slot.game, slot.table);
                  const conflict = conflictOf(slot.game, slot.table);
                  return <tr key={key} data-live-locked={newlyRecorded.has(key) || undefined}
                    className={conflict || liveAffected.has(key) ? "msw-conflict" : edited.has(key) ? "msw-staged" : undefined}>
                    <td className="c num">{slot.table}</td>{seatButton(slot, 1)}{seatButton(slot, 2)}
                    <td className="msw-row-state">
                      {conflict ? <button type="button" className="btn btn--sm btn--secondary" onClick={() => rebase(slot.game, slot.table)}>ใช้ค่าปัจจุบัน</button>
                        : liveAffected.has(key) ? "ชนกับผลล่าสุด" : cleared.has(key) ? "จะล้างผล" : slot.hasResult || newlyRecorded.has(key) ? "ล็อกผลแล้ว" : slot.voided ? "ยกเลิกคู่" : edited.has(key) ? "ปรับแล้ว" : "รอผล"}
                      {slot.hasResult && slot.resultType !== "PENALTY" && !conflict && <button type="button" className="btn btn--sm btn--ghost msw-clear-result"
                        onClick={() => setCleared((old) => { const next = new Set(old); if (next.has(key)) next.delete(key); else next.add(key); return next; })}>
                        {cleared.has(key) ? "ยกเลิกล้างผล" : "ล้างผล"}</button>}
                    </td>
                  </tr>;
                })}</tbody>
              </table></div>
            </section>
            <section className="msw-side"><header><h3>รายชื่อผู้เล่น</h3></header>
              <div className="msw-controls"><span aria-hidden>เรียงตาม</span>
                <span className="msw-order-select"><select aria-label="เรียงรายชื่อ" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}>
                  <option value="seat">{card.slotLabel === "SEAT" ? "ที่นั่ง / คู่" : "คู่ / ที่นั่ง"}</option><option value="code">รหัส</option><option value="name">ชื่อ</option>
                </select><ChevronDown className="i" size={14} /></span>
                <button type="button" className="btn btn--sm btn--secondary" data-msw-order title="กลับทิศทางการเรียง" onClick={() => setDescending(!descending)}>
                  {sort === "name" ? descending ? "ฮ → ก" : "ก → ฮ" : descending ? "มาก → น้อย" : "น้อย → มาก"}</button>
              </div>
              <div className="msw-right-lists"><div className="msw-scroll" id="msw-list">{rosterSorted.filter((player) => !poolIds.has(player.id)).map((player) => rosterButton(player))}</div>
                <details className="msw-pool" open><summary>คัดชั่วคราว <span className="meta">{pool.length}</span><ChevronDown className="i" size={15} /></summary>
                  <div className="msw-pool-list">{pool.length ? rosterSorted.filter((player) => poolIds.has(player.id)).map((player) => rosterButton(player, true))
                    : <p className="meta msw-empty">ยังไม่มีผู้เล่นที่ถูกคัดชั่วคราว</p>}</div>
                </details></div>
            </section>
          </div>
        </div> : <>
          <RosterBlockScope scopes={scopes} game={fromGame} action="คัดชั่วคราว" onChange={(game) => { setFromGame(game); setSelected(new Set()); }} />
          <label className="cf__search"><Search className="i" size={14} /><input className="input" aria-label="ค้นหาผู้เล่นที่จะคัดชั่วคราว"
            placeholder="รหัส ชื่อ โรงเรียน หรือ คู่ 7" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
          <div className="roster-picker">
            <section className="roster-pick-list"><header className="roster-pick-header">รายชื่อผู้เล่น</header>
              <div className="roster-picker-scroll">{card.players.filter((player) => !player.terminated && !card.screeningPool?.some((hold) => hold.player === player.id)
                && (fromGame != null || !baseline.length ? matches(player.id, search.trim()) || visible.some((slot) => occupants(slot).includes(player.id))
                  : visible.some((slot) => occupants(slot).includes(player.id))))
                .map((player) => {
                  const id = player.id;
                  const assignments = baseline.filter((slot) => occupants(slot).includes(id));
                  const blocked = assignments.some((slot) => (fromGame == null || slot.game >= fromGame) && locked(slot));
                  return <label key={id} className={`roster-pick-row${blocked ? " is-blocked" : ""}`}>
                    <input type="checkbox" checked={selected.has(id)} disabled={blocked} onChange={() => toggle(id)} />
                    <span className="code">{id}</span><span className="roster-pick-person"><b>{playerName(id)}</b><small>{player.school}</small></span>
                    <span className="roster-pick-status">{assignments.map((slot) => games.length > 1 ? `เกม ${slot.game} คู่ ${slot.table}` : `คู่ ${slot.table}`).join(" · ")}
                      {blocked && <small>ล็อกผลแล้ว</small>}</span>
                  </label>;
                })}</div>
            </section>
            <section className="roster-pick-selected"><header className="roster-pick-header"><strong>เลือกแล้ว {selected.size} คน</strong></header>
              <div className="roster-picker-scroll">{[...selected].map((id) => <div key={id} className="roster-picked-row"><span><b className="code">{id}</b> {playerName(id)}</span>
                <button type="button" className="btn btn--ghost" aria-label={`เอา ${id} ออกจากรายการ`} onClick={() => toggle(id)}><X className="i" size={15} /></button></div>)}
              {!selected.size && <p className="roster-picker-empty">ยังไม่ได้เลือกผู้เล่น</p>}</div>
            </section>
          </div>
          <div className="field"><label htmlFor="screening-reason">เหตุผลที่พัก</label>
            <select className="input" id="screening-reason" value={reason} onChange={(event) => setReason(event.target.value as ScreeningReason)}>
              {REASONS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}</select>
          </div>
          <div className="field"><label htmlFor="screening-note">บันทึกเพิ่มเติม (ไม่บังคับ)</label><input className="input" id="screening-note"
            value={note} maxLength={280} onChange={(event) => setNote(event.target.value)} /></div>
        </>}
        {error && <p className="dlg-err" role="alert">{error}</p>}
        {blockedByAvailable && <p className="meta">ต้องจัดที่นั่งให้ผู้เล่นที่ยังไม่มีที่นั่ง ({outstanding.join(", ")}) ก่อนจึงจะบันทึกได้</p>}
        {conflicts.size > 0 && <p className="meta" role="status">มี {conflicts.size} คู่ที่ผู้ใช้อื่นแก้ไปแล้ว</p>}
      </div>
      <footer className="dlg-foot">
        <button type="button" className="btn btn--danger" onClick={onClose}>ยกเลิก</button>
        {mode === "place" && <button type="button" className="btn msw-draft-btn" disabled={(!staged.size && !cleared.size) || liveAffected.size > 0} onClick={() => {
          try { savePairingDraft(card, staged, availableByGame, cleared, selectedGame); onClose(); }
          catch { setError("บันทึกร่างในเบราว์เซอร์ไม่สำเร็จ"); }
        }}>บันทึกร่าง</button>}
        <button type="button" className="btn btn--primary" onClick={() => void review()} disabled={busy || nothingToDo || blockedByAvailable || liveAffected.size > 0}>
          {busy && <LoaderCircle className="i loading-spinner" size={14} />}ตรวจการเปลี่ยนแปลง
        </button>
      </footer>
      {preview && forcing === null && <PairingDiffSheet validation={preview} players={players} busy={busy}
        onCancel={() => setPreview(null)} onConfirm={commit} onForce={(acknowledged) => void prepareForce(acknowledged)} />}
      {preview && forcing !== null && <ForceCommitConfirm results={preview.resultsToRemove} players={players} busy={busy}
        onCancel={() => setForcing(null)} onConfirm={(password) => void commit(password, forcing, true)} />}
    </section>
  </div>;
}

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
  card, modes = ["screen", "place"], disabled = false, initialGame,
}: {
  card: TournamentCard;
  modes?: Mode[];
  initialGame?: number;
  disabled?: boolean;
}) {
  const openPairingSession = useTournamentStore((state) => state.openPairingSession);
  const [mode, setMode] = useState<Mode | null>(null);
  const [asking, setAsking] = useState<Mode | null>(null);
  const previousGame = useRef(card.currentGame);
  useEffect(() => {
    if (previousGame.current === card.currentGame) return;
    previousGame.current = card.currentGame;
    setMode(null);
    setAsking(null);
  }, [card.id,card.currentGame]);
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
        <button type="button" className="btn btn--secondary" onClick={() => setAsking("screen")}>
          <UserPlus className="i" size={14} />
          คัดชั่วคราว{pool.length > 0 ? ` (${pool.length})` : ""}
        </button>
      )}
      {modes.includes("place") && (
        <button type="button" className="btn btn--secondary" disabled={disabled} onClick={() => setAsking("place")}>
          <Shuffle className="i" size={14} />
          Multi Switching
        </button>
      )}

      <ConfirmDialog
        open={asking !== null}
        title="ยืนยันรหัสผ่านผู้อำนวยการ"
        description="การพักผู้เล่นและการแก้คู่เป็นสิทธิ์ของผู้อำนวยการ ระบบจะขอรหัสผ่านอีกครั้งตอนบันทึก"
        appearance="prototype"
        eyebrow={asking === "place" ? "Multi Switching" : "คัดชั่วคราว"}
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
          className="input"
          placeholder="รหัสผ่านผู้อำนวยการ"
          value={password}
          aria-label="รหัสผ่านผู้อำนวยการเพื่อเปิดเครื่องมือจัดคู่"
          onChange={(event) => setPassword(event.target.value)}
        />
      </ConfirmDialog>

      {mode && !disabled && <PairingTool card={card} mode={mode} initialGame={initialGame} open onClose={() => setMode(null)} />}
    </>
  );
}
