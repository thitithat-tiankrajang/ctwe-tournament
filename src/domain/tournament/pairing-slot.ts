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

/**
 * The review gate's arithmetic, with voided slots removed from BOTH sides.
 *
 * Counting a voided slot can only produce a gate that never opens: it can never be recorded, so
 * `completed` could never reach an `expected` that included it. This mirrors the server's own rule
 * — `requireBlockFullyResolved` skips `voided_at IS NOT NULL` — and the server is what actually
 * authorises the transition. This only decides whether to offer it.
 *
 * `expected` still derives from the SOURCE row count in a PAIR_RESULT block, because that is what
 * detects destination rows that have not been materialised yet: those are missing from `pairings`
 * entirely, so only a count derived from elsewhere can notice they are absent.
 */
export function blockCompletion(
  pairings: readonly Pairing[],
  games: readonly number[],
  currentGame: number,
  pairResult: boolean,
): BlockCompletion {
  const live = pairings.filter((pairing) => !isVoidPairing(pairing));
  const gameOf = (pairing: Pairing) => pairing.gameNumber ?? currentGame;
  const sources = pairResult ? live.filter((pairing) => gameOf(pairing) === games[0]).length : live.length;
  const expected = pairResult ? sources * games.length : sources;
  const completed = live.filter(isRecordedPairing).length;
  return { live: live.length, expected, completed, complete: live.length === expected && completed === expected };
}
