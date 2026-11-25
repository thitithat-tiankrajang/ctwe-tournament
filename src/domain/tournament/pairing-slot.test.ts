import assert from "node:assert/strict";
import test from "node:test";

import { blockCompletion, isRecordedPairing, isVoidPairing } from "./pairing-slot";
import type { Pairing } from "./types";

/**
 * A voided slot holds nobody and can never hold a result, so counting it produces a review gate
 * that never opens. The server already exempts it (`requireBlockFullyResolved`); these pin the
 * frontend to the same rule, and pin the one case that must NOT be treated as void — a slot with
 * no row yet, which means its source game is still being played.
 */

let seq = 0;
const pair = (over: Partial<Pairing> = {}): Pairing => ({
  id: `m${seq += 1}`,
  tableNumber: 1,
  playerOneId: "A001",
  playerTwoId: "A002",
  ...over,
});
const recorded = (over: Partial<Pairing> = {}) =>
  pair({ scoreOne: 400, scoreTwo: 300, resultType: "WIN", winnerId: "A001", ...over });

test("void is the flag, or an empty pair - never a slot that has no row yet", () => {
  assert.equal(isVoidPairing(pair({ voided: true })), true);
  assert.equal(isVoidPairing(pair({ playerOneId: null, playerTwoId: null })), true);
  // A bye is one player short, not empty: it still needs a result.
  assert.equal(isVoidPairing(pair({ playerTwoId: null })), false);
  assert.equal(isVoidPairing(pair()), false);
  // The PAIR_RESULT destination that has not been materialised. Treating this as void would let
  // review pass while a real match is still unplayed.
  assert.equal(isVoidPairing(undefined), false);
});

test("a null score is not a recorded result", () => {
  assert.equal(isRecordedPairing(recorded()), true);
  assert.equal(isRecordedPairing(pair({ scoreOne: 400, resultType: "WIN" })), false);
  assert.equal(isRecordedPairing(pair({ scoreOne: null as unknown as number, scoreTwo: 300, resultType: "WIN" })), false);
  // A score of 0 is a real score and must survive the check.
  assert.equal(isRecordedPairing(pair({ scoreOne: 0, scoreTwo: 0, resultType: "DRAW" })), true);
});

test("an ordinary block completes when every slot is recorded", () => {
  const rows = [recorded(), recorded(), pair()];
  assert.deepEqual(blockCompletion(rows, [3], 3, false), { live: 3, expected: 3, completed: 2, complete: false });
  assert.equal(blockCompletion([recorded(), recorded()], [3], 3, false).complete, true);
});

test("a voided slot leaves BOTH sides of the equation", () => {
  // The bug: the row is counted, can never be recorded, so the gate never opens.
  const rows = [recorded(), recorded(), pair({ voided: true, playerOneId: null, playerTwoId: null })];
  const result = blockCompletion(rows, [3], 3, false);
  assert.deepEqual(result, { live: 2, expected: 2, completed: 2, complete: true });
});

test("a block of nothing but voided slots is complete, not stuck", () => {
  // Edge worth pinning: it matches the server, whose own gate counts zero unresolved rows here.
  // Its separate player-accounting check is what would still object if anyone were left out.
  const result = blockCompletion([pair({ voided: true })], [3], 3, false);
  assert.deepEqual(result, { live: 0, expected: 0, completed: 0, complete: true });
});

test("PAIR_RESULT expects one destination row per live source row", () => {
  const source = [recorded({ gameNumber: 1, tableNumber: 1 }), recorded({ gameNumber: 1, tableNumber: 2 })];
  const done = [recorded({ gameNumber: 2, tableNumber: 1 }), recorded({ gameNumber: 2, tableNumber: 2 })];
  assert.equal(blockCompletion([...source, ...done], [1, 2], 1, true).complete, true);
  // A destination row that has not been materialised is MISSING from the list entirely, so only a
  // count taken from the source side can notice it is absent.
  const partial = blockCompletion([...source, done[0]], [1, 2], 1, true);
  assert.deepEqual(partial, { live: 3, expected: 4, completed: 3, complete: false });
});

test("a voided source row expects no destination row of its own", () => {
  const source = [
    recorded({ gameNumber: 1, tableNumber: 1 }),
    pair({ gameNumber: 1, tableNumber: 2, voided: true, playerOneId: null, playerTwoId: null }),
  ];
  const destination = [recorded({ gameNumber: 2, tableNumber: 1 })];
  const result = blockCompletion([...source, ...destination], [1, 2], 1, true);
  assert.deepEqual(result, { live: 2, expected: 2, completed: 2, complete: true });
});

test("gameNumber falls back to the current game, as the API omits it on the active block", () => {
  const rows = [recorded(), recorded()];
  assert.equal(blockCompletion(rows, [4, 5], 4, true).expected, 4);
});
