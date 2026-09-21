import assert from "node:assert/strict";
import test from "node:test";

import type { Pairing } from "@/domain/tournament/types";
import { VOIDED_TEXT, WITHDRAWN_TEXT } from "@/domain/tournament/pairing-slot";
import { diffText, resultLabel, scoreText } from "./tournament-pdfs";

/**
 * The exported Result PDF is handed to officials and kept, so a row that misdescribes itself
 * outlives the screen it came from. These pin the same precedence the public result table uses:
 * withdrawn and voided rows carry NULL scores, and printing "—" for them would be a document
 * asserting the game was never played.
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

test("a withdrawn result prints ถอนผล, not an unplayed dash", () => {
  const withdrawn = pairing({ resultWithdrawn: true });
  assert.equal(scoreText(withdrawn), WITHDRAWN_TEXT);
  assert.notEqual(scoreText(withdrawn), "—");
  assert.equal(diffText(withdrawn), "");
});

test("recorded and unplayed rows print exactly as before", () => {
  const won = pairing({ scoreOne: 420, scoreTwo: 300, resultType: "WIN", winnerId: "A001", calculatedDiff: 120 });
  assert.equal(scoreText(won), "420 - 300");
  assert.equal(diffText(won), "+120");

  const drawn = pairing({ scoreOne: 350, scoreTwo: 350, resultType: "DRAW", calculatedDiff: 0 });
  assert.equal(diffText(drawn), "เสมอ 0");

  const penalised = pairing({ scoreOne: 0, scoreTwo: 0, resultType: "PENALTY", calculatedDiff: 100 });
  assert.equal(scoreText(penalised), "ลงดาบ");
  assert.equal(diffText(penalised), "−100");

  const pending = pairing({});
  assert.equal(scoreText(pending), "—");
  assert.equal(diffText(pending), "");
});

test("a voided slot is one abandoned pairing, never two byes meeting", () => {
  // The bye fallback fires per side, so a row with BOTH seats empty used to print "บาย พบ บาย" —
  // a printed document claiming two byes played each other at one table.
  const voided = pairing({ playerOneId: null, playerTwoId: null, voided: true });
  assert.equal(resultLabel(voided), VOIDED_TEXT);
  assert.equal(scoreText(voided), VOIDED_TEXT);
  assert.equal(diffText(voided), "");
});

test("a real bye still names its lone player against บาย", () => {
  const bye = pairing({ playerTwoId: null });
  assert.equal(resultLabel(bye), "A001 พบ บาย");
  assert.notEqual(resultLabel(bye), VOIDED_TEXT);
});
