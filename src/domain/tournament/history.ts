import type { PairingSnapshot, Player, TournamentCard } from "./types";

export function snapshotForGame(snapshots: PairingSnapshot[], gameNumber: number) {
  return snapshots.find((snapshot) => snapshot.gameNumbers.includes(gameNumber));
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
    if ((pairing.gameNumber ?? snapshot.gameNumbers[0]) > gameNumber || pairing.scoreOne === undefined || pairing.scoreTwo === undefined) return;
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
