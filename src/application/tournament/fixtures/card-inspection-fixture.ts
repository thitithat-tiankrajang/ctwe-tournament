import type { TournamentCard } from "@/domain/tournament/types";

/** Synthetic full (staff-view) card: three games, distinct maxDiff and a different rule per game. */
export function inspectionFixture(): TournamentCard {
  return {
    id: "card-1", tournamentId: "t-open", name: "ประถม", division: "ชาย", status: "RUNNING",
    runtimeStage: "RESULT_COLLECTION", currentGame: 2, version: 7,
    games: [
      { id: "1", number: 1, name: "เกม 1", status: "COMPLETED", maxDiff: 250 },
      { id: "2", number: 2, name: "เกม 2", status: "OPEN", maxDiff: 400 },
      { id: "3", number: 3, name: "เกม 3", status: "PENDING", maxDiff: 175 },
    ],
    initialPairingRule: "RANDOM",
    rules: [
      { fromGame: 1, toGame: 2, type: "SWISS" },
      { fromGame: 2, toGame: 3, type: "KING_OF_THE_HILL" },
    ],
    players: [], tables: [], audit: [],
    snapshots: [
      { id: "s1", gameNumbers: [1], confirmedAt: "2026-11-01T10:00:00Z", pairings: [
        { id: "g1-t2", gameNumber: 1, tableNumber: 2, playerOneId: "A003", playerTwoId: "A004", scoreOne: 300, scoreTwo: 280 },
        { id: "g1-t1", gameNumber: 1, tableNumber: 1, playerOneId: "A001", playerTwoId: "A002", scoreOne: 410, scoreTwo: 390 },
      ] },
      { id: "preview-2", gameNumbers: [2], confirmedAt: "", pairings: [
        { id: "g2-t1", gameNumber: 2, tableNumber: 1, playerOneId: "A001", playerTwoId: "A003", pairingPublished: true },
        { id: "g2-t2", gameNumber: 2, tableNumber: 2, playerOneId: "A002", playerTwoId: "A004", pairingPublished: true, scoreOne: 350, scoreTwo: 200 },
      ] },
    ],
    finalType: "CHAMPION_AND_THIRD", finalGames: 3, finalRound: null,
    gibsonEnabled: true, slotLabel: "SEAT", createdAt: "2026-11-01T00:00:00Z", screeningPool: [], codePrefix: "A",
  };
}

const code = (n: number) => `A${String(n).padStart(3, "0")}`;

/**
 * Seats exactly as the backend's generateInitialTables lays them out: consecutive pairs, two pairs
 * per four-seat table; a bye takes seat 3 of the last table when the pair count is odd, otherwise
 * seat 1 of a new table. Game 1 in PAIRING_PREVIEW has NO match rows yet — only these seats.
 */
export function seatsFor(playerCount: number) {
  const pairCount = Math.floor(playerCount / 2);
  const tables: { id: string; number: number; playerIds: string[] }[] = [];
  for (let pair = 0; pair < pairCount; pair += 2) {
    const seats = [code(pair * 2 + 1), code(pair * 2 + 2)];
    if (pair + 1 < pairCount) seats.push(code(pair * 2 + 3), code(pair * 2 + 4));
    tables.push({ id: String(tables.length + 1), number: tables.length + 1, playerIds: seats });
  }
  if (playerCount % 2 === 1) {
    if (pairCount % 2 === 1) tables[tables.length - 1].playerIds.push(code(playerCount));
    else tables.push({ id: String(tables.length + 1), number: tables.length + 1, playerIds: [code(playerCount)] });
  }
  return tables;
}

/** Game 1 drafted (PAIRING_PREVIEW) from seats; nothing confirmed or published yet. */
export function gameOnePreviewFixture(playerCount: number): TournamentCard {
  const card = inspectionFixture();
  card.runtimeStage = "PAIRING_PREVIEW";
  card.currentGame = 1;
  card.games = card.games.map((game) => ({ ...game, status: game.number === 1 ? "OPEN" : "PENDING" }));
  card.snapshots = [];
  card.tables = seatsFor(playerCount);
  return card;
}
