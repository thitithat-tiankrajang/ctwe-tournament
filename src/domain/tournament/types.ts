export type CardStatus = "DRAFT" | "READY" | "RUNNING" | "FINISHED" | "CLOSED";
export type RuntimeStage =
  | "PLAYER_REGISTRATION"
  | "TABLE_PAIRING"
  | "PAIRING_PREVIEW"
  | "RESULT_COLLECTION"
  | "RESULT_REVIEW"
  | "FINAL_PUBLISHED";
export type PairingRuleType = "PAIR_RESULT" | "SWISS" | "KING_OF_THE_HILL";

export interface PairingRule {
  fromGame: number;
  toGame: number;
  type: PairingRuleType;
}

export interface Game {
  id: string;
  number: number;
  name: string;
  status: "PENDING" | "OPEN" | "COMPLETED";
  maxDiff: number;
}

export interface Player {
  id: string;
  firstName: string;
  lastName: string;
  school: string;
  division: string;
  wins: number;
  draws: number;
  losses: number;
  winPoints: number;
  diff: number;
}

export interface SeatingTable {
  id: string;
  number: number;
  playerIds: string[];
}

export interface Pairing {
  id: string;
  gameNumber?: number;
  tableNumber: number;
  playerOneId: string | null;
  playerTwoId: string | null;
  winnerId?: string;
  scoreOne?: number;
  scoreTwo?: number;
  resultType?: "WIN" | "DRAW";
  calculatedDiff?: number;
}

export interface PairingSnapshot {
  id: string;
  gameNumbers: number[];
  pairings: Pairing[];
  confirmedAt: string;
}

export interface AuditEntry {
  id: string;
  timestamp: string;
  user: string;
  action: string;
  oldValue: string;
  newValue: string;
}

export interface TournamentCard {
  id: string;
  name: string;
  division: string;
  status: CardStatus;
  runtimeStage: RuntimeStage;
  currentGame: number;
  version: number;
  games: Game[];
  rules: PairingRule[];
  players: Player[];
  tables: SeatingTable[];
  snapshots: PairingSnapshot[];
  audit: AuditEntry[];
  createdAt: string;
}

export interface CreateCardInput {
  name: string;
  division: string;
  numberOfGames: number;
  rules: PairingRuleType[];
  gameMaxDiffs: number[];
}
