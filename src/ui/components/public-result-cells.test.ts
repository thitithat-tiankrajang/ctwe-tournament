import assert from "node:assert/strict";
import test from "node:test";

import type { Pairing } from "@/domain/tournament/types";
import { VOIDED_TEXT, WITHDRAWN_TEXT } from "@/domain/tournament/pairing-slot";
import { resultDiffOf, resultDiffText, resultScoreText } from "./card-overview";

/**
 * What the AUDIENCE reads in the public result table.
 *
 * The defect these pin: a withdrawn result and a voided slot both carry NULL scores, so the old
 * `isRecorded`-first ordering sent both down the same branch as a game nobody has played, and the
 * public saw "—". A score the audience watched go up would silently become "not played yet", which
 * is the one thing the force-commit confirmation promises the director will not happen.
 *
 * These assert the pure cell functions rather than rendered DOM because the repo has no React test
 * setup (18_P4_CLOSURE.md §9) — which is exactly why the functions are exported.
 */

const base: Pairing = {
  id: "g1t1",
  tableNumber: 1,
  playerOneId: "A001",
  playerTwoId: "A002",
  playerOneGibsonized: false,
  playerTwoGibsonized: false,
};

const pairing = (overrides: Partial<Pairing>): Pairing => ({ ...base, ...overrides });

test("a withdrawn result says so, and never reads as unplayed", () => {
  // Force commit nulls every score column and sets the flag, so this is the exact shape the API
  // sends: no scores, no result type, resultWithdrawn true.
  const withdrawn = pairing({ resultWithdrawn: true });
  assert.equal(resultScoreText(withdrawn), WITHDRAWN_TEXT);
  assert.notEqual(resultScoreText(withdrawn), "—");
  // The margin is genuinely gone — not zero, absent — so it must not sort among real results.
  assert.equal(resultDiffOf(withdrawn), null);
  assert.equal(resultDiffText(withdrawn), "—");
});

test("a normal recorded result is untouched", () => {
  const won = pairing({ scoreOne: 420, scoreTwo: 300, resultType: "WIN", winnerId: "A001", calculatedDiff: 120 });
  assert.equal(resultScoreText(won), "420 - 300");
  assert.equal(resultDiffText(won), "120");
  assert.equal(resultDiffOf(won), 120);

  const drawn = pairing({ scoreOne: 350, scoreTwo: 350, resultType: "DRAW", calculatedDiff: 0 });
  assert.equal(resultScoreText(drawn), "350 - 350");
  assert.equal(resultDiffText(drawn), "0");

  const penalised = pairing({ scoreOne: 0, scoreTwo: 0, resultType: "PENALTY", calculatedDiff: 100 });
  assert.equal(resultScoreText(penalised), "ลงดาบ");
  assert.equal(resultDiffText(penalised), "−100");
});

test("an unplayed slot keeps its em dash", () => {
  const pending = pairing({});
  assert.equal(resultScoreText(pending), "—");
  assert.equal(resultDiffText(pending), "—");
  assert.equal(resultDiffOf(pending), null);
});

test("a zero-diff bye prints 0, not an em dash", () => {
  // The bye rule stores a real WIN with calculated_diff = 0. `0` is a recorded fact and must not be
  // collapsed into "no result" by a falsy check.
  const bye = pairing({ playerTwoId: null, scoreOne: 300, scoreTwo: 0, resultType: "WIN", winnerId: "A001", calculatedDiff: 0 });
  assert.equal(resultScoreText(bye), "300 - 0");
  assert.equal(resultDiffText(bye), "0");
  assert.equal(resultDiffOf(bye), 0);
});

test("a voided slot is named, not left blank", () => {
  // Both seats empty is what the server writes when a pairing loses both players; `voided` is the
  // authoritative flag and the both-null shape is the guard for a row emptied another way.
  const flagged = pairing({ playerOneId: null, playerTwoId: null, voided: true });
  const bothEmpty = pairing({ playerOneId: null, playerTwoId: null });
  for (const slot of [flagged, bothEmpty]) {
    assert.equal(resultScoreText(slot), VOIDED_TEXT);
    assert.notEqual(resultScoreText(slot), "—");
    assert.equal(resultDiffText(slot), "—");
  }
});

test("a real bye is not mistaken for a void", () => {
  // One player with nobody opposite is a bye that must still be scored — voiding it would hide a
  // result the player earned. Only BOTH seats empty is a void.
  const bye = pairing({ playerTwoId: null });
  assert.equal(resultScoreText(bye), "—");
  assert.notEqual(resultScoreText(bye), VOIDED_TEXT);
});

test("when a slot is both withdrawn and voided, the abandoned pairing wins", () => {
  // Reachable in one force commit: results are destroyed BEFORE applyPairing voids the emptied
  // slot, and voiding does not clear result_withdrawn_at. Such a row has nobody left to attribute
  // a withdrawn score to, so naming the void explains the whole row where ถอนผล explains none.
  const both = pairing({ playerOneId: null, playerTwoId: null, voided: true, resultWithdrawn: true });
  assert.equal(resultScoreText(both), VOIDED_TEXT);
});
