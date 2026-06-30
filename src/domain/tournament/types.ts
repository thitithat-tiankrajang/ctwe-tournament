export type CardStatus = "DRAFT" | "READY" | "RUNNING" | "FINISHED" | "CLOSED";
export type RuntimeStage =
  | "PLAYER_REGISTRATION"
  | "TABLE_PAIRING"
  | "PAIRING_PREVIEW"
  | "RESULT_COLLECTION"
  | "RESULT_REVIEW"
  | "FINAL_SEEDING"
  | "FINAL_COLLECTION"
  | "FINAL_PUBLISHED";
export type PairingRuleType = "PAIR_RESULT" | "SWISS" | "KING_OF_THE_HILL";
export type FinalType = "NONE" | "CHAMPION" | "CHAMPION_AND_THIRD";

export interface FinalGameResult {
  gameIndex: number;
  scoreOne: number | null;
  scoreTwo: number | null;
  winnerId: string | null;
}
/** One play-off bracket slot: slot 0 decides 1st/2nd, slot 1 decides 3rd/4th. */
export interface FinalSlot {
  slot: number;
  playerOneId: string;
  playerTwoId: string;
  games: FinalGameResult[];
  winnerId: string | null;
}
export interface FinalRound {
  slots: FinalSlot[];
}

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

export interface Tournament {
  id: string;
  name: string;
  status: "OPEN" | "CLOSED";
  createdBy: string | null;
  createdAt: string;
  version: number;
  directors: string[];
  cardCount: number;
  accessToken: string;
}

/** Anonymous view of an OPEN tournament shown on the public root landing + token resolver. */
export interface PublicTournamentSummary {
  id: string;
  name: string;
  accessToken: string;
  cardCount: number;
  publishedCardCount: number;
}

export type ManagedRole = "ROLE_ADMIN" | "ROLE_DIRECTOR" | "ROLE_STAFF";

export interface ManagedUser {
  username: string;
  role: ManagedRole;
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
  tournamentIds: string[];
}

export interface TournamentCard {
  id: string;
  tournamentId: string;
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
  finalType: FinalType;
  finalGames: number;
  finalRound: FinalRound | null;
  gibsonEnabled: boolean;
  createdAt: string;
  /** Present on the compact anonymous catalog representation. */
  playerCount?: number;
  gameCount?: number;
  publishedGameCount?: number;
  summaryOnly?: boolean;
}

export interface PublicCardSummary {
  id: string;
  tournamentId: string;
  name: string;
  division: string;
  status: CardStatus;
  runtimeStage: RuntimeStage;
  currentGame: number;
  gameCount: number;
  playerCount: number;
  publishedGameCount: number;
  version: number;
  createdAt: string;
}

export interface PublicCardVersion {
  id: string;
  version: number;
}

export interface CreateCardInput {
  tournamentId: string;
  name: string;
  division: string;
  numberOfGames: number;
  rules: PairingRuleType[];
  gameMaxDiffs: number[];
  finalType: FinalType;
  finalGames: number;
  gibsonEnabled: boolean;
}
