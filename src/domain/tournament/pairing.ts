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
  if (players.length % 2 !== 0) {
    result.push({
      id: `g${gameNumber}-m${result.length + 1}`,
      tableNumber: result.length + 1,
      playerOneId: players[players.length - 1].id,
      playerTwoId: null,
    });
  }
  return result;
};

const shuffled = <T,>(values: T[]) => {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const target = Math.floor(Math.random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
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
          if (!lower) {
            pairings.push({
              id: `g${gameNumber}-m${pairings.length + 1}`,
              tableNumber: pairings.length + 1,
              playerOneId: group.pop()!.id,
              playerTwoId: null,
            });
            return;
          }
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
  RANDOM: {
    type: "RANDOM",
    generate: (players, gameNumber) => pairSequentially(shuffled(players), gameNumber),
  },
  PAIR_RESULT: {
    type: "PAIR_RESULT",
    generate() {
      throw new Error("PAIR_RESULT ต้องสร้างจากผลสองคู่ในเกมต้นทาง ไม่สามารถสร้างจาก Ranking ได้");
    },
  },
};
