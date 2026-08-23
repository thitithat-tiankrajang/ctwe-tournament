/**
 * The tournament ranking rule, in one place.
 *
 * Order is WinPoint → Diff → Average Score. Head-to-head is NOT a fourth comparator: it runs
 * afterwards as a corrective pass, and only inside a group already tied on both WinPoint and Diff.
 * Within such a group a player may rise past the player immediately above them — one position at a
 * time — if and only if they have definitively beaten them. The walk stops at the first player they
 * did not beat, which is what stops a win over someone lower being used to leapfrog someone higher.
 *
 * Two outputs, deliberately separate:
 *
 *   `displayRank`  what a person reads. Genuinely tied players SHARE a number (1, 2, 2, 4).
 *   `order`        a total order for pairing and finals seeding. Never rendered. No sporting rule
 *                  is invented for it — below Average Score it falls back to the player code purely
 *                  so the machine has something deterministic to consume.
 */

import { comparePlayerCodes } from "./player-code";

/** BETTER (1) / TIED (0) / WORSE (-1) — the aggregate of every qualifying meeting between two players. */
export type H2HVerdict = 1 | 0 | -1;

export interface H2HProvider {
  /**
   * Have these two ever met in a qualifying game? Answered from a prepared set, so the engine can
   * skip the aggregation entirely for the overwhelmingly common "never played" case.
   */
  hasMet(playerId: string, opponentId: string): boolean;
  /** Aggregate of ALL their meetings: wins → diff → points scored → tied. */
  verdict(playerId: string, opponentId: string): H2HVerdict;
}

export interface RankInput {
  playerId: string;
  winPoints: number;
  /** Cumulative capped margin, signed. */
  diff: number;
  /** Total points scored across qualifying games. A bye counts; a penalty does not. */
  scoreFor: number;
  /** Qualifying games played. A bye counts; a penalty is not a game. */
  games: number;
}

export interface Ranked extends RankInput {
  /** `scoreFor / games`, or 0 when no games have been played. */
  average: number;
  /** Shared by players the rules could not separate. */
  displayRank: number;
  /** Position in the total order, 0-based. Consumed by pairing and seeding, never shown. */
  order: number;
}

/** Average Score. Guarded rather than dividing, so a player with no games is 0 and not NaN. */
export function averageScore(scoreFor: number, games: number): number {
  return games > 0 ? scoreFor / games : 0;
}

/** True when the two rows are tied on every criterion the rules apply — i.e. they share a rank. */
function fullyTied(a: Ranked, b: Ranked): boolean {
  return a.winPoints === b.winPoints && a.diff === b.diff && a.average === b.average;
}

/**
 * A no-op provider. Used where no match history is available (a pre-tournament list), and as the
 * default so callers cannot accidentally get H2H they did not supply.
 */
export const NO_HEAD_TO_HEAD: H2HProvider = {
  hasMet: () => false,
  verdict: () => 0,
};

/**
 * Rank `rows` under the tournament rule.
 *
 * H2H work is demand-driven. A tie group is skipped outright unless it has at least two members AND
 * at least two distinct Average Scores — with one shared average no member can have a strictly
 * higher one, so no candidate can exist and no aggregation is possible. Inside a walked group only
 * the adjacent pair is ever consulted, and `hasMet` resolves the common case in O(1).
 */
export function rank(rows: readonly RankInput[], h2h: H2HProvider = NO_HEAD_TO_HEAD): Ranked[] {
  const ordered: Ranked[] = rows
    .map((row) => ({ ...row, average: averageScore(row.scoreFor, row.games), displayRank: 0, order: 0 }))
    .sort((a, b) =>
      b.winPoints - a.winPoints
      || b.diff - a.diff
      || b.average - a.average
      || comparePlayerCodes(a.playerId, b.playerId));

  let start = 0;
  while (start < ordered.length) {
    let end = start;
    while (end < ordered.length
      && ordered[end].winPoints === ordered[start].winPoints
      && ordered[end].diff === ordered[start].diff) end += 1;

    const group = ordered.slice(start, end);
    const distinctAverages = new Set(group.map((entry) => entry.average)).size;
    if (group.length >= 2 && distinctAverages >= 2) {
      for (let index = 1; index < group.length; index += 1) {
        let position = index;
        while (position > 0) {
          const above = group[position - 1];
          const me = group[position];
          // A candidate must be ABOVE and strictly better on Average Score; anything else is not
          // something this player could overtake, so no H2H is computed for it.
          if (above.average <= me.average) break;
          if (!h2h.hasMet(me.playerId, above.playerId)) break;
          if (h2h.verdict(me.playerId, above.playerId) !== 1) break;
          group[position - 1] = me;
          group[position] = above;
          position -= 1;
        }
      }
      for (let index = start; index < end; index += 1) ordered[index] = group[index - start];
    }
    start = end;
  }

  // Competition ranking over the FINAL order: an adjacent run the rules could not separate shares a
  // number, and the next distinct player takes its positional index. 1, 2, 2, 4.
  let displayRank = 1;
  ordered.forEach((entry, index) => {
    if (index > 0 && !fullyTied(ordered[index - 1], entry)) displayRank = index + 1;
    entry.displayRank = displayRank;
    entry.order = index;
  });
  return ordered;
}
