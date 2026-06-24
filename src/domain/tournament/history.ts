import type { Pairing, PairingSnapshot, Player, TournamentCard } from "./types";

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

function hasTwoPlayers(pairing: Pairing): pairing is Pairing & { playerOneId: string; playerTwoId: string } {
  return Boolean(pairing.playerOneId && pairing.playerTwoId);
}
type CompletePairing = Pairing & { playerOneId: string; playerTwoId: string };

/** Per-game play history for one player across all published results, with running totals. */
export function playerHistory(card: TournamentCard, playerId: string): PlayerHistoryRow[] {
  const entries: { game: number; pairing: CompletePairing }[] = [];
  card.snapshots.filter((snapshot) => Boolean(snapshot.confirmedAt)).forEach((snapshot) => {
    snapshot.pairings.forEach((pairing) => {
      const recorded = hasTwoPlayers(pairing) && pairing.scoreOne !== undefined && pairing.scoreTwo !== undefined && Boolean(pairing.resultType);
      if (!recorded || (pairing.playerOneId !== playerId && pairing.playerTwoId !== playerId)) return;
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
    const diff = ownScore - opponentScore;
    cumulativeDiff += diff;
    return { game, table: pairing.tableNumber, result, cumulativeWinPoints, ownScore, opponentScore, diff, cumulativeDiff, opponentId: isOne ? pairing.playerTwoId : pairing.playerOneId };
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
    if (!hasTwoPlayers(pairing) || (pairing.gameNumber ?? snapshot.gameNumbers[0]) > gameNumber || pairing.scoreOne === undefined || pairing.scoreTwo === undefined) return;
    const one = ranking.get(pairing.playerOneId); const two = ranking.get(pairing.playerTwoId);
    if (!one || !two) return;
    if (pairing.resultType === "DRAW") {
      one.draws += 1; two.draws += 1; one.winPoints += 1; two.winPoints += 1;
      return;
    }
    const winner = pairing.winnerId === one.id ? one : two;
    const loser = winner === one ? two : one;
    const diff = pairing.calculatedDiff ?? Math.abs(pairing.scoreOne - pairing.scoreTwo);
    winner.wins += 1; winner.winPoints += 2; winner.diff += diff;
    loser.losses += 1; loser.diff -= diff;
  }));

  return [...ranking.values()].sort((a, b) => b.winPoints - a.winPoints || b.diff - a.diff || a.id.localeCompare(b.id));
}
