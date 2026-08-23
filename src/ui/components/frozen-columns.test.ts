import assert from "node:assert/strict";
import test from "node:test";

import { frozenRunLength, stickyOffsets } from "./data-grid";

/**
 * Seat + code are the identity of a pairing row. Below the desktop breakpoint the grid overflows,
 * and before this existed, scrolling right to read the opponent put both off screen (measured at
 * 390px: ที่นั่ง at left −100, รหัส at −79, code clipped to "021").
 */
const pairingColumns = [
  { priority: "identity" as const },  // ที่นั่ง
  { priority: "identity" as const },  // รหัส
  { priority: "primary" as const },   // นักกีฬา
  {},                                 // พบ
  { priority: "identity" as const },  // ที่นั่ง (second player - NOT part of the leading run)
  { priority: "identity" as const },  // รหัส
  { priority: "primary" as const },
];

test("only the leading run of identity columns is frozen", () => {
  assert.equal(frozenRunLength(pairingColumns), 2);
  // A grid whose first column is not identity cannot freeze anything: a sticky column with
  // scrollable content to its left would slide over that content instead of anchoring it.
  assert.equal(frozenRunLength([{}, { priority: "identity" as const }]), 0);
  assert.equal(frozenRunLength([]), 0);
});

test("offsets accumulate across the frozen run and are null everywhere else", () => {
  const widths = [22, 30, 137, 19, 22, 30, 135];
  assert.deepEqual(stickyOffsets(pairingColumns, widths), [0, 22, null, null, null, null, null]);
});

test("offsets come from the widths supplied, because auto layout decides the real ones", () => {
  // Nominal widths (fixed layout, desktop) and rendered widths (auto layout, phone) differ; the
  // grid measures the rendered ones. Feeding the wrong set left a gap between the frozen columns.
  const nominal = [50, 68, 300, 56, 50, 68, 300];
  const rendered = [22, 30, 137, 19, 22, 30, 135];
  assert.deepEqual(stickyOffsets(pairingColumns, nominal), [0, 50, null, null, null, null, null]);
  assert.deepEqual(stickyOffsets(pairingColumns, rendered), [0, 22, null, null, null, null, null]);
});

test("a frozen run is contiguous - no gap for content to show through", () => {
  const widths = [22, 30, 137];
  const columns = [{ priority: "identity" as const }, { priority: "identity" as const }, {}];
  const offsets = stickyOffsets(columns, widths);
  assert.equal(offsets[0], 0);
  assert.equal(offsets[1], widths[0]);   // starts exactly where the previous one ends
});

test("a missing width contributes zero rather than NaN", () => {
  assert.deepEqual(stickyOffsets([{ priority: "identity" as const }, { priority: "identity" as const }], []), [0, 0]);
});
