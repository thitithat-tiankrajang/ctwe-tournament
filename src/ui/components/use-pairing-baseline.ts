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

/** Occupancy the operator wants for a slot, keyed game:table. Absent means "unchanged". */
export type Staged = Map<string, { one: string | null; two: string | null }>;

const key = (game: number, table: number) => `${game}:${table}`;

/** A slot's occupants as a side-independent identity. An empty seat sorts as its own value. */
const facing = (slot: { one: string | null; two: string | null }) =>
  [slot.one ?? "", slot.two ?? ""].sort().join("\u0000");

/**
 * Which staged slots actually differ from the board the tool opened on.
 *
 * Staging records every seat the operator wrote, including the ones they wrote back. A table that has
 * travelled A-vs-B → A-vs-C → A-vs-B is not a change, and calling it one costs the operator twice:
 * once reading a diff padded with rows that do nothing, and once trusting the count above the list.
 * So the question is never "was this slot touched" but "does it hold something different now".
 *
 * Sameness is the PAIRING, not the side: A-vs-B and B-vs-A are the same table to the operator, and
 * the side a name landed on while they worked is an artefact of the gesture, not an intent. Comparing
 * unordered means an accidental flip mid-repair costs nothing and commits nothing.
 *
 * A conflicted slot is excluded for the same reason it is excluded from the commit: its staged change
 * is suspended until the operator re-bases it, so presenting it as an edit would be a lie.
 */
export function editedSlots(
  baseline: SlotRow[],
  staged: Staged,
  conflicts: { has: (key: string) => boolean },
): Set<string> {
  const edited = new Set<string>();
  for (const slot of baseline) {
    const at = key(slot.game, slot.table);
    const want = staged.get(at);
    if (!want || conflicts.has(at)) continue;
    if (facing(want) !== facing(slot)) edited.add(at);
  }
  return edited;
}

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
