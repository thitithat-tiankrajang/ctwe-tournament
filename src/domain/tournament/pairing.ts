import type { Pairing, PairingRuleType, Player } from "./types";

export interface PairingStrategy {
  readonly type: PairingRuleType;
  generate(players: Player[], gameNumber: number): Pairing[];
}

const ranked = (players: Player[]) =>
  [...players].sort((a, b) => b.winPoints - a.winPoints || b.diff - a.diff || a.id.localeCompare(b.id));

const pairSequentially = (players: Player[], gameNumber: number): Pairing[] => {
  const result: Pairing[] = [];
  for (let index = 0; index + 1 < players.length; index += 2) {
    result.push({
      id: `g${gameNumber}-m${index / 2 + 1}`,
      tableNumber: index / 2 + 1,
      playerOneId: players[index].id,
      playerTwoId: players[index + 1].id,
    });
  }
  return result;
};

export const pairingStrategies: Record<PairingRuleType, PairingStrategy> = {
  KING_OF_THE_HILL: {
    type: "KING_OF_THE_HILL",
    generate: (players, gameNumber) => pairSequentially(ranked(players), gameNumber),
  },
  SWISS: {
    type: "SWISS",
    generate(players, gameNumber) {
      const groups = [...ranked(players).reduce((result, player) => {
        const group = result.get(player.winPoints) ?? [];
        group.push(player);
        result.set(player.winPoints, group);
        return result;
      }, new Map<number, Player[]>()).entries()].sort(([a], [b]) => b - a).map(([, group]) => group);
      const pairings: Pairing[] = [];
      groups.forEach((group, groupIndex) => {
        if (group.length === 0) return;
        if (group.length % 2 !== 0) {
          const lower = groups.slice(groupIndex + 1).find((candidate) => candidate.length > 0);
          if (!lower) throw new Error("Swiss pairing requires an even number of players");
          group.push(lower.shift()!);
        }
        const half = group.length / 2;
        for (let index = 0; index < half; index++) {
          pairings.push({ id: `g${gameNumber}-m${pairings.length + 1}`, tableNumber: pairings.length + 1, playerOneId: group[index].id, playerTwoId: group[index + half].id });
        }
      });
      return pairings;
    },
  },
  PAIR_RESULT: {
    type: "PAIR_RESULT",
    generate() {
      throw new Error("PAIR_RESULT ต้องสร้างจากผลสองคู่ในเกมต้นทาง ไม่สามารถสร้างจาก Ranking ได้");
    },
  },
};
