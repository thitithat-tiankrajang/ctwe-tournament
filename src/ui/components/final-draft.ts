import type { FinalSlot } from "@/domain/tournament/types";

/**
 * Final-round entry drafts.
 *
 * Every typed field remembers the saved value it was typed against (`base`). When the card is
 * replaced — by this operator's own mutation response, another operator's save arriving over SSE,
 * or a wake/refresh — a field adopts the new saved value only if the operator has not typed over
 * the previous one. A field the operator changed keeps the typed value, so a response for game A
 * can no longer erase what was typed into game B (or a newer retype of game A) while A was in
 * flight.
 *
 * Drafts never cross finalists: the board keys each slot by card, slot and both player IDs, so a
 * different pairing mounts with fresh state (see `finalSlotDraftKey`).
 */
export interface DraftField {
  value: string;
  base: string;
}
export interface GameDraft {
  one: DraftField;
  two: DraftField;
}
export type GameDrafts = Record<number, GameDraft>;
export interface SummaryDraft {
  winnerId: DraftField;
  wins: DraftField;
  losses: DraftField;
  diff: DraftField;
}

/** Same bounds as a real match (CardDtos.FinalResultRequest): an A-Math game can end below zero. */
export const FINAL_MIN_SCORE = -30000;
export const FINAL_MAX_SCORE = 30000;

export function parseFinalScore(text: string): number | null {
  const trimmed = text.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= FINAL_MIN_SCORE && value <= FINAL_MAX_SCORE ? value : null;
}

export const savedText = (value: number | string | null | undefined): string => (value == null ? "" : String(value));

export function rebaseField(field: DraftField | undefined, saved: string): DraftField {
  if (!field || field.value === field.base) return { value: saved, base: saved };
  return { value: field.value, base: saved };
}

export function reconcileGameDrafts(previous: GameDrafts, games: FinalSlot["games"]): GameDrafts {
  return Object.fromEntries(games.map((game) => {
    const draft = previous[game.gameIndex];
    return [game.gameIndex, {
      one: rebaseField(draft?.one, savedText(game.scoreOne)),
      two: rebaseField(draft?.two, savedText(game.scoreTwo)),
    }];
  }));
}

export type SavedSummary = Pick<FinalSlot, "winnerId" | "winnerWins" | "winnerLosses" | "totalDiff">;

export function reconcileSummaryDraft(previous: SummaryDraft | undefined, slot: SavedSummary): SummaryDraft {
  return {
    winnerId: rebaseField(previous?.winnerId, savedText(slot.winnerId)),
    wins: rebaseField(previous?.wins, savedText(slot.winnerWins)),
    losses: rebaseField(previous?.losses, savedText(slot.winnerLosses)),
    diff: rebaseField(previous?.diff, savedText(slot.totalDiff)),
  };
}

export function editField(field: DraftField | undefined, value: string, saved: string): DraftField {
  return { value, base: field?.base ?? saved };
}

/** Unsaved means "differs from what the server holds now", not from the stale base. */
export function gameDraftDirty(drafts: GameDrafts, games: FinalSlot["games"]): boolean {
  return games.some((game) => {
    const draft = drafts[game.gameIndex];
    return Boolean(draft) && (draft.one.value !== savedText(game.scoreOne) || draft.two.value !== savedText(game.scoreTwo));
  });
}

export function summaryDraftDirty(summary: SummaryDraft, slot: SavedSummary): boolean {
  return summary.winnerId.value !== savedText(slot.winnerId)
    || summary.wins.value !== savedText(slot.winnerWins)
    || summary.losses.value !== savedText(slot.winnerLosses)
    || summary.diff.value !== savedText(slot.totalDiff);
}

export function finalSlotDraftKey(cardId: string, slot: Pick<FinalSlot, "slot" | "playerOneId" | "playerTwoId" | "pairingId">): string {
  return slot.pairingId ? `${cardId}:${slot.pairingId}` : `${cardId}:${slot.slot}:${slot.playerOneId}:${slot.playerTwoId}`;
}
