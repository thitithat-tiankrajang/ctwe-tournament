import { finalStandings as calculateFinalStandings, rankingAfterGame } from "@/domain/tournament/history";
import { isRecordedPairing, isVoidPairing } from "@/domain/tournament/pairing-slot";
import type { SlotLabel, TournamentCard } from "@/domain/tournament/types";

/** Wire compatibility only. Operational tools, rules, tables and audit are not spectator state. */
export type PublicDivisionPayload = Pick<TournamentCard,
  "id" | "tournamentId" | "name" | "division" | "status" | "runtimeStage" | "currentGame" |
  "version" | "games" | "players" | "snapshots" | "finalType" | "finalGames" | "finalRound" |
  "gibsonEnabled" | "createdAt" | "codePrefix" | "initialPairingRule" | "slotLabel">;

export interface SpectatorParticipant {
  key: string;
  code: string;
  divisionId: string;
  name: string;
  school: string;
  listedInStandings: boolean;
}
export interface SpectatorContest {
  locator: string;
  divisionId: string;
  game: number;
  pairNumber: number;
  assignments: { side: 1 | 2; seat: number; participantKey: string | null }[];
  state: "void" | "withdrawn" | "awaiting-result" | "recorded" | "official";
  result: { type: "WIN" | "DRAW" | "PENALTY"; winnerKey: string | null;
    scores: [number, number] | null; calculatedDiff: number | null } | null;
}
export interface SpectatorDivision {
  id: string;
  tournamentId: string;
  name: string;
  division: string;
  version: number;
  participants: SpectatorParticipant[];
  contests: SpectatorContest[];
  /** The card's announced location cue. Older public payloads omit it and remain PAIR-compatible. */
  slotLabel: SlotLabel;
  publication: {
    phase: "registration" | "regular" | "finals" | "complete";
    currentGame: number;
    publishedGames: number[];
    officialGames: number[];
    officialThroughGame: number | null;
    pairingAvailable: boolean;
  };
  standings: ReturnType<typeof rankingAfterGame>;
  /** Bracket-aware order used by the completed Result report; empty when no final bracket exists. */
  finalStandings: ReturnType<typeof calculateFinalStandings>;
  finals: PublicDivisionPayload["finalRound"];
}

export function participantKey(divisionId: string, code: string): string {
  return `${divisionId}:${code}`;
}

/** No physical Table inference: existing public payloads do not identify a safe layout policy. */
export function publicDivisionPayload(source: PublicDivisionPayload): PublicDivisionPayload {
  const { id, tournamentId, name, division, status, runtimeStage, currentGame, version, games,
    players, snapshots, finalType, finalGames, finalRound, gibsonEnabled, createdAt, codePrefix, initialPairingRule,
    slotLabel } = source;
  return { id, tournamentId, name, division, status, runtimeStage, currentGame, version, games,
    players, snapshots, finalType, finalGames, finalRound, gibsonEnabled, createdAt, codePrefix, initialPairingRule,
    ...(slotLabel ? { slotLabel } : {}) };
}

/** Temporary adapter for the existing report renderer and unchanged domain calculation interface. */
export function legacyPublicCard(card: PublicDivisionPayload): TournamentCard {
  return { ...card, rules: [], tables: [], audit: [], screeningPool: [] };
}

