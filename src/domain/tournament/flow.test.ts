import assert from "node:assert/strict";
import test from "node:test";

import { allResultBlocks, resultBlockGames } from "./flow";
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
