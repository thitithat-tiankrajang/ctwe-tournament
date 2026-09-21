import { rank } from "./ranking";
import type { Player } from "./types";
import type { RankedPlayer } from "./history";

export const rankPlayers = (players: Player[]): RankedPlayer[] => {
  const byId = new Map(players.map((player) => [player.id, player]));
  return rank(players.map((player) => ({
    playerId: player.id, winPoints: player.winPoints, diff: player.diff, scoreFor: 0, games: 0,
  }))).map((entry) => ({
    ...byId.get(entry.playerId)!, scoreFor: 0, games: 0, average: entry.average, displayRank: entry.displayRank,
  }));
};
