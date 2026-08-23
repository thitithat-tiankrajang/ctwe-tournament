package com.ctwe.tournament.domain.ranking;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * The tournament ranking rule, in one place — the Java half.
 *
 * Order is WinPoint → Diff → Average Score. Head-to-head is NOT a fourth comparator: it runs
 * afterwards as a corrective pass, and only inside a group already tied on both WinPoint and Diff.
 * Within such a group a player may rise past the player immediately above them — one position at a
 * time — if and only if they have definitively beaten them. The walk stops at the first player they
 * did not beat, which is what stops a win over someone lower being used to leapfrog someone higher.
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

        int start = 0;
        while (start < ordered.size()) {
            int end = start;
            while (end < ordered.size()
                && ordered.get(end).row.winPoints() == ordered.get(start).row.winPoints()
                && ordered.get(end).row.diff() == ordered.get(start).row.diff()) end++;
            promoteWithinTieGroup(ordered, start, end, h2h);
            start = end;
        }

        List<Ranked> result = new ArrayList<>(ordered.size());
        int displayRank = 1;
        for (int index = 0; index < ordered.size(); index++) {
            Entry entry = ordered.get(index);
            if (index > 0 && !tied(ordered.get(index - 1), entry)) displayRank = index + 1;
            result.add(new Ranked(entry.row.playerId(), entry.row.winPoints(), entry.row.diff(),
                entry.row.scoreFor(), entry.row.games(), entry.average, displayRank, index));
        }
        return List.copyOf(result);
    }

    /**
     * The corrective pass over one (WinPoint, Diff) group.
     *
     * <p>Skipped outright unless the group has at least two members AND at least two distinct
     * Average Scores — with one shared average no member can have a strictly higher one, so no
     * candidate can exist and no aggregation is possible. Inside a walked group only the adjacent
     * pair is ever consulted, and {@code hasMet} resolves the common case without aggregating.
     */
    private static void promoteWithinTieGroup(List<Entry> ordered, int start, int end, H2HProvider h2h) {
        int size = end - start;
        if (size < 2) return;
        Set<Double> averages = new HashSet<>();
        for (int index = start; index < end; index++) averages.add(ordered.get(index).average);
        if (averages.size() < 2) return;

        for (int index = 1; index < size; index++) {
            int position = start + index;
            while (position > start) {
                Entry above = ordered.get(position - 1);
                Entry me = ordered.get(position);
                // A candidate must be ABOVE and strictly better on Average Score; anything else is
                // not something this player could overtake, so no H2H is computed for it.
                if (above.average <= me.average) break;
                if (!h2h.hasMet(me.row.playerId(), above.row.playerId())) break;
                if (h2h.verdict(me.row.playerId(), above.row.playerId()) != H2HProvider.Verdict.BETTER) break;
                ordered.set(position - 1, me);
                ordered.set(position, above);
                position--;
            }
        }
    }

    /** Tied on every criterion the rules apply — i.e. these two share a displayed rank. */
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
