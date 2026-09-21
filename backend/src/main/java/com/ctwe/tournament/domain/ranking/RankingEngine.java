package com.ctwe.tournament.domain.ranking;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * The tournament ranking rule, in one place — the Java half.
 *
 * The dimensions are WinPoint → Diff → Head-to-head → Average Score. Head-to-head sits ABOVE
 * Average Score in priority but cannot be a normal comparator, because it is sparse: most pairs
 * have never played. So Average Score is used first to build a complete BASELINE ordering, and
 * head-to-head is then applied as a corrective pass inside each group already tied on WinPoint and
 * Diff. That is an implementation order, not a priority order — inside such a group an available
 * head-to-head result overrides Average Score however far apart the two averages are, and Average
 * Score decides a pair only when head-to-head has nothing to say about it.
 *
 * <p>Concretely: a player ends below every member of their group who beat them, every pair
 * head-to-head cannot resolve keeps the order the baseline gave it, and a member with no
 * head-to-head evidence never moves relative to the others — it is carried along when someone above
 * it falls. Equal Average Scores do not exempt a group: two players level on every figure are still
 * separated when one of them beat the other.
 *
 * <p>Two outputs, deliberately separate. {@code displayRank} is what a person reads and is SHARED by
 * players the rules could not separate (1, 2, 2, 4). {@code order} is a total order for pairing and
 * finals seeding; it is never rendered, and below Average Score it falls back to the player code
 * purely so the machine has something deterministic — no sporting rule is invented for it.
 *
 * <p>This must agree with {@code src/domain/tournament/ranking.ts} exactly. Both are executed
 * against {@code docs/ranking-vectors.json}, so a divergence fails a test rather than reaching a
 * tournament.
 */
public final class RankingEngine {
    private RankingEngine() {}

    /**
     * @param scoreFor points scored across qualifying games — a bye counts, a penalty does not
     * @param games    qualifying games played, on the same rule
     */
    public record RankRow(String playerId, int winPoints, int diff, long scoreFor, int games) {}

    public record Ranked(String playerId, int winPoints, int diff, long scoreFor, int games,
                         double average, int displayRank, int order) {}

    /** Average Score. Guarded rather than dividing, so a player with no games is 0 and not NaN. */
    public static double averageScore(long scoreFor, int games) {
        return games > 0 ? (double) scoreFor / games : 0d;
    }

    public static List<Ranked> rank(List<RankRow> rows) {
        return rank(rows, H2HProvider.NONE);
    }

    public static List<Ranked> rank(List<RankRow> rows, H2HProvider headToHead) {
        H2HProvider h2h = headToHead == null ? H2HProvider.NONE : headToHead;
        List<Entry> ordered = new ArrayList<>(rows.size());
        for (RankRow row : rows) ordered.add(new Entry(row, averageScore(row.scoreFor(), row.games())));
        ordered.sort(Comparator
            .comparingInt((Entry entry) -> entry.row.winPoints()).reversed()
            .thenComparing(Comparator.comparingInt((Entry entry) -> entry.row.diff()).reversed())
            .thenComparing(Comparator.comparingDouble((Entry entry) -> entry.average).reversed())
            .thenComparing(entry -> entry.row.playerId(), PlayerCodes::compare));

        // separated[i]: a head-to-head result, not the baseline, is what holds entry i below i-1.
        // Such a pair is not tied however identical their figures look, so they cannot share a rank.
        boolean[] separated = new boolean[ordered.size()];
        int start = 0;
        while (start < ordered.size()) {
            int end = start;
            while (end < ordered.size()
                && ordered.get(end).row.winPoints() == ordered.get(start).row.winPoints()
                && ordered.get(end).row.diff() == ordered.get(start).row.diff()) end++;
            correctWithinTieGroup(ordered, start, end, h2h, separated);
            start = end;
        }

        List<Ranked> result = new ArrayList<>(ordered.size());
        int displayRank = 1;
        for (int index = 0; index < ordered.size(); index++) {
            Entry entry = ordered.get(index);
            if (index > 0 && (separated[index] || !tied(ordered.get(index - 1), entry))) displayRank = index + 1;
            result.add(new Ranked(entry.row.playerId(), entry.row.winPoints(), entry.row.diff(),
                entry.row.scoreFor(), entry.row.games(), entry.average, displayRank, index));
        }
        return List.copyOf(result);
    }

