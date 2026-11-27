import type { Pairing } from "./types";

/**
 * A slot that holds nobody and can never hold a result.
 *
 * The server voids a slot when it loses both players to screening. It keeps its table number so
 * seat numbering and printed table cards stay valid, but it needs no result and every completeness
 * check skips it. `voided` is the authoritative signal; the both-empty test is a guard for a row
 * emptied by some path that does not set it.
 *
 * Deliberately FALSE for a slot with no pairing at all. A PAIR_RESULT destination row is created
 * one seat at a time as each source result lands, so "no row yet" means the source game is still
 * being played — a real wait, not a void. The server also deletes any destination row left holding
 * nobody, so the two states never overlap.
 */
export function isVoidPairing(pairing: Pairing | undefined): boolean {
  if (!pairing) return false;
  return pairing.voided === true || (!pairing.playerOneId && !pairing.playerTwoId);
}

/**
 * What a slot with no score is called, when "no score" is not the whole story.
 *
 * These live here, beside `isVoidPairing`, because the audience meets them on two surfaces — the
 * public result table and the PDF export — and a Thai label written out twice is two statements of
 * one fact, free to drift apart.
 */
export const WITHDRAWN_TEXT = "ถอนผล";
export const VOIDED_TEXT = "ยกเลิกคู่";

/**
 * The word that replaces a score when "no score" is not the whole story — or null when the slot is
 * an ordinary one and the caller should say what it always said.
 *
 * A withdrawn result and a voided slot both carry NULL scores, so any reading that asks
 * "is it recorded?" first sends both down the same branch as a game nobody has played: the public
 * table says รอผล and the PDF prints an em dash. A score the audience watched go up would silently
 * become "not played yet", which is exactly what the force-commit confirmation promises the
 * director will not happen. Every surface therefore asks THIS first.
 *
 * Void wins over withdrawn, and the two are reachable together in one force commit: results are
 * destroyed before the emptied slot is voided, and voiding does not clear result_withdrawn_at.
 * Such a row has nobody left to attribute a withdrawn score to, so naming the void explains the
 * whole row where ถอนผล explains none of it.
 */
export function withheldResultText(pairing: Pairing): string | null {
  if (isVoidPairing(pairing)) return VOIDED_TEXT;
  if (pairing.resultWithdrawn === true) return WITHDRAWN_TEXT;
  return null;
}

/**
 * Has this slot's result been entered?
 *
 * `!= null` on purpose: the API omits absent scores, so they arrive as `undefined` — but a null
 * that slipped through would read as "recorded" under a strict check and let a blank row satisfy
 * the review gate.
 */
export function isRecordedPairing(pairing: Pairing): boolean {
  return pairing.scoreOne != null && pairing.scoreTwo != null && Boolean(pairing.resultType);
}

export interface BlockCompletion {
  /** Slots that still need a result. Voided ones are not among them. */
  live: number;
  /** Slots the block should contain, voided ones excluded. */
  expected: number;
  completed: number;
  /** Every live slot has a result, and every slot the block should have exists. */
  complete: boolean;
}

/** Every occupied slot in the active games must be scored, including a single-seat bye. */
export function blockCompletion(
  pairings: readonly Pairing[],
  games: readonly number[],
  currentGame: number,
  _pairResult: boolean,
): BlockCompletion {
  const live = pairings.filter((pairing) => games.includes(pairing.gameNumber ?? currentGame) && !isVoidPairing(pairing));
  const completed = live.filter(isRecordedPairing).length;
  return { live: live.length, expected: live.length, completed, complete: completed === live.length };
}
