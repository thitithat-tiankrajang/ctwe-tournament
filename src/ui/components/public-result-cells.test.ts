import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Pairing } from "@/domain/tournament/types";
import { VOIDED_TEXT, WITHDRAWN_TEXT, withheldResultText } from "@/domain/tournament/pairing-slot";

/**
 * What the AUDIENCE reads in place of a score.
 *
 * The defect these pin: a withdrawn result and a voided slot both carry NULL scores, so an
 * `isRecorded`-first ordering sent both down the same branch as a game nobody has played — the
 * public result table said "รอผล" and the PDF printed an em dash. A score the audience watched go
 * up would silently become "not played yet", which is the one thing the force-commit confirmation
 * promises the director will not happen.
 *
 * The rule is asserted here as a pure function, and the last test pins that the public result table
 * actually consults it BEFORE asking whether a result is recorded — which is where the defect lived
 * both times. Rendering the component instead is not available: `tsx` compiles this repo's .tsx
 * with the classic JSX runtime, so any component without React in module scope throws under the
 * test runner even though Next builds it correctly.
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
  assert.equal(withheldResultText(pairing({ resultWithdrawn: true })), WITHDRAWN_TEXT);
});

test("a voided slot is named, not left blank", () => {
  // Both seats empty is what the server writes when a pairing loses both players; `voided` is the
  // authoritative flag and the both-null shape is the guard for a row emptied another way.
  assert.equal(withheldResultText(pairing({ playerOneId: null, playerTwoId: null, voided: true })), VOIDED_TEXT);
  assert.equal(withheldResultText(pairing({ playerOneId: null, playerTwoId: null })), VOIDED_TEXT);
});

test("when a slot is both withdrawn and voided, the abandoned pairing wins", () => {
  // Reachable in one force commit: results are destroyed BEFORE applyPairing voids the emptied
  // slot, and voiding does not clear result_withdrawn_at. Such a row has nobody left to attribute
  // a withdrawn score to, so naming the void explains the whole row where ถอนผล explains none.
  const both = pairing({ playerOneId: null, playerTwoId: null, voided: true, resultWithdrawn: true });
  assert.equal(withheldResultText(both), VOIDED_TEXT);
});

test("an ordinary slot withholds nothing, whatever its state", () => {
  // Every one of these must fall through to whatever the surface normally prints, so that fixing
  // the two withheld cases cannot quietly swallow a real result.
  assert.equal(withheldResultText(pairing({})), null, "an unplayed slot is still simply waiting");
  assert.equal(withheldResultText(pairing({ scoreOne: 420, scoreTwo: 300, resultType: "WIN", winnerId: "A001", calculatedDiff: 120 })), null);
  assert.equal(withheldResultText(pairing({ scoreOne: 350, scoreTwo: 350, resultType: "DRAW", calculatedDiff: 0 })), null);
  assert.equal(withheldResultText(pairing({ scoreOne: 0, scoreTwo: 0, resultType: "PENALTY", calculatedDiff: 100 })), null);
});

test("a real bye is not mistaken for a void", () => {
  // One player with nobody opposite is a bye that must still be scored — voiding it would hide a
  // result the player earned. Only BOTH seats empty is a void.
  assert.equal(withheldResultText(pairing({ playerTwoId: null })), null);
  assert.equal(withheldResultText(pairing({ playerTwoId: null, scoreOne: 300, scoreTwo: 0, resultType: "WIN", winnerId: "A001", calculatedDiff: 0 })), null);
});

test("the public result table asks what is withheld before it asks what is recorded", () => {
  // The regression both times was an ordering one, and ordering is invisible to a test of the pure
  // function. This reads the source so that reintroducing `isRecorded` as the first question fails
  // here rather than in front of an audience.
  const source = readFileSync(join(process.cwd(), "src/ui/components/spectator-report-lists.tsx"), "utf8");
  const resultBlock = source.slice(source.indexOf('if (mode === "result")'));
  const withheldAt = resultBlock.indexOf("withheldResultText(pairing)");
  const statusAt = resultBlock.indexOf('"รอผล"');

  assert.ok(withheldAt > -1, "the result table must consult the shared withheld rule");
  assert.ok(statusAt > -1, "the result table still needs its waiting label");
  assert.ok(withheldAt < statusAt, "withheld must be decided before the waiting label is chosen");
});

test("the public result table signs the differential by the result, not by the seat", () => {
  // calculatedDiff is a MAGNITUDE. Keying the sign off `side` credits seat 1 with a positive
  // differential even when seat 2 won — every other pair — and contradicts both the standings and
  // the player record, which sign by result (see playerHistory: W ? margin : -margin).
  //
  // Read from source for the same reason as the ordering check above: the bug is in which value
  // the component chooses, and no pure helper sits between it and the cell.
  const source = readFileSync(join(process.cwd(), "src/ui/components/spectator-report-lists.tsx"), "utf8");
  const diffCell = source.slice(source.indexOf("spectator-cell--diff"), source.indexOf("spectator-cell__status"));

  assert.match(diffCell, /won \? magnitude : -magnitude/,
    "the winner takes the positive differential");
  assert.doesNotMatch(diffCell, /side === 1 \? \w*[Dd]iff/,
    "the sign must never be chosen by seat");
});