    /**
     * The corrective pass over one (WinPoint, Diff) group.
     *
     * <p>Every group of two or more qualifies. Average Score equality is NOT an exemption: head-to-
     * head outranks Average Score, so two players level on every figure must still be separated when
     * one of them beat the other.
     *
     * <p>Head-to-head results are read as constraints — winner above loser — and the group is
     * re-emitted so that every constraint holds while everything else keeps the baseline order. At
     * each step the highest baseline member whose head-to-head superiors have all been placed goes
     * next. That is what makes an unresolved pair keep its baseline order, and what lets a win count
     * even when the loser is several places above rather than immediately above.
     *
     * <p>Head-to-head can contradict itself (A beat B, B beat C, C beat A), and no ordering can
     * satisfy a cycle. When nobody is free, the highest remaining baseline member is placed and the
     * constraints pointing at them are abandoned: a cycle decides nothing, so the baseline does.
     *
     * <p>Work stays proportional to the group. {@code hasMet} answers the overwhelmingly common
     * "never played" from a prepared set, so only pairs that genuinely met are ever aggregated, and
     * only within this one group.
     */
    private static void correctWithinTieGroup(List<Entry> ordered, int start, int end, H2HProvider h2h,
                                              boolean[] separated) {
        int size = end - start;
        if (size < 2) return;

        List<Entry> members = new ArrayList<>(ordered.subList(start, end));
        boolean[][] beats = new boolean[size][size];
        int[] mustFollow = new int[size];
        for (int above = 0; above < size; above++)
            for (int below = above + 1; below < size; below++) {
                String one = members.get(above).row.playerId();
                String two = members.get(below).row.playerId();
                if (!h2h.hasMet(one, two)) continue;
                H2HProvider.Verdict verdict = h2h.verdict(one, two);
                if (verdict == H2HProvider.Verdict.BETTER) { beats[above][below] = true; mustFollow[below]++; }
                else if (verdict == H2HProvider.Verdict.WORSE) { beats[below][above] = true; mustFollow[above]++; }
            }

        boolean[] placed = new boolean[size];
        int[] placedOrder = new int[size];
        for (int step = 0; step < size; step++) {
            int next = -1;
            for (int index = 0; index < size && next < 0; index++)
                if (!placed[index] && mustFollow[index] == 0) next = index;
            if (next < 0)                                   // a cycle: fall back to the baseline
                for (int index = 0; index < size && next < 0; index++) if (!placed[index]) next = index;
            placed[next] = true;
            placedOrder[step] = next;
            for (int loser = 0; loser < size; loser++)
                if (!placed[loser] && beats[next][loser]) mustFollow[loser]--;
        }

        for (int step = 0; step < size; step++) ordered.set(start + step, members.get(placedOrder[step]));
        for (int step = 1; step < size; step++) {
            int above = placedOrder[step - 1], below = placedOrder[step];
            separated[start + step] = beats[above][below] || beats[below][above];
        }
    }

    /**
     * Tied on every figure the rules compare. Sharing a displayed rank also requires that no
     * head-to-head result separated the pair, which the caller checks.
     */
    private static boolean tied(Entry a, Entry b) {
        return a.row.winPoints() == b.row.winPoints()
            && a.row.diff() == b.row.diff()
            && Double.compare(a.average, b.average) == 0;
    }

    private static final class Entry {
        private final RankRow row;
        private final double average;
        private Entry(RankRow row, double average) { this.row = row; this.average = average; }
    }
}
