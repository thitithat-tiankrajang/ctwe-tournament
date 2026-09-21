/**
 * The tournament ranking rule, in one place.
 *
 * The dimensions are WinPoint → Diff → Head-to-head → Average Score. Head-to-head sits ABOVE
 * Average Score in priority but cannot be a normal comparator, because it is sparse: most pairs
 * have never played. So Average Score is used first to build a complete BASELINE ordering, and
 * head-to-head is then applied as a corrective pass inside each group already tied on WinPoint and
 * Diff. That is an implementation order, not a priority order — inside such a group an available
 * head-to-head result overrides Average Score however far apart the two averages are, and Average
 * Score decides a pair only when head-to-head has nothing to say about it.
 *
 * Concretely: a player ends below every member of their group who beat them, every pair head-to-head
 * cannot resolve keeps the order the baseline gave it, and a member with no head-to-head evidence
 * never moves relative to the others — it is carried along when someone above it falls. Equal
 * Average Scores do not exempt a group: two players level on every figure are still separated when
 * one of them beat the other.
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

/**
 * True when the two rows are tied on every figure the rules compare. Sharing a displayed rank also
 * requires that no head-to-head result separated the pair, which the caller checks.
 */
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
 * H2H work stays proportional to the group. Every (WinPoint, Diff) group of two or more is
 * inspected — equal Average Scores are not an exemption, because H2H outranks Average Score — and
 * `hasMet` resolves the overwhelmingly common "never played" case in O(1), so only pairs that
 * genuinely met are ever aggregated, and only within that one group.
 */
export function rank(rows: readonly RankInput[], h2h: H2HProvider = NO_HEAD_TO_HEAD): Ranked[] {
  const ordered: Ranked[] = rows
    .map((row) => ({ ...row, average: averageScore(row.scoreFor, row.games), displayRank: 0, order: 0 }))
    .sort((a, b) =>
      b.winPoints - a.winPoints
      || b.diff - a.diff
      || b.average - a.average
      || comparePlayerCodes(a.playerId, b.playerId));

  // separated[i]: a head-to-head result, not the baseline, is what holds entry i below i-1. Such a
  // pair is not tied however identical their figures look, so they cannot share a rank.
  const separated = new Array<boolean>(ordered.length).fill(false);
  let start = 0;
  while (start < ordered.length) {
    let end = start;
    while (end < ordered.length
      && ordered[end].winPoints === ordered[start].winPoints
      && ordered[end].diff === ordered[start].diff) end += 1;

    const group = ordered.slice(start, end);
    if (group.length >= 2) {
      const size = group.length;
      // Head-to-head results read as constraints: winner above loser. Everything else is silence,
      // and silence means "keep the baseline order".
      const beats: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
      const mustFollow = new Array<number>(size).fill(0);
      for (let above = 0; above < size; above += 1) {
        for (let below = above + 1; below < size; below += 1) {
          if (!h2h.hasMet(group[above].playerId, group[below].playerId)) continue;
          const verdict = h2h.verdict(group[above].playerId, group[below].playerId);
          if (verdict === 1) { beats[above][below] = true; mustFollow[below] += 1; }
          else if (verdict === -1) { beats[below][above] = true; mustFollow[above] += 1; }
        }
      }

      // At each step take the highest baseline member whose H2H superiors are all already placed.
      // That is what lets a win count even when the loser sits several places above rather than
      // immediately above, while an unresolved pair simply keeps the order it arrived with.
      // A cycle (A beat B, B beat C, C beat A) can satisfy nobody: then the highest remaining
      // baseline member is placed and the constraints pointing at them are abandoned.
      const placed = new Array<boolean>(size).fill(false);
      const placedOrder = new Array<number>(size).fill(0);
      for (let step = 0; step < size; step += 1) {
        let next = -1;
        for (let index = 0; index < size && next < 0; index += 1) {
          if (!placed[index] && mustFollow[index] === 0) next = index;
        }
        if (next < 0) {
          for (let index = 0; index < size && next < 0; index += 1) if (!placed[index]) next = index;
        }
        placed[next] = true;
        placedOrder[step] = next;
        for (let loser = 0; loser < size; loser += 1) {
          if (!placed[loser] && beats[next][loser]) mustFollow[loser] -= 1;
        }
      }

      for (let step = 0; step < size; step += 1) ordered[start + step] = group[placedOrder[step]];
      for (let step = 1; step < size; step += 1) {
        const above = placedOrder[step - 1];
        const below = placedOrder[step];
        separated[start + step] = beats[above][below] || beats[below][above];
      }
    }
    start = end;
  }

  // Competition ranking over the FINAL order: an adjacent run the rules could not separate shares a
  // number, and the next distinct player takes its positional index. 1, 2, 2, 4.
  let displayRank = 1;
  ordered.forEach((entry, index) => {
    if (index > 0 && (separated[index] || !fullyTied(ordered[index - 1], entry))) displayRank = index + 1;
    entry.displayRank = displayRank;
    entry.order = index;
  });
  return ordered;
}
