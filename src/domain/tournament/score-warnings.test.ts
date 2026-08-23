import assert from "node:assert/strict";
import test from "node:test";

import { isUnusualScore, scoreWarnings } from "./score-warnings";

test("a score below 100 warns, naming the player whose score it is", () => {
  assert.deepEqual(scoreWarnings([{ playerId: "A016", score: 42 }]), [
    { playerId: "A016", kind: "low", message: "คะแนน A016 ต่ำกว่าปกติ" },
  ]);
});

test("a score above 999 warns", () => {
  assert.deepEqual(scoreWarnings([{ playerId: "A004", score: 1500 }]), [
    { playerId: "A004", kind: "high", message: "คะแนน A004 มากกว่าปกติ" },
  ]);
});

test("the boundaries themselves are normal", () => {
  assert.deepEqual(scoreWarnings([
    { playerId: "A001", score: 99 },
    { playerId: "A002", score: 100 },
    { playerId: "A003", score: 999 },
    { playerId: "A004", score: 1000 },
  ]).map((warning) => warning.playerId), ["A001", "A004"]);
});

test("both sides of a match can warn, and both are reported", () => {
  const warnings = scoreWarnings([{ playerId: "A001", score: 5 }, { playerId: "A002", score: 5000 }]);
  assert.equal(warnings.length, 2);
  assert.deepEqual(warnings.map((warning) => warning.kind), ["low", "high"]);
});

test("a normal match produces no warnings at all", () => {
  assert.deepEqual(scoreWarnings([{ playerId: "A001", score: 500 }, { playerId: "A002", score: 430 }]), []);
});

test("negative scores warn as low rather than being rejected", () => {
  // Wave 3 allows negatives down to -30000 for real matches; a warning is the right response,
  // never a block.
  assert.deepEqual(scoreWarnings([{ playerId: "A007", score: -50 }]).map((w) => w.kind), ["low"]);
});

test("isUnusualScore drives the inline badge on the same thresholds", () => {
  assert.equal(isUnusualScore(99), true);
  assert.equal(isUnusualScore(100), false);
  assert.equal(isUnusualScore(999), false);
  assert.equal(isUnusualScore(1000), true);
  assert.equal(isUnusualScore(Number.NaN), false);
});
