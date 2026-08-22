import assert from "node:assert/strict";
import test from "node:test";
import { nextOverviewViews, type OverviewView } from "./card-overview";

/**
 * D15 / UX-F3 — the picker's selection rule.
 *
 * UX-F3 filed this as "a segmented picker that is really multi-select": it looked like a one-of-three
 * control and behaved like checkboxes, on every screen size. The rule is now explicit and differs by
 * viewport, so it is pinned here rather than left to be re-derived from the component.
 */

const set = (...views: OverviewView[]) => new Set<OverviewView>(views);
const sorted = (views: Set<OverviewView>) => [...views].sort();

test("desktop adds a second view — comparing two panels is the point", () => {
  assert.deepEqual(sorted(nextOverviewViews(set("ranking"), "pairing", false)), ["pairing", "ranking"]);
});

test("desktop can hold all three at once", () => {
  const all = nextOverviewViews(nextOverviewViews(set("ranking"), "pairing", false), "result", false);
  assert.deepEqual(sorted(all), ["pairing", "ranking", "result"]);
});

test("desktop tapping an open view closes just that one", () => {
  assert.deepEqual(sorted(nextOverviewViews(set("ranking", "pairing"), "ranking", false)), ["pairing"]);
});

test("phone replaces rather than adds — a second panel would only bury the first", () => {
  assert.deepEqual(sorted(nextOverviewViews(set("ranking"), "pairing", true)), ["pairing"]);
});

test("phone never holds two views, whatever it started from", () => {
  assert.deepEqual(sorted(nextOverviewViews(set("ranking", "pairing", "result"), "result", true)), []);
  assert.deepEqual(sorted(nextOverviewViews(set("ranking", "pairing"), "result", true)), ["result"]);
});

test("phone tapping the open view collapses it — the tables can be put away on both", () => {
  assert.deepEqual(sorted(nextOverviewViews(set("ranking"), "ranking", true)), []);
  assert.deepEqual(sorted(nextOverviewViews(set("ranking"), "ranking", false)), []);
});

test("opening from nothing works in both modes", () => {
  assert.deepEqual(sorted(nextOverviewViews(set(), "pairing", true)), ["pairing"]);
  assert.deepEqual(sorted(nextOverviewViews(set(), "pairing", false)), ["pairing"]);
});

test("the input set is never mutated — it is React state", () => {
  const current = set("ranking");
  nextOverviewViews(current, "pairing", false);
  nextOverviewViews(current, "pairing", true);
  assert.deepEqual(sorted(current), ["ranking"]);
});
