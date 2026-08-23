import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { averageScore, rank, type H2HProvider, type RankInput } from "./ranking";

/**
 * The ranking rule is executed from `docs/ranking-vectors.json`, the same file the Java suite reads.
 * Two languages compute this rule independently; the shared vectors are what stop them drifting.
 */

interface Meeting { a: string; b: string; winner: string | null; diff: number; pointsA: number; pointsB: number; penalty?: boolean }
interface VectorPlayer { id: string; winPoints: number; diff: number; scoreFor: number; games: number }
interface Vector {
  name: string;
  players: VectorPlayer[];
  meetings: Meeting[];
  expectedOrder: string[];
  expectedDisplayRanks?: Record<string, number>;
  aggregations?: number;
}

const vectors: Vector[] = JSON.parse(
  readFileSync(join(process.cwd(), "docs", "ranking-vectors.json"), "utf8"),
).vectors;

/** Counts full aggregations so the laziness requirement is asserted, not just the ordering. */
function providerFor(meetings: Meeting[]) {
  // A penalty is not a game, so it never reaches the head-to-head record at all.
  const real = meetings.filter((meeting) => !meeting.penalty);
  const met = new Map<string, Set<string>>();
  const remember = (one: string, two: string) => {
    if (!met.has(one)) met.set(one, new Set());
    met.get(one)!.add(two);
  };
  for (const meeting of real) { remember(meeting.a, meeting.b); remember(meeting.b, meeting.a); }

  let aggregations = 0;
  const cache = new Map<string, number>();
  const provider: H2HProvider = {
    hasMet: (one, two) => met.get(one)?.has(two) ?? false,
    verdict: (one, two) => {
      const key = [one, two].sort().join("|");
      const cached = cache.get(key);
      if (cached !== undefined) return (key.startsWith(`${one}|`) ? cached : -cached) as -1 | 0 | 1;
      aggregations += 1;
      let wins = 0; let diff = 0; let points = 0; let against = 0;
      for (const meeting of real) {
        const isOne = meeting.a === one && meeting.b === two;
        const isTwo = meeting.a === two && meeting.b === one;
        if (!isOne && !isTwo) continue;
        points += isOne ? meeting.pointsA : meeting.pointsB;
        against += isOne ? meeting.pointsB : meeting.pointsA;
        if (meeting.winner === one) { wins += 1; diff += meeting.diff; }
        else if (meeting.winner === two) { wins -= 1; diff -= meeting.diff; }
        // A draw (winner null) counts for neither and contributes no diff.
      }
      const result = wins !== 0 ? Math.sign(wins) : diff !== 0 ? Math.sign(diff) : Math.sign(points - against);
      const sorted = [one, two].sort();
      cache.set(key, sorted[0] === one ? result : -result);
      return result as -1 | 0 | 1;
    },
  };
  return { provider, count: () => aggregations };
}

for (const vector of vectors) {
  test(`vector: ${vector.name}`, () => {
    const { provider, count } = providerFor(vector.meetings);
    const rows = vector.players.map(({ id, winPoints, diff, scoreFor, games }) =>
      ({ playerId: id, winPoints, diff, scoreFor, games }));
    const ranked = rank(rows, provider);

    assert.deepEqual(ranked.map((entry) => entry.playerId), vector.expectedOrder, "order");
    assert.deepEqual(ranked.map((entry) => entry.order), ranked.map((_, index) => index), "order index");
    if (vector.expectedDisplayRanks) {
      const actual = Object.fromEntries(ranked.map((entry) => [entry.playerId, entry.displayRank]));
      assert.deepEqual(actual, vector.expectedDisplayRanks, "displayRank");
    }
    if (vector.aggregations !== undefined)
      assert.equal(count(), vector.aggregations, "full H2H aggregations performed");
  });
}

test("ranking is deterministic regardless of the order rows arrive in", () => {
  const vector = vectors.find((entry) => entry.name.startsWith("H2H example 2b"))!;
  const rows = vector.players.map(({ id, winPoints, diff, scoreFor, games }) =>
    ({ playerId: id, winPoints, diff, scoreFor, games }));
  const expected = rank(rows, providerFor(vector.meetings).provider).map((entry) => entry.playerId);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const shuffled = [...rows].sort(() => Math.random() - 0.5);
    const actual = rank(shuffled, providerFor(vector.meetings).provider).map((entry) => entry.playerId);
    assert.deepEqual(actual, expected);
  }
});

test("averageScore guards the division rather than returning NaN", () => {
  assert.equal(averageScore(103, 2), 51.5);
  assert.equal(averageScore(0, 0), 0);
  assert.equal(averageScore(500, 0), 0);
});

test("an empty field ranks to an empty list", () => {
  assert.deepEqual(rank([]), []);
});

test("without a provider, no head-to-head is applied at all", () => {
  // The default provider answers "never met" to everything, so a caller that forgets to supply
  // match history gets the plain WinPoint -> Diff -> Average order rather than silent nonsense.
  const rows: RankInput[] = [
    { playerId: "1", winPoints: 4, diff: 0, scoreFor: 5000, games: 1 },
    { playerId: "2", winPoints: 4, diff: 0, scoreFor: 4000, games: 1 },
  ];
  assert.deepEqual(rank(rows).map((entry) => entry.playerId), ["1", "2"]);
});
