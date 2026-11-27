import { playerHistory, type PlayerHistory } from "@/domain/tournament/history";
import type { FinalSlot } from "@/domain/tournament/types";
import { legacyPublicCard, participantKey, type PublicDivisionPayload, type SpectatorContest, type SpectatorDivision, type SpectatorParticipant } from "./spectator-read-model";

export interface SpectatorOpponent {
  code: string;
  name: string;
  school: string;
}

/**
 * One qualifying game's public facts, retained whether or not it is the current assignment.
 *
 * `state` is the CONTEST's state, and `bye` is orthogonal to it: a bye is a real assignment that
 * can be waiting for a result, be recorded, or be official, exactly like a contested pair.
 */
export interface SpectatorPlayerGame {
  key: string;
  game: number;
  /** Presentation grouping of the two seats — pair N holds seats 2N-1 and 2N. */
  pairNumber: number;
  seat: number;
  side: 1 | 2;
  opponent: SpectatorOpponent | null;
  bye: boolean;
  state: SpectatorContest["state"];
  score: { own: number; opponent: number } | null;
  outcome: "W" | "T" | "L" | "PENALTY" | null;
  diff: number | null;
}

/**
 * The championship round. It carries no seat and no table on purpose: officials place the final
 * boards by hand, and the pairing slots the regular seat derivation reads simply do not exist here.
 */
export interface SpectatorFinalMatch {
  label: string;
  opponent: SpectatorOpponent | null;
  decided: boolean;
  won: boolean;
  official: boolean;
}

export interface SpectatorStanding {
  rank: number;
  wins: number;
  draws: number;
  losses: number;
  winPoints: number;
  diff: number;
  /** The last game whose results are official. Everything after it is deliberately not counted. */
  throughGame: number;
  /** Completed bracket placement; the figures remain the official qualifying aggregates. */
  isFinal?: boolean;
}

/**
 * The figures that are safe to present as a finished tournament record.
 *
 * This is a presentation gate over the existing official standing/final order, not another
 * ranking calculation. `statsScope` makes the bracket boundary explicit: finals determine the
 * placing while these aggregate figures remain the qualifying record.
 */
export interface SpectatorCompletedRecord {
  placing: number;
  wins: number;
  draws: number;
  losses: number;
  diff: number;
  gamesPlayed: number;
  /** Existing ranking output: submitted scoreFor divided by counted games. */
  averageScore: number;
  /** Wins divided by every authoritative W/T/L outcome; draws and penalties stay in the denominator. */
  winRate: number;
  statsScope: "tournament" | "qualifying";
}

export interface SpectatorPlayerView {
  participant: SpectatorParticipant;
  divisionId: string;
  divisionLabel: string;
  phase: SpectatorDivision["publication"]["phase"];
  /** The location cue this card announces publicly; legacy payloads normalize to PAIR. */
  slotLabel: SpectatorDivision["slotLabel"];
  /** Every publicly visible qualifying game, independently of the official aggregate cutoff. */
  ledger: SpectatorPlayerGame[];
  /** Only an unresolved published assignment in the current qualifying game can direct a player. */
  assignment: SpectatorPlayerGame | null;
  /** A public result for the current game exists, but the next actionable pairing is not published. */
  recordedCurrentGame: SpectatorPlayerGame | null;
  /** The current qualifying game has no published assignment for this active player yet. */
  awaitingGame: number | null;
  final: SpectatorFinalMatch | null;
  standing: SpectatorStanding | null;
  /** Present only when the public projection proves every displayed achievement is final. */
  completedRecord: SpectatorCompletedRecord | null;
  officialThroughGame: number | null;
  history: PlayerHistory;
}

const opponentOf = (division: SpectatorDivision, key: string | null): SpectatorOpponent | null => {
  const participant = key ? division.participants.find(item => item.key === key) : undefined;
  return participant ? { code: participant.code, name: participant.name, school: participant.school } : null;
};

function gameOf(division: SpectatorDivision, contest: SpectatorContest, key: string): SpectatorPlayerGame {
  const mine = contest.assignments.find(slot => slot.participantKey === key)!;
  const other = contest.assignments.find(slot => slot !== mine)!;
  const result = contest.result;
  const scores = result?.scores ?? null;
  const own = scores ? scores[mine.side - 1] : null;
  const against = scores ? scores[other.side - 1] : null;
  const outcome = !result ? null
    : result.type === "PENALTY" ? "PENALTY" as const
    : result.type === "DRAW" ? "T" as const
    : result.winnerKey === key ? "W" as const : "L" as const;
  const diff = !result ? null
    : result.type === "PENALTY" ? -(result.calculatedDiff ?? 0)
    : result.type === "DRAW" ? 0
    : outcome === "W" ? (result.calculatedDiff ?? 0) : -(result.calculatedDiff ?? 0);
  return {
    key: contest.locator,
    game: contest.game, pairNumber: contest.pairNumber, seat: mine.seat, side: mine.side,
    opponent: opponentOf(division, other.participantKey),
    bye: other.participantKey === null && contest.state !== "void",
    state: contest.state,
    score: own !== null && against !== null ? { own, opponent: against } : null,
    outcome, diff,
  };
}

