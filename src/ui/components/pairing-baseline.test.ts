import assert from "node:assert/strict";
import test from "node:test";

import { type Staged, editedSlots } from "./use-pairing-baseline";
import type { SlotRow } from "./use-pairing-baseline";

const slot = (table: number, one: string | null, two: string | null): SlotRow =>
  ({ game: 4, table, one, two, hasResult: false, voided: false });

const baseline = [slot(1, "A", "B"), slot(2, "C", "D")];
const none = { has: () => false };

const stage = (entries: [string, { one: string | null; two: string | null }][]): Staged => new Map(entries);

test("a slot written back to what it held is not an edit", () => {
  // A vs B → A vs C → A vs B. The table travelled, but it did not change, and a diff that lists it
  // makes the operator verify a row that does nothing.
  assert.deepEqual([...editedSlots(baseline, stage([["4:1", { one: "A", two: "B" }]]), none)], []);
});

test("a slot holding someone different is an edit", () => {
  assert.deepEqual([...editedSlots(baseline, stage([["4:1", { one: "A", two: "C" }]]), none)], ["4:1"]);
});

test("emptying a seat is an edit", () => {
  assert.deepEqual([...editedSlots(baseline, stage([["4:2", { one: "C", two: null }]]), none)], ["4:2"]);
});

test("the same two players on opposite sides is not an edit — the pairing is what counts", () => {
  // A-vs-B and B-vs-A are one table to the operator. Which side a name landed on while they worked
  // is an artefact of the gesture, so a flip mid-repair neither shades the row nor reaches the commit.
  assert.deepEqual([...editedSlots(baseline, stage([["4:1", { one: "B", two: "A" }]]), none)], []);
});

test("which side is empty does not matter either", () => {
  const half = [slot(1, "A", null)];
  assert.deepEqual([...editedSlots(half, stage([["4:1", { one: null, two: "A" }]]), none)], []);
  assert.deepEqual([...editedSlots(half, stage([["4:1", { one: null, two: "B" }]]), none)], ["4:1"]);
});

test("a conflicted slot is never counted as an edit — its change is suspended anyway", () => {
  const staged = stage([["4:1", { one: "A", two: "C" }], ["4:2", { one: "B", two: "D" }]]);
  assert.deepEqual([...editedSlots(baseline, staged, { has: (key) => key === "4:1" })], ["4:2"]);
});

test("untouched slots and an empty staging produce nothing", () => {
  assert.equal(editedSlots(baseline, new Map(), none).size, 0);
});
