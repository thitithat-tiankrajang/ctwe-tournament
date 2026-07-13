import assert from "node:assert/strict";
import test from "node:test";

import { playerHistory, rankingAfterGame } from "./history";
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
    playerHistory(card, "A002").map(({ result, diff, cumulativeDiff, cumulativeWinPoints }) => ({ result, diff, cumulativeDiff, cumulativeWinPoints })),
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
    playerHistory(card, "A002").map(({ result, ownScore, opponentScore, diff, opponentId }) => ({ result, ownScore, opponentScore, diff, opponentId })),
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
