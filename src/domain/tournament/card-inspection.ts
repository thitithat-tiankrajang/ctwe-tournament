import type {
  FinalType, Game, Pairing, PairingRuleType, RuntimeStage, SlotLabel, Tournament, TournamentCard,
} from "./types";

/**
 * Read-only ADMIN inspection of one card, derived ONLY from fields the authenticated full-card
 * payload already carries. Nothing here is persisted, defaulted or invented: a value the payload does
 * not hold is `null`, and the view says so instead of showing a plausible-looking default.
 */

export const inspectionRuleLabels: Record<PairingRuleType, string> = {
  RANDOM: "Random",
  PAIR_RESULT: "แพ้เจอแพ้ / ชนะเจอชนะ",
  SWISS: "Swiss",
  KING_OF_THE_HILL: "King of the Hill",
};

export const inspectionFinalTypeLabels: Record<FinalType, string> = {
  NONE: "ไม่มีรอบชิง",
  CHAMPION: "ชิงที่ 1",
  CHAMPION_AND_THIRD: "ชิงที่ 1 และ 3",
};

export const inspectionGameStatusLabels: Record<Game["status"], string> = {
  PENDING: "ยังไม่เริ่ม",
  OPEN: "กำลังแข่ง",
  COMPLETED: "จบแล้ว",
};

/**
 * none      — no pairing rows for this game in the payload.
 * draft     — rows exist, none published, not confirmed (a preview the operator has not released).
 * partial   — some rows published, not confirmed.
 * published — every row published, results not yet confirmed into a snapshot.
 * confirmed — rows belong to a confirmed snapshot.
 */
export type PairingState = "none" | "draft" | "partial" | "published" | "confirmed";

export interface InspectionPairingRow {
  table: number;
  playerOne: string | null;
  playerTwo: string | null;
  scoreOne: number | null;
  scoreTwo: number | null;
  published: boolean;
  voided: boolean;
  /** One side empty on a slot that was not voided: the player sits out this game. */
  bye: boolean;
}

export interface InspectionGame {
  number: number;
  status: Game["status"];
  /** The persisted per-game Maximum Difference. `null` only if the payload carries no usable value. */
  maxDiff: number | null;
  /** Game 1 uses the card's initial rule; game N uses the rule whose `toGame` is N. */
  rule: PairingRuleType | null;
  ruleSource: "initial" | "transition" | "unset";
  pairingState: PairingState;
  /**
   * Where the rows came from. "seating" is the game-1 PAIRING_PREVIEW draft, which lives in
   * `card.tables` (seats) because match rows are only created when the pairing is confirmed.
   */
  pairingSource: "matches" | "seating" | "none";
  /** Pair slots, numbered like the operational pairing view (a bye occupies a slot of its own). */
  tableCount: number;
  publishedCount: number;
  resultCount: number;
  pairings: InspectionPairingRow[];
}

export interface CardInspection {
  cardId: string;
  tournamentId: string;
  name: string;
  division: string;
  status: TournamentCard["status"];
  runtimeStage: RuntimeStage;
  currentGame: number;
  totalGames: number;
  initialPairingRule: PairingRuleType | null;
  games: InspectionGame[];
  finalType: FinalType;
  finalGames: number | null;
  finalSlotCount: number | null;
  finalDecidedCount: number | null;
  gibsonEnabled: boolean;
  slotLabel: SlotLabel | null;
}

export type InspectionState =
  | { kind: "missing" }
  | { kind: "partial" }
  | { kind: "ready"; inspection: CardInspection };

export type TournamentInspection =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "unavailable" }
  | { kind: "ready"; name: string; status: Tournament["status"] };

/** Who may see the inspection section. Deliberately ADMIN only, and deliberately NOT a mutation gate. */
export { isAdmin as canInspectCard } from "./roles";

const belongsToGame = (pairing: Pairing, gameNumber: number) =>
  pairing.gameNumber === gameNumber || pairing.id.startsWith(`g${gameNumber}-`);

/**
 * The game-1 draft, read from seats exactly as the operational pairing page reads it
 * (`src/app/cards/[id]/tables/page.tsx`): only while the card is in PAIRING_PREVIEW for game 1, each
 * table's seats are taken two at a time, a trailing single seat is a bye, and pair slots are numbered
 * consecutively across tables. Seats outlive confirmation (they are cleared when results are
 * published), so outside that stage they are NOT pairing data and are ignored here.
 */
export function gameOneSeatingPairs(card: TournamentCard): Pairing[] {
  if (card.runtimeStage !== "PAIRING_PREVIEW" || card.currentGame !== 1 || !Array.isArray(card.tables)) return [];
  return card.tables
    .flatMap((table) => {
      const pairs: { one: string; two: string | null }[] = [];
      for (let i = 0; i < table.playerIds.length; i += 2)
        pairs.push({ one: table.playerIds[i], two: table.playerIds[i + 1] ?? null });
      return pairs;
    })
    .map((pair, index) => ({ id: `g1-${index + 1}`, gameNumber: 1, tableNumber: index + 1, playerOneId: pair.one, playerTwoId: pair.two }));
}

