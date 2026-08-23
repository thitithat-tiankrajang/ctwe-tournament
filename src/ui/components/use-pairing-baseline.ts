"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTournamentStore } from "@/application/tournament/store";
import type { TournamentCard } from "@/domain/tournament/types";

/**
 * The tool's view of the board, and what has moved under it since it opened.
 *
 * The baseline is captured once, when the tool opens, and never silently redraws. An operator
 * studying a diff that quietly rewrites itself is worse off than one studying a stale one — and an
 * operator studying a stale one with no warning is worse off still. So: freeze the baseline, and
 * when someone else's commit touches a slot, mark that row conflicted and name them.
 *
 * A conflicted row's staged change is excluded from the commit until the operator re-bases it, so
 * they can never submit a move built on a picture that is no longer true.
 */

export interface SlotRow {
  game: number;
  table: number;
  one: string | null;
  two: string | null;
  hasResult: boolean;
  voided: boolean;
}

export interface Conflict {
  actor: string | null;
  /** What the slot holds now, after the other operator's commit. */
  one: string | null;
  two: string | null;
}

const key = (game: number, table: number) => `${game}:${table}`;

/** Slots of the live, unpublished pairing — the only rows this tool may touch. */
export function liveSlots(card: TournamentCard): SlotRow[] {
  const rows: SlotRow[] = [];
  for (const snapshot of card.snapshots)
    if (!snapshot.confirmedAt)
      for (const pairing of snapshot.pairings)
        rows.push({
          game: pairing.gameNumber ?? card.currentGame,
          table: pairing.tableNumber,
          // The API serializes with non_null inclusion, so an empty seat arrives as an ABSENT key
          // rather than an explicit null. Normalise: everything downstream compares against null.
          one: pairing.playerOneId ?? null,
          two: pairing.playerTwoId ?? null,
          hasResult: pairing.resultType != null,
          voided: pairing.voided === true,
        });
  return rows.sort((a, b) => a.game - b.game || a.table - b.table);
}

export function usePairingBaseline(card: TournamentCard, open: boolean) {
  const remotePairing = useTournamentStore((state) => state.remotePairing);
  const [baseline, setBaseline] = useState<SlotRow[]>([]);
  const [conflicts, setConflicts] = useState<Map<string, Conflict>>(new Map());
  const seenSeq = useRef(0);

  const live = useMemo(() => liveSlots(card), [card]);

  // Freeze on open. `live` is deliberately absent from the dependencies: this must capture the board
  // as it was at that moment and then stop following it.
  useEffect(() => {
    if (!open) return;
    setBaseline(liveSlots(card));
    setConflicts(new Map());
    seenSeq.current = useTournamentStore.getState().remotePairing?.seq ?? 0;
  }, [open, card.id]);

  useEffect(() => {
    if (!open || !remotePairing) return;
    if (remotePairing.cardId !== card.id) return;
    if (remotePairing.seq <= seenSeq.current) return;
    seenSeq.current = remotePairing.seq;

    setConflicts((current) => {
      const next = new Map(current);
      for (const change of remotePairing.changedSlots)
        next.set(key(change.game, change.table), {
          actor: remotePairing.actor,
          one: change.afterOne ?? null,
          two: change.afterTwo ?? null,
        });
      return next;
    });
  }, [remotePairing, open, card.id]);

  /** Adopt the current state of one conflicted slot and clear its marker. */
  const rebase = (game: number, table: number) => {
    const current = live.find((slot) => slot.game === game && slot.table === table);
    setBaseline((rows) => rows.map((row) =>
      row.game === game && row.table === table && current ? current : row));
    setConflicts((rows) => {
      const next = new Map(rows);
      next.delete(key(game, table));
      return next;
    });
  };

  return {
    /** The board as it was when the tool opened. */
    baseline,
    /** Slots someone else has changed since. */
    conflicts,
    conflictOf: (game: number, table: number) => conflicts.get(key(game, table)),
    rebase,
  };
}
