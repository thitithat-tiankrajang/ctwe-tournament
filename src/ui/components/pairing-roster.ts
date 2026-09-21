import type { SlotRow } from "@/ui/components/use-pairing-baseline";

/**
 * The competitor list Multi Switching picks from.
 *
 * Ordering is the whole point of this module. A director repairing a board is looking for two kinds
 * of row: someone with nobody to play, and the tail of the board where the field thins out. So the
 * list leads with players who hold no seat at all, then players whose opposite seat is empty, and
 * runs seats downward from the last table — the order the problems actually appear in the room.
 */

/** Seats run down the board: table 1 holds seats 1 and 2, table 2 holds seats 3 and 4. */
export const seatNumber = (table: number, side: 1 | 2) => (table - 1) * 2 + side;

export interface SeatRef {
  game: number;
  table: number;
  side: 1 | 2;
}

export interface RosterEntry {
  code: string;
  /** `null` while the player holds no seat — displaced and waiting for one. */
  seat: number | null;
  at: SeatRef | null;
  /** Nobody is sitting opposite them, or their slot was voided. */
  lonely: boolean;
  /** Their slot moved under us; selecting them would stage a change that is suspended anyway. */
  locked: boolean;
}

/** Where each player is sitting right now, by code. */
export function seatsByPlayer(rows: SlotRow[]): Map<string, SeatRef> {
  const index = new Map<string, SeatRef>();
  for (const slot of rows) {
    if (slot.one !== null) index.set(slot.one, { game: slot.game, table: slot.table, side: 1 });
    if (slot.two !== null) index.set(slot.two, { game: slot.game, table: slot.table, side: 2 });
  }
  return index;
}

const rank = (entry: RosterEntry) => (entry.seat === null ? 0 : entry.lonely ? 1 : 2);

export function buildRoster(
  rows: SlotRow[],
  unseated: readonly string[],
  isLocked: (game: number, table: number) => boolean = () => false,
): RosterEntry[] {
  const waiting = new Set(unseated);
  const entries: RosterEntry[] = unseated.map((code) => ({
    code, seat: null, at: null, lonely: true, locked: false,
  }));

  for (const slot of rows)
    for (const side of [1, 2] as const) {
      const code = side === 1 ? slot.one : slot.two;
      // A displaced player can still be written into the baseline row under them; the waiting list
      // is the truth about where they are, so never list anyone twice.
      if (code === null || waiting.has(code)) continue;
      entries.push({
        code,
        seat: seatNumber(slot.table, side),
        at: { game: slot.game, table: slot.table, side },
        lonely: (side === 1 ? slot.two : slot.one) === null || slot.voided,
        locked: isLocked(slot.game, slot.table),
      });
    }

  return entries.sort((a, b) =>
    rank(a) - rank(b) || (b.seat ?? 0) - (a.seat ?? 0) || a.code.localeCompare(b.code));
}
