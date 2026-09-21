import assert from "node:assert/strict";
import test from "node:test";

import { buildRoster, seatNumber, seatsByPlayer } from "./pairing-roster";
import type { SlotRow } from "./use-pairing-baseline";

const slot = (table: number, one: string | null, two: string | null, extra: Partial<SlotRow> = {}): SlotRow =>
  ({ game: 4, table, one, two, hasResult: false, voided: false, ...extra });

const board = [
  slot(1, "A1", "A2"),
  slot(2, "B1", null),   // B1 has nobody to play
  slot(3, "C1", "C2"),
];

test("seats run down the board, two per table", () => {
  assert.equal(seatNumber(1, 1), 1);
  assert.equal(seatNumber(1, 2), 2);
  assert.equal(seatNumber(3, 2), 6);
});

test("players with no opponent lead, then seats descend", () => {
  // A director repairing a board reads this list top-down: the problems, then the tail of the field.
  assert.deepEqual(buildRoster(board, []).map((entry) => entry.code), ["B1", "C2", "C1", "A2", "A1"]);
  assert.deepEqual(buildRoster(board, []).map((entry) => entry.seat), [3, 6, 5, 2, 1]);
});

test("a voided slot makes both of its players lonely", () => {
  const voided = [slot(1, "A1", "A2", { voided: true }), slot(2, "B1", "B2")];
  assert.deepEqual(buildRoster(voided, []).map((entry) => entry.code), ["A2", "A1", "B2", "B1"]);
});

test("players holding no seat come first and are never listed twice", () => {
  // The waiting list is the truth about where a displaced player is, even while the baseline row
  // under them still names them.
  const roster = buildRoster(board, ["C1"]);
  assert.deepEqual(roster.map((entry) => entry.code), ["C1", "B1", "C2", "A2", "A1"]);
  assert.equal(roster[0].seat, null);
  assert.equal(roster[0].at, null);
  assert.equal(roster.filter((entry) => entry.code === "C1").length, 1);
});

test("a slot someone else has changed locks its players out of selection", () => {
  const roster = buildRoster(board, [], (_game, table) => table === 3);
  assert.deepEqual(roster.filter((entry) => entry.locked).map((entry) => entry.code), ["C2", "C1"]);
});

test("the seat index reports where each player sits", () => {
  const index = seatsByPlayer(board);
  assert.deepEqual(index.get("A2"), { game: 4, table: 1, side: 2 });
  assert.deepEqual(index.get("B1"), { game: 4, table: 2, side: 1 });
  assert.equal(index.get("nobody"), undefined);
});
