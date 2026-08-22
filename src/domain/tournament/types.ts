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
export type PairingRuleType = "PAIR_RESULT" | "SWISS" | "KING_OF_THE_HILL" | "RANDOM";
export type FinalType = "NONE" | "CHAMPION" | "CHAMPION_AND_THIRD";

export interface FinalGameResult {
  gameIndex: number;
  scoreOne: number | null;
  scoreTwo: number | null;
  winnerId: string | null;
  diff: number | null;
}
/** One play-off bracket slot: slot 0 decides 1st/2nd, slot 1 decides 3rd/4th. */
export interface FinalSlot {
  slot: number;
  playerOneId: string;
  playerTwoId: string;
  games: FinalGameResult[];
  winnerId: string | null;
  winnerWins: number | null;
  winnerLosses: number | null;
  totalDiff: number | null;
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
  terminated: boolean;
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
  resultType?: "WIN" | "DRAW" | "PENALTY";
  calculatedDiff?: number;
  playerOneGibsonized?: boolean;
  playerTwoGibsonized?: boolean;
  pairingPublished?: boolean;
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

/**
 * Why publication is or is not currently authorized (architecture §4.3).
 *
 * `contentFingerprint` is what the approver consented to; `currentFingerprint` is what the cards say
 * now. They diverge exactly when publicly visible data changed after approval, which is the case the
 * approval exists to catch.
 */
export interface PublicSnapshotApproval {
  valid: boolean;
  reason: string;
  approvedBy: string | null;
  approvedAt: string | null;
  expiresAt: string | null;
  acknowledgmentRev: number;
  contentFingerprint: string | null;
  currentFingerprint: string;
  currentAcknowledgmentRev: number;
}

/** Admin view of one tournament's public snapshot: what is published, and whether more may be. */
export interface PublicSnapshotStatus {
  state: "NOT_PUBLISHED" | "APPROVED" | "PUBLISHING" | "PUBLISHED" | "PUBLISH_FAILED" | "RETRACTED";
  version: number;
  publishedAt: string | null;
  checksum: string | null;
  objectKey: string;
  publicUrl: string | null;
  cardCount: number;
  unfinishedCardCount: number;
  storageConfigured: boolean;
  approval: PublicSnapshotApproval;
}

/** A tournament standing between the operator and a backend shutdown (architecture §19.1). */
export interface ShutdownBlocker {
  tournamentId: string;
  name: string;
  snapshotState: PublicSnapshotStatus["state"];
  cardCount: number;
  unfinishedCardCount: number;
}

/** One published snapshot the stop workflow must verify from outside the backend (§19.3). */
export interface ShutdownPublishedSnapshot {
  tournamentId: string;
  name: string;
  h: string;
  version: number;
  sha: string;
}

/**
 * The shutdown gate's answer. Advisory: the workflow still fetches every snapshot over the public
 * internet before it suspends anything, because the backend may not judge its own shutdown (§19.3).
 */
export interface ShutdownReadiness {
  activeTournamentCount: number;
  unpublishedFinished: ShutdownBlocker[];
  publishedSnapshots: ShutdownPublishedSnapshot[];
  shelved: ShutdownBlocker[];
  readyToStop: boolean;
}

/** Anonymous view of an OPEN tournament shown on the public root landing + token resolver. */
export interface PublicTournamentSummary {
  id: string;
  name: string;
  accessToken: string;
  cardCount: number;
  publishedCardCount: number;
}

/** One-shot viewer payload: tournament metadata plus every card's full public data. */
export interface PublicTournamentBundle extends PublicTournamentSummary {
  cards: TournamentCard[];
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
  initialPairingRule: Exclude<PairingRuleType, "PAIR_RESULT">;
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
  /** Per-card player-code letter prefix (A, B, …), unique within the tournament. "P" for legacy data. */
  codePrefix?: string;
  /** Present on the compact anonymous catalog representation. */
  playerCount?: number;
  gameCount?: number;
  publishedGameCount?: number;
  summaryOnly?: boolean;
}

export interface PublicCardSummary {
  /**
   * Discriminator, never sent by the server. It exists so a {@link BackOfficeCardSummary} cannot be
   * passed where a public summary is expected — TypeScript is structural, and these two carry the
   * same twelve fields with *different values*.
   */
  readonly scope?: "public";
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

/**
 * `GET /api/card-summaries` — the authenticated back-office card list (P1-B).
 *
 * **Structurally identical to {@link PublicCardSummary} and deliberately a separate type**, mirroring
 * the backend's `BackOfficeCardDtos.CardSummary`. The public summary carries public-projected
 * *values*: a derived public stage, `playerCount` forced to 0 during registration, and
 * `public_version` in place of `version` (measured divergence: staff stage `PAIRING_PREVIEW` vs
 * public `TABLE_PAIRING`, staff version 11 vs public 7).
 *
 * Sharing one type would let `publicSummaryCard()` convert one of these into a card bound for the
 * staff store, where the wrong `version` would then meet `replaceCard`'s guard. The `scope`
 * discriminator makes that a compile error rather than a silent divergence during live scoring.
 */
export interface BackOfficeCardSummary {
  readonly scope?: "back-office";
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
  /** `tournament_cards.version` — the staff version, never `public_version`. */
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
  initialPairingRule: Exclude<PairingRuleType, "PAIR_RESULT">;
  rules: PairingRuleType[];
  gameMaxDiffs: number[];
  finalType: FinalType;
  finalGames: number;
  gibsonEnabled: boolean;
}
