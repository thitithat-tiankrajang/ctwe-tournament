import assert from "node:assert/strict";
import test from "node:test";

import { allResultBlocks, editableResultGames, resultBlockGames, rosterBlockScopes } from "./flow";
import type { TournamentCard } from "./types";

function flowCard(currentGame: number): TournamentCard {
  return {
    id: "card-1",
    tournamentId: "tournament-1",
    name: "Card",
    division: "Open",
    status: "RUNNING",
    runtimeStage: "TABLE_PAIRING",
    currentGame,
    version: 1,
    games: [1, 2, 3, 4, 5].map((number) => ({ id: `game-${number}`, number, name: `Game ${number}`, status: "PENDING", maxDiff: 100 })),
    initialPairingRule: "RANDOM",
    rules: [
      { fromGame: 1, toGame: 2, type: "PAIR_RESULT" },
      { fromGame: 2, toGame: 3, type: "SWISS" },
      { fromGame: 4, toGame: 5, type: "PAIR_RESULT" },
    ],
    players: [],
    tables: [],
    snapshots: [],
    audit: [],
    finalType: "NONE",
    finalGames: 0,
    finalRound: null,
    gibsonEnabled: false,
    createdAt: "2026-07-13T00:00:00Z",
  };
}

test("PAIR_RESULT edges form two-game result blocks", () => {
  assert.deepEqual(allResultBlocks(flowCard(1)), [[1, 2], [3], [4, 5]]);
  assert.deepEqual(resultBlockGames(flowCard(1)), [1, 2]);
  assert.deepEqual(resultBlockGames(flowCard(3)), [3]);
  assert.deepEqual(resultBlockGames(flowCard(4)), [4, 5]);
});

test("roster operations can apply to both active games or start after one of them", () => {
  const card: TournamentCard = { ...flowCard(1), runtimeStage: "RESULT_COLLECTION" };
  assert.deepEqual(rosterBlockScopes(card).map(({ game }) => game), [1, 2, 3]);
});

test("a published source game is preserved when selecting where to withdraw a player", () => {
  const card: TournamentCard = {
    ...flowCard(1),
    runtimeStage: "RESULT_COLLECTION",
    snapshots: [{ id: "source-game", gameNumbers: [1], pairings: [], confirmedAt: "2026-07-13T01:00:00Z" }],
  };
  assert.deepEqual(editableResultGames(card), [2]);
  assert.deepEqual(rosterBlockScopes(card).map(({ game }) => game), [2, 3]);
});

test("roster block scopes are unavailable outside result collection or in a standalone game", () => {
  assert.deepEqual(rosterBlockScopes(flowCard(1)), []);
  assert.deepEqual(rosterBlockScopes({ ...flowCard(3), runtimeStage: "RESULT_COLLECTION" }), []);
});
