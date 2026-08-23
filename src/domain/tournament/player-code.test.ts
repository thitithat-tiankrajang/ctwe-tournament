import assert from "node:assert/strict";
import test from "node:test";

import { comparePlayerCodes, matchesPlayerCode, normalizePlayerCode, parseSearchQuery, unmatchedCodes } from "./player-code";

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

test("a search of only code-shaped tokens is a code set, normalized and de-duplicated", () => {
  assert.deepEqual(parseSearchQuery("5 003 45 012"), { kind: "codes", tokens: ["5", "003", "45", "012"] });
  assert.deepEqual(parseSearchQuery("5,003;45"), { kind: "codes", tokens: ["5", "003", "45"] });
  // 5 and 005 normalize to the same code, so the token survives once.
  assert.deepEqual(parseSearchQuery("5 005 5"), { kind: "codes", tokens: ["5"] });
  // "A5" is a STRICTER query than "5" (it pins the prefix too), so it is not a duplicate.
  assert.deepEqual(parseSearchQuery("5 A5"), { kind: "codes", tokens: ["5", "A5"] });
  assert.deepEqual(parseSearchQuery("  16  "), { kind: "codes", tokens: ["16"] });
});

test("anything not entirely code-shaped stays one text query", () => {
  // A name contains spaces, so partial splitting would search for fragments of it.
  assert.deepEqual(parseSearchQuery("สมชาย ใจดี"), { kind: "text", value: "สมชาย ใจดี" });
  assert.deepEqual(parseSearchQuery("5 สมชาย"), { kind: "text", value: "5 สมชาย" });
  assert.deepEqual(parseSearchQuery("โรงเรียน 2"), { kind: "text", value: "โรงเรียน 2" });
  assert.deepEqual(parseSearchQuery("   "), { kind: "empty" });
  assert.deepEqual(parseSearchQuery(""), { kind: "empty" });
});

test("unmatched codes are reported so a search never silently finds nothing", () => {
  const board = ["A001", "A016", "A045"];
  assert.deepEqual(unmatchedCodes(["1", "16", "45"], board), []);
  assert.deepEqual(unmatchedCodes(["1", "999", "45"], board), ["999"]);
  assert.deepEqual(unmatchedCodes(["11"], board), ["11"]);
});
