import type { PairingRule, PairingSnapshot, Player, TournamentCard } from "@/domain/tournament/types";

const firstNames = ["กฤต", "ชนัญญา", "ธนภัทร", "ปุณณวิช", "พิมพ์ชนก", "รวิศ", "ศิริน", "ณัฐดนัย"];
const lastNames = ["อนันต์กุล", "บุญรักษา", "วัฒนชัย", "ศรีสุข", "ธรรมวงศ์", "ชูเกียรติ"];
const schools = ["สาธิตพัฒนา", "วิทยาคม", "อนุสรณ์ศึกษา", "ประชารัฐ", "วชิรวิทย์", "เทพศิรินทร์"];

export function createMockPlayers(count: number, division: string, start = 1): Player[] {
  return Array.from({ length: count }, (_, index) => {
    const position = start + index;
    return {
      id: `P${String(position).padStart(3, "0")}`,
      firstName: firstNames[index % firstNames.length],
      lastName: lastNames[(index * 3) % lastNames.length],
      school: schools[(index * 5 + Math.floor(index / 4)) % schools.length],
      division,
      wins: index % 4,
      draws: index % 2,
      losses: (index + 1) % 3,
      winPoints: (index % 4) * 2 + (index % 2),
      diff: 120 - index * 7,
    };
  });
}

function makeGames(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `game-${index + 1}`,
    number: index + 1,
    name: `เกม ${index + 1}`,
    status: (index === 0 ? "OPEN" : "PENDING") as "OPEN" | "PENDING",
    maxDiff: 350,
  }));
}

function makeRules(count: number, type: PairingRule["type"] = "SWISS"): PairingRule[] {
  return Array.from({ length: count - 1 }, (_, index) => ({
    fromGame: index + 1,
    toGame: index + 2,
    type,
  }));
}

function makeSnapshot(players: Player[], gameNumber: number, completedPairs: number, confirmed: boolean, repeatOpeningPair = false): PairingSnapshot {
  const rotated = [...players.slice(gameNumber - 1), ...players.slice(0, gameNumber - 1)];
  const ordered = repeatOpeningPair ? [players[0], players[1], ...rotated.filter((player) => player !== players[0] && player !== players[1])] : rotated;
  return {
    id: confirmed ? `snapshot-${gameNumber}` : `preview-${gameNumber}`,
    gameNumbers: [gameNumber],
    confirmedAt: confirmed ? `2026-06-22T0${9 + gameNumber}:00:00.000Z` : "",
    pairings: Array.from({ length: Math.floor(ordered.length / 2) }, (_, index) => {
      const first = ordered[index * 2]; const second = ordered[index * 2 + 1];
      const firstWins = index % 2 === 0;
      return {
        id: `g${gameNumber}-m${index + 1}`,
        tableNumber: index + 1,
        playerOneId: first.id,
        playerTwoId: second.id,
        ...(index < completedPairs ? {
          winnerId: firstWins ? first.id : second.id,
          scoreOne: firstWins ? 100 + index : 68 + index,
          scoreTwo: firstWins ? 72 + index : 100 + index,
          resultType: "WIN" as const,
          calculatedDiff: 28,
        } : {}),
      };
    }),
  };
}

const createdAt = "2026-06-22T09:00:00.000Z";
const amathPlayers = createMockPlayers(24, "ประถมศึกษา");

export const seedCards: TournamentCard[] = [
  {
    id: "amath-primary",
    tournamentId: "seed-tournament",
    name: "A-Math Championship",
    division: "ประถมศึกษา",
    status: "RUNNING",
    runtimeStage: "RESULT_COLLECTION",
    currentGame: 3,
    version: 0,
    games: makeGames(6).map((game) => ({ ...game, status: game.number < 3 ? "COMPLETED" : game.number === 3 ? "OPEN" : "PENDING" })),
    rules: makeRules(6, "SWISS"),
    players: amathPlayers,
    tables: [],
    snapshots: [makeSnapshot(amathPlayers, 1, 12, true), makeSnapshot(amathPlayers, 2, 12, true), makeSnapshot(amathPlayers, 3, 4, false, true)],
    audit: [
      {
        id: "audit-seed-1",
        timestamp: createdAt,
        user: "admin@local",
        action: "CREATE_CARD",
        oldValue: "—",
        newValue: "A-Math Championship / ประถมศึกษา",
      },
      {
        id: "audit-seed-3",
        timestamp: "2026-06-22T12:05:00.000Z",
        user: "referee@local",
        action: "SUBMIT_RESULT",
        oldValue: "game 3 / 3 results",
        newValue: "game 3 / 4 results",
      },
      {
        id: "audit-seed-2",
        timestamp: "2026-06-22T09:10:00.000Z",
        user: "admin@local",
        action: "IMPORT_PLAYERS",
        oldValue: "0 players",
        newValue: "24 players",
      },
    ],
    finalType: "NONE",
    finalGames: 0,
    finalRound: null,
    gibsonEnabled: false,
    createdAt,
  },
  {
    id: "scrabble-junior",
    tournamentId: "seed-tournament",
    name: "Scrabble Open",
    division: "มัธยมศึกษาตอนต้น",
    status: "READY",
    runtimeStage: "TABLE_PAIRING",
    currentGame: 1,
    version: 0,
    games: makeGames(5).map((game) => ({ ...game, status: "PENDING" })),
    rules: makeRules(5, "KING_OF_THE_HILL"),
    players: createMockPlayers(16, "มัธยมศึกษาตอนต้น", 101),
    tables: [],
    snapshots: [],
    audit: [],
    finalType: "NONE",
    finalGames: 0,
    finalRound: null,
    gibsonEnabled: false,
    createdAt: "2026-06-21T07:30:00.000Z",
  },
];