function pairingsOfGame(card: TournamentCard, gameNumber: number) {
  const rows: { pairing: Pairing; confirmed: boolean }[] = [];
  for (const snapshot of card.snapshots) {
    if (!snapshot.gameNumbers.includes(gameNumber)) continue;
    for (const pairing of snapshot.pairings) {
      if (belongsToGame(pairing, gameNumber)) rows.push({ pairing, confirmed: Boolean(snapshot.confirmedAt) });
    }
  }
  rows.sort((a, b) => a.pairing.tableNumber - b.pairing.tableNumber);
  // Match rows win whenever they exist, so seats are never counted on top of them.
  if (rows.length > 0) return { rows, source: "matches" as const };
  if (gameNumber === 1) {
    const seating = gameOneSeatingPairs(card).map((pairing) => ({ pairing, confirmed: false }));
    if (seating.length > 0) return { rows: seating, source: "seating" as const };
  }
  return { rows, source: "none" as const };
}

function pairingStateOf(rows: { pairing: Pairing; confirmed: boolean }[]): PairingState {
  if (rows.length === 0) return "none";
  if (rows.some((row) => row.confirmed)) return "confirmed";
  const published = rows.filter((row) => row.pairing.pairingPublished).length;
  if (published === 0) return "draft";
  return published === rows.length ? "published" : "partial";
}

function ruleFor(card: TournamentCard, gameNumber: number): Pick<InspectionGame, "rule" | "ruleSource"> {
  if (gameNumber === 1) {
    return card.initialPairingRule
      ? { rule: card.initialPairingRule, ruleSource: "initial" }
      : { rule: null, ruleSource: "unset" };
  }
  const rule = card.rules.find((item) => item.toGame === gameNumber);
  return rule ? { rule: rule.type, ruleSource: "transition" } : { rule: null, ruleSource: "unset" };
}

/** A summary-only (catalog) card is never treated as complete inspection data. */
export function inspectCard(card: TournamentCard | undefined): InspectionState {
  if (!card) return { kind: "missing" };
  if (card.summaryOnly || !Array.isArray(card.games) || !Array.isArray(card.rules) || !Array.isArray(card.snapshots)
    || !Array.isArray(card.tables))
    return { kind: "partial" };

  const games: InspectionGame[] = [...card.games]
    .sort((a, b) => a.number - b.number)
    .map((game) => {
      const { rows, source } = pairingsOfGame(card, game.number);
      return {
        number: game.number,
        status: game.status,
        maxDiff: Number.isFinite(game.maxDiff) && game.maxDiff > 0 ? game.maxDiff : null,
        ...ruleFor(card, game.number),
        pairingState: pairingStateOf(rows),
        pairingSource: source,
        tableCount: rows.length,
        publishedCount: rows.filter((row) => row.confirmed || row.pairing.pairingPublished).length,
        resultCount: rows.filter((row) => row.pairing.scoreOne !== undefined && row.pairing.scoreTwo !== undefined).length,
        pairings: rows.map(({ pairing, confirmed }) => ({
          table: pairing.tableNumber,
          playerOne: pairing.playerOneId,
          playerTwo: pairing.playerTwoId,
          scoreOne: pairing.scoreOne ?? null,
          scoreTwo: pairing.scoreTwo ?? null,
          published: confirmed || Boolean(pairing.pairingPublished),
          voided: Boolean(pairing.voided),
          bye: !pairing.voided && (pairing.playerOneId === null || pairing.playerTwoId === null),
        })),
      };
    });

  const hasFinal = card.finalType !== "NONE";
  return {
    kind: "ready",
    inspection: {
      cardId: card.id,
      tournamentId: card.tournamentId,
      name: card.name,
      division: card.division,
      status: card.status,
      runtimeStage: card.runtimeStage,
      currentGame: card.currentGame,
      totalGames: card.games.length,
      initialPairingRule: card.initialPairingRule ?? null,
      games,
      finalType: card.finalType,
      finalGames: hasFinal ? card.finalGames : null,
      finalSlotCount: hasFinal && card.finalRound ? card.finalRound.slots.length : null,
      finalDecidedCount: hasFinal && card.finalRound ? card.finalRound.slots.filter((slot) => slot.winnerId).length : null,
      gibsonEnabled: card.gibsonEnabled,
      slotLabel: card.slotLabel ?? null,
    },
  };
}

/** Resolve the card's tournament from the back-office tournament list (ADMIN receives every one). */
export function inspectTournament(tournaments: Tournament[] | null | undefined, tournamentId: string | undefined): TournamentInspection {
  if (tournaments === null || tournaments === undefined) return { kind: "loading" };
  const match = tournamentId ? tournaments.find((tournament) => tournament.id === tournamentId) : undefined;
  return match ? { kind: "ready", name: match.name, status: match.status } : { kind: "unavailable" };
}
