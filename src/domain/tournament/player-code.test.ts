import assert from "node:assert/strict";
import test from "node:test";

import { comparePlayerCodes, matchesPlayerCode, normalizePlayerCode } from "./player-code";

test("normalizePlayerCode pads numeric codes without changing their prefix", () => {
  assert.equal(normalizePlayerCode("16"), "016");
  assert.equal(normalizePlayerCode("a16"), "A016");
  assert.equal(normalizePlayerCode(" P016 "), "P016");
});

test("numeric player-code search is exact and prefix-aware when supplied", () => {
  assert.equal(matchesPlayerCode("A001", "1"), true);
  assert.equal(matchesPlayerCode("A011", "1"), false);
  assert.equal(matchesPlayerCode("A001", "P1"), false);
  assert.equal(matchesPlayerCode("P001", "P1"), true);
});

test("player codes sort by their numeric portion beyond three digits", () => {
  assert.deepEqual(["A1000", "A099", "A999", "A001"].sort(comparePlayerCodes), ["A001", "A099", "A999", "A1000"]);
});