function finalOf(division: SpectatorDivision, code: string): SpectatorFinalMatch | null {
  const slots = division.finals?.slots ?? [];
  const slot: FinalSlot | undefined = slots.find(item => item.playerOneId === code || item.playerTwoId === code);
  if (!slot) return null;
  const opponentCode = slot.playerOneId === code ? slot.playerTwoId : slot.playerOneId;
  return {
    label: slot.slot === 0 ? "ชิงอันดับ 1 - 2" : "ชิงอันดับ 3 - 4",
    opponent: opponentOf(division, opponentCode ? participantKey(division.id, opponentCode) : null),
    decided: slot.winnerId !== null,
    won: slot.winnerId === code,
    official: division.publication.phase === "complete",
  };
}

/**
 * One player's participation, assembled from the public projection only.
 *
 * `card` is needed for history because the per-game record is a domain calculation shared with every
 * other standings surface — the spectator screen must not grow a second, divergent copy of it.
 */
export function spectatorPlayerView(
  card: PublicDivisionPayload,
  division: SpectatorDivision,
  code: string,
): SpectatorPlayerView | null {
  const key = participantKey(division.id, code);
  const participant = division.participants.find(item => item.key === key);
  if (!participant) return null;
  const ledger = division.contests
    .filter(contest => contest.assignments.some(slot => slot.participantKey === key))
    .map(contest => gameOf(division, contest, key))
    .sort((a, b) => a.game - b.game);
  const regular = participant.listedInStandings && division.publication.phase === "regular";
  const current = ledger.find(game => game.game === division.publication.currentGame);
  const assignment = regular && current?.state === "awaiting-result" ? current : null;
  const recordedCurrentGame = regular && current?.state === "recorded" ? current : null;
  const officialThroughGame = division.publication.officialThroughGame;
  const ranked = division.standings.find(entry => entry.id === code);
  const finalIndex = division.publication.phase === "complete"
    ? division.finalStandings.findIndex(entry => entry.id === code) : -1;
  const includeFinal = division.finals !== null;
  const bracketFormat = card.finalType !== "NONE";
  const allScheduledGamesOfficial = card.games.length > 0 && card.games.every(game =>
    division.publication.officialGames.includes(game.number));
  const allVisibleGamesResolved = ledger.every(game => game.state === "official" || game.state === "void");
  const playerFinal = finalOf(division, code);
  const placing = bracketFormat ? (finalIndex >= 0 ? finalIndex + 1 : null) : ranked?.displayRank ?? null;
  const finalPlacementResolved = !bracketFormat
    || (division.finals !== null && finalIndex >= 0 && (!playerFinal || (playerFinal.decided && playerFinal.official)));
  const decisions = ranked ? ranked.wins + ranked.draws + ranked.losses : 0;
  const completedRecord: SpectatorCompletedRecord | null = division.publication.phase === "complete"
    && participant.listedInStandings
    && ranked !== undefined
    && placing !== null
    && allScheduledGamesOfficial
    && allVisibleGamesResolved
    && finalPlacementResolved
    ? {
        placing,
        wins: ranked.wins,
        draws: ranked.draws,
        losses: ranked.losses,
        diff: ranked.diff,
        gamesPlayed: ranked.games,
        averageScore: ranked.average,
        winRate: decisions > 0 ? ranked.wins / decisions * 100 : 0,
        statsScope: bracketFormat ? "qualifying" : "tournament",
      }
    : null;
  return {
    participant,
    divisionId: division.id,
    divisionLabel: division.division || division.name,
    phase: division.publication.phase,
    slotLabel: division.slotLabel,
    ledger,
    assignment,
    recordedCurrentGame,
    awaitingGame: regular && !current && card.games.some(game => game.number === division.publication.currentGame)
      ? division.publication.currentGame : null,
    final: playerFinal,
    standing: ranked && officialThroughGame !== null ? { rank: finalIndex >= 0 ? finalIndex + 1 : ranked.displayRank,
      wins: ranked.wins, draws: ranked.draws, losses: ranked.losses, winPoints: ranked.winPoints, diff: ranked.diff,
      throughGame: officialThroughGame, ...(finalIndex >= 0 ? { isFinal: true } : {}) } : null,
    completedRecord,
    officialThroughGame,
    history: playerHistory(legacyPublicCard(card), code, { throughGame: officialThroughGame ?? 0, includeFinal }),
  };
}