export function spectatorDivision(card: PublicDivisionPayload): SpectatorDivision {
  const key = (code: string | null | undefined) => code ? participantKey(card.id, code) : null;
  type ContestCandidate = { contest: SpectatorContest; snapshotIndex: number; confirmed: boolean; pairingIndex: number };
  const byLocator = new Map<string, ContestCandidate>();
  card.snapshots.forEach((snapshot, snapshotIndex) => snapshot.pairings
    .filter(pairing => Boolean(snapshot.confirmedAt) || pairing.pairingPublished)
    .forEach((pairing, pairingIndex) => {
      const contest = (() => {
      const recorded = isRecordedPairing(pairing);
      return {
        locator: pairing.id || `${snapshot.id}:${pairing.gameNumber ?? snapshot.gameNumbers[0]}:${pairing.tableNumber}:${pairingIndex}`, divisionId: card.id,
        game: pairing.gameNumber ?? snapshot.gameNumbers[0], pairNumber: pairing.tableNumber,
        assignments: [
          { side: 1 as const, seat: pairing.tableNumber * 2 - 1, participantKey: key(pairing.playerOneId) },
          { side: 2 as const, seat: pairing.tableNumber * 2, participantKey: key(pairing.playerTwoId) },
        ],
        state: isVoidPairing(pairing) ? "void" as const : pairing.resultWithdrawn ? "withdrawn" as const
          : !recorded ? "awaiting-result" as const : snapshot.confirmedAt ? "official" as const : "recorded" as const,
        result: recorded && !pairing.resultWithdrawn && !isVoidPairing(pairing) ? {
          type: pairing.resultType!, winnerKey: key(pairing.winnerId),
          scores: pairing.resultType === "PENALTY" ? null : [pairing.scoreOne!, pairing.scoreTwo!] as [number, number],
          calculatedDiff: pairing.calculatedDiff ?? null,
        } : null,
      };
      })();
      const locator = contest.locator;
      const candidate = { contest, snapshotIndex, confirmed: Boolean(snapshot.confirmedAt), pairingIndex };
      const previous = byLocator.get(locator);
      // Repeated logical IDs can occur in compatibility/archive payloads. A confirmed snapshot is
      // authoritative; among equal publication states the later snapshot wins. Distinct IDs in one
      // game remain distinct contests, so legitimate rematches are never collapsed.
      if (!previous || (candidate.confirmed && !previous.confirmed)
        || (candidate.confirmed === previous.confirmed
          && (candidate.snapshotIndex > previous.snapshotIndex
            || (candidate.snapshotIndex === previous.snapshotIndex && candidate.pairingIndex >= previous.pairingIndex)))) {
        byLocator.set(locator, candidate);
      }
    }));
  // Map insertion order preserves the public snapshot/table order used by reports; replacing a
  // repeated locator updates its value without moving it or perturbing existing row order.
  const contests = [...byLocator.values()].map(candidate => candidate.contest);
  const publishedGames = [...new Set(contests.map(contest => contest.game))].sort((a, b) => a - b);
  const officialGames = [...new Set(card.snapshots.filter(snapshot => snapshot.confirmedAt)
    .flatMap(snapshot => snapshot.gameNumbers))].sort((a, b) => a - b);
  const officialThroughGame = officialGames.at(-1) ?? null;
  const currentGame = Math.max(card.currentGame, ...publishedGames);
  const complete = card.status === "FINISHED" || card.status === "CLOSED" || card.runtimeStage === "FINAL_PUBLISHED";
  const finalsVisible = complete || card.runtimeStage === "FINAL_COLLECTION";
  const publishedCard = { ...card, snapshots: card.snapshots.filter(snapshot => Boolean(snapshot.confirmedAt)) };
  const finalOrder = finalsVisible && card.finalType !== "NONE" && card.finalRound
    ? calculateFinalStandings(legacyPublicCard(publishedCard), Math.max(0, ...publishedGames)) : [];
  return {
    id: card.id, tournamentId: card.tournamentId, name: card.name, division: card.division, version: card.version,
    participants: card.players.map(player => ({ key: key(player.id)!, code: player.id, divisionId: card.id,
      name: `${player.firstName} ${player.lastName}`, school: player.school, listedInStandings: !player.terminated || (player.withdrawnFromGame ?? 0) > currentGame })),
    slotLabel: card.slotLabel ?? "PAIR",
    contests,
    publication: {
      phase: complete ? "complete" : finalsVisible ? "finals" : card.runtimeStage === "PLAYER_REGISTRATION" ? "registration" : "regular",
      currentGame, publishedGames, officialGames, officialThroughGame,
      pairingAvailable: publishedGames.includes(currentGame),
    },
    standings: officialThroughGame === null ? [] : rankingAfterGame(legacyPublicCard(card), officialThroughGame),
    finalStandings: finalOrder,
    finals: finalsVisible ? card.finalRound : null,
  };
}
