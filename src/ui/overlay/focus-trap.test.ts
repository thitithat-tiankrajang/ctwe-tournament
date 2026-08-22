import assert from "node:assert/strict";
import test from "node:test";
import { FOCUSABLE_SELECTOR, nextMenuIndex, nextTrapIndex } from "./focus-trap";

/**
 * P7-E. The DOM half of an overlay needs a browser; this arithmetic does not, and it is the half
 * that has the edge cases. There is no React test setup in this repo (18_P4_CLOSURE.md §9), so the
 * rendering is proven at runtime and the rules are proven here.
 */

test("Tab wraps forward at the end of a trap, Shift+Tab wraps backward at the start", () => {
  assert.equal(nextTrapIndex(3, 2, false), 0, "past the last element returns to the first");
  assert.equal(nextTrapIndex(3, 0, true), 2, "before the first element returns to the last");
  assert.equal(nextTrapIndex(3, 0, false), 1);
  assert.equal(nextTrapIndex(3, 2, true), 1);
});

test("a trap that has lost focus re-enters at the near end instead of leaking to the page", () => {
  // current === -1 is focus on <body>, which happens when the focused node is removed mid-dialog.
  // Without this the next Tab walks into the page behind the modal.
  assert.equal(nextTrapIndex(4, -1, false), 0, "Tab enters at the start");
  assert.equal(nextTrapIndex(4, -1, true), 3, "Shift+Tab enters at the end");
});

test("an empty trap reports no destination rather than index 0", () => {
  assert.equal(nextTrapIndex(0, -1, false), -1);
  assert.equal(nextTrapIndex(0, 2, true), -1);
});

test("a single focusable element stays put in both directions", () => {
  assert.equal(nextTrapIndex(1, 0, false), 0);
  assert.equal(nextTrapIndex(1, 0, true), 0);
});

test("menu arrows wrap in both directions", () => {
  assert.equal(nextMenuIndex(3, 2, 1), 0);
  assert.equal(nextMenuIndex(3, 0, -1), 2);
  assert.equal(nextMenuIndex(5, 1, 1), 2);
  assert.equal(nextMenuIndex(0, 0, 1), -1, "an empty menu has nowhere to go");
});

test("the focusable selector excludes what cannot actually be tabbed to", () => {
  // A disabled confirm button and a roving-tabindex option are both in the DOM and neither is a
  // tab stop. Getting this wrong traps focus on a dead control.
  assert.match(FOCUSABLE_SELECTOR, /button:not\(\[disabled\]\)/);
  assert.match(FOCUSABLE_SELECTOR, /input:not\(\[disabled\]\):not\(\[type=hidden\]\)/);
  assert.match(FOCUSABLE_SELECTOR, /\[tabindex\]:not\(\[tabindex="-1"\]\)/);
});
