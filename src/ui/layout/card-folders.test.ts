import assert from "node:assert/strict";
import test from "node:test";
import { foldersAfterOpening } from "./card-folders";

/**
 * P5-D21 — "collapse unused folders".
 *
 * The other two thirds of D21 were already shipped (`.card-folder--current`, the "ปัจจุบัน" badge).
 * What was missing is that expansion only ever grew, so the prominence those bought was diluted by a
 * sidebar that got longer with every card visited.
 *
 * The reference-equality case is not a micro-optimisation: `app-shell.tsx` is the file P3-E had to
 * restructure to reach zero shell renders per SSE event, so a no-op that returns a fresh Set would
 * hand that back one render at a time.
 */

const set = (...ids: string[]) => new Set(ids);
const ids = (value: ReadonlySet<string>) => [...value].sort();

test("opening a card collapses every other folder", () => {
  assert.deepEqual(ids(foldersAfterOpening(set("a", "b", "c"), "b")), ["b"]);
});

test("opening the first card expands just that one", () => {
  assert.deepEqual(ids(foldersAfterOpening(set(), "a")), ["a"]);
});

test("opening a card that was not expanded still collapses the rest", () => {
  assert.deepEqual(ids(foldersAfterOpening(set("a"), "b")), ["b"]);
});

test("re-opening the only expanded card is a no-op and keeps the same Set reference", () => {
  const current = set("a");
  assert.equal(foldersAfterOpening(current, "a"), current,
    "a fresh Set here would re-render the shell for no change");
});

test("the current card being expanded ALONGSIDE others is not a no-op", () => {
  const current = set("a", "b");
  const next = foldersAfterOpening(current, "a");
  assert.notEqual(next, current, "b must actually collapse");
  assert.deepEqual(ids(next), ["a"]);
});

test("the input set is never mutated — it is React state", () => {
  const current = set("a", "b");
  foldersAfterOpening(current, "c");
  assert.deepEqual(ids(current), ["a", "b"]);
});

test("the result always contains exactly the opened card", () => {
  for (const start of [set(), set("a"), set("a", "b"), set("x", "y", "z")]) {
    const next = foldersAfterOpening(start, "target");
    assert.equal(next.has("target"), true);
    assert.equal(next.size, 1);
  }
});
