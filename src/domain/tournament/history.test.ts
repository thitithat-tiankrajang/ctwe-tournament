import assert from "node:assert/strict";
import test from "node:test";

import { playerHistory, rankingAfterGame } from "./history";

/** Every qualifying game the fixture card has, with no championship rows. */
const ALL_QUALIFYING = { throughGame: 3, includeFinal: false } as const;
import type { Pairing, Player, TournamentCard } from "./types";

function player(id: string): Player {
  return {
    id,
    firstName: id,
    lastName: "Player",
    school: "School",
    division: "Open",
    wins: 0,
    draws: 0,
    losses: 0,
    winPoints: 0,
    diff: 0,
    terminated: false,
  };
}

function cardWith(pairings: Pairing[]): TournamentCard {
  return {
    id: "card-1",
    tournamentId: "tournament-1",
    name: "Card",
    division: "Open",
    status: "RUNNING",
    runtimeStage: "TABLE_PAIRING",
    currentGame: 3,
    version: 1,
    games: [1, 2, 3].map((number) => ({ id: `game-${number}`, number, name: `Game ${number}`, status: "COMPLETED", maxDiff: 100 })),
    initialPairingRule: "RANDOM",
    rules: [],
    players: [player("A001"), player("A002")],
    tables: [],
    snapshots: [{ id: "snapshot-1", gameNumbers: [1, 2, 3], pairings, confirmedAt: "2026-07-13T00:00:00Z" }],
    audit: [],
    finalType: "NONE",
    finalGames: 0,
    finalRound: null,
    gibsonEnabled: false,
    createdAt: "2026-07-13T00:00:00Z",
  };
}

test("rankingAfterGame applies wins and draws through the requested game", () => {
  const card = cardWith([
    { id: "g1", gameNumber: 1, tableNumber: 1, playerOneId: "A001", playerTwoId: "A002", winnerId: "A001", scoreOne: 500, scoreTwo: 450, resultType: "WIN", calculatedDiff: 50 },
    { id: "g2", gameNumber: 2, tableNumber: 1, playerOneId: "A001", playerTwoId: "A002", scoreOne: 400, scoreTwo: 400, resultType: "DRAW", calculatedDiff: 0 },
    { id: "g3", gameNumber: 3, tableNumber: 1, playerOneId: "A001", playerTwoId: "A002", winnerId: "A002", scoreOne: 300, scoreTwo: 500, resultType: "WIN", calculatedDiff: 100 },
  ]);

  const ranking = rankingAfterGame(card, 2);
  assert.deepEqual(
    ranking.map(({ id, wins, draws, losses, winPoints, diff }) => ({ id, wins, draws, losses, winPoints, diff })),
    [
      { id: "A001", wins: 1, draws: 1, losses: 0, winPoints: 3, diff: 50 },
      { id: "A002", wins: 0, draws: 1, losses: 1, winPoints: 1, diff: -50 },
    ],
  );
});

test("penalty counts as a loss and subtracts diff from both players", () => {
  const card = cardWith([
    { id: "g1", gameNumber: 1, tableNumber: 1, playerOneId: "A001", playerTwoId: "A002", scoreOne: 0, scoreTwo: 0, resultType: "PENALTY", calculatedDiff: 25 },
  ]);

  const ranking = rankingAfterGame(card, 1);
  assert.deepEqual(
    ranking.map(({ id, wins, losses, winPoints, diff }) => ({ id, wins, losses, winPoints, diff })),
    [
      { id: "A001", wins: 0, losses: 1, winPoints: 0, diff: -25 },
      { id: "A002", wins: 0, losses: 1, winPoints: 0, diff: -25 },
    ],
  );

  assert.deepEqual(
    playerHistory(card, "A002", ALL_QUALIFYING).qualifying.map(({ result, diff, cumulativeDiff, cumulativeWinPoints }) => ({ result, diff, cumulativeDiff, cumulativeWinPoints })),
    [{ result: "L", diff: -25, cumulativeDiff: -25, cumulativeWinPoints: 0 }],
  );
});

test("bye awards the lone player and remains visible in player history", () => {
  const card = cardWith([
    { id: "g1", gameNumber: 1, tableNumber: 1, playerOneId: null, playerTwoId: "A002", winnerId: "A002", scoreOne: 0, scoreTwo: 60, resultType: "WIN", calculatedDiff: 60 },
  ]);

  assert.deepEqual(
    rankingAfterGame(card, 1).map(({ id, wins, losses, winPoints, diff }) => ({ id, wins, losses, winPoints, diff })),
    [
      { id: "A002", wins: 1, losses: 0, winPoints: 2, diff: 60 },
      { id: "A001", wins: 0, losses: 0, winPoints: 0, diff: 0 },
    ],
  );
  assert.deepEqual(
    playerHistory(card, "A002", ALL_QUALIFYING).qualifying.map(({ result, ownScore, opponentScore, diff, opponentId }) => ({ result, ownScore, opponentScore, diff, opponentId })),
    [{ result: "W", ownScore: 60, opponentScore: 0, diff: 60, opponentId: "" }],
  );
});

