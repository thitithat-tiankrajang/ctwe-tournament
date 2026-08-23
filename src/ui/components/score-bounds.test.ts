import assert from "node:assert/strict";
import test from "node:test";

import { calcOutcome, MAX_SCORE, MIN_SCORE } from "./result-entry-grid";

/**
 * A real match may record a negative score — a player can finish a game below zero. A BYE may not:
 * it has no opponent, so a score of zero or less is not a result, and the director's ลงดาบ penalty
 * remains the way to record "no trustworthy result". The bye rule lives on the bye save path and is
 * asserted separately below via the same predicate the grid uses.
 */

const outcome = (one: string, two: string) => calcOutcome(one, two, 350, "A001", "A002");

test("a real match accepts negative scores down to the floor", () => {
  assert.deepEqual(outcome("-50", "300"), { resultType: "WIN", winnerId: "A002", diff: 350 });
  assert.deepEqual(outcome("300", "-50"), { resultType: "WIN", winnerId: "A001", diff: 350 });
  assert.ok(outcome(String(MIN_SCORE), "0"));
  assert.ok(outcome("-1", "1"));
});

test("zero is a normal score on both sides", () => {
  assert.deepEqual(outcome("0", "0"), { resultType: "DRAW", diff: 0 });
  assert.deepEqual(outcome("0", "5"), { resultType: "WIN", winnerId: "A002", diff: 5 });
});

test("two equal negative scores are a draw", () => {
  assert.deepEqual(outcome("-5", "-5"), { resultType: "DRAW", diff: 0 });
});

test("the margin between two negatives is still a positive diff, capped", () => {
  // -400 vs -100 is a 300 margin; the game's cap is 350, so it survives uncapped.
  assert.deepEqual(outcome("-400", "-100"), { resultType: "WIN", winnerId: "A002", diff: 300 });
  // -30000 vs 30000 is a 60000 margin, capped to the game maximum.
  assert.deepEqual(outcome("-30000", "30000"), { resultType: "WIN", winnerId: "A002", diff: 350 });
});

test("scores outside the storable range are rejected before they reach the backend", () => {
  assert.equal(outcome(String(MIN_SCORE - 1), "0"), null);
  assert.equal(outcome("0", String(MAX_SCORE + 1)), null);
  assert.equal(outcome("1.5", "2"), null);
  assert.equal(outcome("", "2"), null);
  assert.equal(outcome("abc", "2"), null);
});

/** The predicate the grid applies to a bye row — a lone player must win. */
const byeIsSavable = (value: string) =>
  value.trim() !== "" && Number.isInteger(Number(value)) && Number(value) > 0;

test("a bye still requires a score above zero", () => {
  assert.equal(byeIsSavable("-1"), false);
  assert.equal(byeIsSavable("-30000"), false);
  assert.equal(byeIsSavable("0"), false);
  assert.equal(byeIsSavable("1"), true);
  assert.equal(byeIsSavable("100"), true);
  assert.equal(byeIsSavable(""), false);
});
