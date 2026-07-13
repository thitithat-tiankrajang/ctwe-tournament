import type { Pairing, PairingSnapshot, Player, TournamentCard } from "./types";
import { comparePlayerCodes } from "./player-code";

export function snapshotForGame(snapshots: PairingSnapshot[], gameNumber: number) {
  return snapshots.find((snapshot) => snapshot.gameNumbers.includes(gameNumber));
}

export interface PlayerHistoryRow {
  game: number;
  table: number;
  result: "W" | "T" | "L";
  cumulativeWinPoints: number;
  ownScore: number;
  opponentScore: number;
  diff: number;
  cumulativeDiff: number;
  opponentId: string;
}

function hasPlayer(pairing: Pairing, playerId: string): boolean {
  return pairing.playerOneId === playerId || pairing.playerTwoId === playerId;
}

/** Per-game play history for one player across all published results, with running totals. */
export function playerHistory(card: TournamentCard, playerId: string): PlayerHistoryRow[] {
  const entries: { game: number; pairing: Pairing }[] = [];
  card.snapshots.filter((snapshot) => Boolean(snapshot.confirmedAt)).forEach((snapshot) => {
    snapshot.pairings.forEach((pairing) => {
      const recorded = pairing.scoreOne !== undefined && pairing.scoreTwo !== undefined && Boolean(pairing.resultType);
      if (!recorded || !hasPlayer(pairing, playerId)) return;
      entries.push({ game: pairing.gameNumber ?? Math.min(...snapshot.gameNumbers), pairing });
    });
  });
  entries.sort((a, b) => a.game - b.game);

  let cumulativeWinPoints = 0; let cumulativeDiff = 0;
  return entries.map(({ game, pairing }) => {
    const isOne = pairing.playerOneId === playerId;
    const ownScore = (isOne ? pairing.scoreOne : pairing.scoreTwo) ?? 0;
    const opponentScore = (isOne ? pairing.scoreTwo : pairing.scoreOne) ?? 0;
    const result: "W" | "T" | "L" = pairing.resultType === "DRAW" ? "T" : pairing.winnerId === playerId ? "W" : "L";
    cumulativeWinPoints += result === "W" ? 2 : result === "T" ? 1 : 0;
    const diff = pairing.resultType === "PENALTY"
      ? -(pairing.calculatedDiff ?? 0)
      : ownScore - opponentScore;
    cumulativeDiff += diff;
    return { game, table: pairing.tableNumber, result, cumulativeWinPoints, ownScore, opponentScore, diff, cumulativeDiff, opponentId: (isOne ? pairing.playerTwoId : pairing.playerOneId) ?? "" };
  });
}

export function rankingAfterGame(card: TournamentCard, gameNumber: number): Player[] {
  const ranking = new Map(card.players.map((player) => [player.id, {
    ...player,
    wins: 0,
    draws: 0,
    losses: 0,
    winPoints: 0,
    diff: 0,
  }]));
  const snapshots = card.snapshots
    .filter((snapshot) => Boolean(snapshot.confirmedAt) && snapshot.gameNumbers.some((game) => game <= gameNumber))
    .sort((a, b) => Math.min(...a.gameNumbers) - Math.min(...b.gameNumbers));

  snapshots.forEach((snapshot) => snapshot.pairings.forEach((pairing) => {
    if ((!pairing.playerOneId && !pairing.playerTwoId) || (pairing.gameNumber ?? snapshot.gameNumbers[0]) > gameNumber || pairing.scoreOne === undefined || pairing.scoreTwo === undefined) return;
    const one = pairing.playerOneId ? ranking.get(pairing.playerOneId) : undefined;
    const two = pairing.playerTwoId ? ranking.get(pairing.playerTwoId) : undefined;
    if (pairing.resultType === "DRAW") {
      if (!one || !two) return;
      one.draws += 1; two.draws += 1; one.winPoints += 1; two.winPoints += 1;
      return;
    }
    if (pairing.resultType === "PENALTY") {
      const diff = pairing.calculatedDiff ?? 0;
      for (const penalised of [one, two]) {
        if (!penalised) continue;
        penalised.losses += 1;
        penalised.diff -= diff;
      }
      return;
    }
    const winner = pairing.winnerId === one?.id ? one : pairing.winnerId === two?.id ? two : undefined;
    if (!winner) return;
    const loser = winner === one ? two : one;
    const diff = pairing.calculatedDiff ?? Math.abs(pairing.scoreOne - pairing.scoreTwo);
    winner.wins += 1; winner.winPoints += 2; winner.diff += diff;
    if (loser) { loser.losses += 1; loser.diff -= diff; }
  }));

  return [...ranking.values()].sort((a, b) => b.winPoints - a.winPoints || b.diff - a.diff || comparePlayerCodes(a.id, b.id));
}