test("invalid result without a winner never awards a phantom win", () => {
  const card = cardWith([
    { id: "g1", gameNumber: 1, tableNumber: 1, playerOneId: "A001", playerTwoId: "A002", scoreOne: 500, scoreTwo: 400, resultType: "WIN", calculatedDiff: 100 },
  ]);

  assert.deepEqual(
    rankingAfterGame(card, 1).map(({ wins, losses, winPoints, diff }) => ({ wins, losses, winPoints, diff })),
    [
      { wins: 0, losses: 0, winPoints: 0, diff: 0 },
      { wins: 0, losses: 0, winPoints: 0, diff: 0 },
    ],
  );
});

// ---- History scope (C4) ------------------------------------------------------------------------
// `cardWith` puts every pairing in ONE snapshot spanning games 1-3, which is exactly the shape a
// PAIR_RESULT block produces and exactly what the previous whole-snapshot filter got wrong.

const threeGames: Pairing[] = [
  { id: "g1", gameNumber: 1, tableNumber: 1, playerOneId: "A001", playerTwoId: "A002", winnerId: "A001", scoreOne: 500, scoreTwo: 450, resultType: "WIN", calculatedDiff: 50 },
  { id: "g2", gameNumber: 2, tableNumber: 1, playerOneId: "A001", playerTwoId: "A002", winnerId: "A002", scoreOne: 400, scoreTwo: 430, resultType: "WIN", calculatedDiff: 30 },
  { id: "g3", gameNumber: 3, tableNumber: 1, playerOneId: "A001", playerTwoId: "A002", winnerId: "A001", scoreOne: 600, scoreTwo: 500, resultType: "WIN", calculatedDiff: 100 },
];

test("a snapshot spanning games 1-3 still shows game 1 when game 1 is selected", () => {
  const card = cardWith(threeGames);
  assert.deepEqual(
    playerHistory(card, "A001", { throughGame: 1, includeFinal: false }).qualifying.map(({ game, cumulativeWinPoints, cumulativeDiff }) => ({ game, cumulativeWinPoints, cumulativeDiff })),
    [{ game: 1, cumulativeWinPoints: 2, cumulativeDiff: 50 }],
  );
});

test("selecting game N shows games 1..N with totals that stop at N", () => {
  const card = cardWith(threeGames);
  assert.deepEqual(
    playerHistory(card, "A001", { throughGame: 2, includeFinal: false }).qualifying.map(({ game, cumulativeWinPoints, cumulativeDiff }) => ({ game, cumulativeWinPoints, cumulativeDiff })),
    [{ game: 1, cumulativeWinPoints: 2, cumulativeDiff: 50 }, { game: 2, cumulativeWinPoints: 2, cumulativeDiff: 20 }],
  );
  assert.equal(playerHistory(card, "A001", { throughGame: 3, includeFinal: false }).qualifying.length, 3);
});

function cardWithFinal(pairings: Pairing[]): TournamentCard {
  return {
    ...cardWith(pairings),
    finalType: "CHAMPION",
    finalGames: 1,
    finalRound: {
      slots: [{
        slot: 0, playerOneId: "A001", playerTwoId: "A002", winnerId: "A001",
        winnerWins: 1, winnerLosses: 0, totalDiff: 900,
        games: [{ gameIndex: 1, scoreOne: 1000, scoreTwo: 100, winnerId: "A001", diff: 900 }],
      }],
    },
  };
}

test("a qualifying-game view never shows championship rows or their totals", () => {
  const card = cardWithFinal(threeGames);
  const { qualifying, final, qualifyingTotals } = playerHistory(card, "A001", { throughGame: 3, includeFinal: false });
  assert.equal(qualifying.length, 3);
  assert.equal(final.length, 0);
  // The championship game is worth +900 diff and 2 win points; neither may leak in.
  assert.deepEqual(qualifyingTotals, { winPoints: 4, diff: 120 });
});

test("the final is a separate accumulation and never moves the qualification totals", () => {
  const card = cardWithFinal(threeGames);
  const withFinal = playerHistory(card, "A001", { throughGame: 3, includeFinal: true });
  const without = playerHistory(card, "A001", { throughGame: 3, includeFinal: false });

  // Qualification is byte-identical whether or not the championship is included.
  assert.deepEqual(withFinal.qualifying, without.qualifying);
  assert.deepEqual(withFinal.qualifyingTotals, without.qualifyingTotals);
  assert.deepEqual(withFinal.qualifyingTotals, { winPoints: 4, diff: 120 });

  // The championship carries its OWN running totals, starting from zero.
  assert.equal(withFinal.final.length, 1);
  assert.deepEqual(
    withFinal.final.map(({ gameLabel, final: isFinal, cumulativeWinPoints, cumulativeDiff }) =>
      ({ gameLabel, isFinal, cumulativeWinPoints, cumulativeDiff })),
    [{ gameLabel: "ชิง 1", isFinal: true, cumulativeWinPoints: 2, cumulativeDiff: 900 }],
  );
});

test("qualification and championship row keys never collide", () => {
  const card = cardWithFinal(threeGames);
  const { qualifying, final } = playerHistory(card, "A001", { throughGame: 3, includeFinal: true });
  const keys = [...qualifying, ...final].map((row) => row.key);
  assert.deepEqual(keys, ["q-1", "q-2", "q-3", "f-1"]);
  assert.equal(new Set(keys).size, keys.length);
});

test("a non-finalist gets nothing extra even when the final is requested", () => {
  const card = cardWithFinal([threeGames[0]]);
  const history = playerHistory(card, "A003", { throughGame: 3, includeFinal: true });
  assert.equal(history.qualifying.length, 0);
  assert.equal(history.final.length, 0);
});
