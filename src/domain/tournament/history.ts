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
  /** True for a championship-round game; `gameLabel` then carries a display name like "ชิง 1". */
  final?: boolean;
  gameLabel?: string;
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
  const rows: PlayerHistoryRow[] = entries.map(({ game, pairing }) => {
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

  // A finalist's championship games are appended after their regular history so the master card
  // reads as one continuous record. Non-finalists (and cards without a final) get nothing extra.
  const slot = card.finalRound?.slots.find((entry) => entry.playerOneId === playerId || entry.playerTwoId === playerId);
  const lastGame = rows.length > 0 ? rows[rows.length - 1].game : 0;
  slot?.games.forEach((finalGame) => {
    if (finalGame.scoreOne == null || finalGame.scoreTwo == null) return;
    const isOne = slot.playerOneId === playerId;
    const ownScore = isOne ? finalGame.scoreOne : finalGame.scoreTwo;
    const opponentScore = isOne ? finalGame.scoreTwo : finalGame.scoreOne;
    const result: "W" | "T" | "L" = finalGame.winnerId == null ? "T" : finalGame.winnerId === playerId ? "W" : "L";
    cumulativeWinPoints += result === "W" ? 2 : result === "T" ? 1 : 0;
    const diff = ownScore - opponentScore;
    cumulativeDiff += diff;
    rows.push({
      game: lastGame + finalGame.gameIndex, gameLabel: `ชิง ${finalGame.gameIndex}`, final: true,
      table: 0, result, cumulativeWinPoints, ownScore, opponentScore, diff, cumulativeDiff,
      opponentId: (isOne ? slot.playerTwoId : slot.playerOneId) ?? "",
    });
  });
  return rows;
}

/**
 * Final placings for the "ผลการแข่งขัน" view: the championship bracket decides the top seats
 * (slot 0 winner = 1st / loser = 2nd, slot 1 winner = 3rd / loser = 4th) and everyone else follows
 * the regular standings. A card without a final round simply returns its final regular standings.
 */
export function finalStandings(card: TournamentCard, lastGame: number): Player[] {
  const base = lastGame > 0 ? rankingAfterGame(card, lastGame) : [];
  const round = card.finalRound;
  if (!round || card.finalType === "NONE") return base;
  const byId = new Map(card.players.map((player) => [player.id, player]));
  const ordered: Player[] = [];
  const placed = new Set<string>();
  const place = (id: string | null | undefined) => {
    if (id && byId.has(id) && !placed.has(id)) { ordered.push(byId.get(id)!); placed.add(id); }
  };
  [...round.slots].sort((a, b) => a.slot - b.slot).forEach((slot) => {
    if (!slot.winnerId) return; // unresolved bracket: fall back to standings order for these players
    place(slot.winnerId);
    place(slot.winnerId === slot.playerOneId ? slot.playerTwoId : slot.playerOneId);
  });
  base.forEach((player) => place(player.id));
  return ordered;
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

  // Terminated players are scored (so their past opponents' wins/losses stay correct) but never
  // shown in the standings — once withdrawn they live only in the director's restore "trash".
  return [...ranking.values()]
    .filter((player) => !player.terminated)
    .sort((a, b) => b.winPoints - a.winPoints || b.diff - a.diff || comparePlayerCodes(a.id, b.id));
}
