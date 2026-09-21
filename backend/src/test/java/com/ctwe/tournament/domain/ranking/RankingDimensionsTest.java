package com.ctwe.tournament.domain.ranking;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The four ranking dimensions, one deterministic fixture each, with the figures written out.
 *
 * <p>These are release-validation fixtures: each one isolates a single dimension by making every
 * dimension above it identical and every dimension below it point the OTHER way, so the assertion
 * can only pass if that dimension is the one doing the work. The last two tests record two places
 * where the shipped rule is narrower than "win points, differential, head-to-head, points scored"
 * would suggest; they are written as observations, not as fixes.
 */
class RankingDimensionsTest {

    private static RankingEngine.RankRow row(String id, int winPoints, int diff, long scoreFor, int games) {
        return new RankingEngine.RankRow(id, winPoints, diff, scoreFor, games);
    }

    private static List<String> order(List<RankingEngine.Ranked> ranked) {
        return ranked.stream().map(RankingEngine.Ranked::playerId).toList();
    }

    /** A provider where every named winner has definitively beaten {@code loser}, and nobody else has met. */
    private static H2HProvider beatenBy(String loser, String... winners) {
        Set<String> beat = Set.of(winners);
        return new H2HProvider() {
            public boolean hasMet(String playerId, String opponentId) {
                return (playerId.equals(loser) && beat.contains(opponentId))
                    || (opponentId.equals(loser) && beat.contains(playerId));
            }
            public Verdict verdict(String playerId, String opponentId) {
                if (!hasMet(playerId, opponentId)) return Verdict.TIED;
                return playerId.equals(loser) ? Verdict.WORSE : Verdict.BETTER;
            }
        };
    }

    /** A provider where exactly one directed pair is a definitive win. */
    private static H2HProvider beat(String winner, String loser) {
        Set<String> pair = Set.of(winner, loser);
        return new H2HProvider() {
            public boolean hasMet(String playerId, String opponentId) {
                return pair.equals(Set.of(playerId, opponentId));
            }
            public Verdict verdict(String playerId, String opponentId) {
                if (!hasMet(playerId, opponentId)) return Verdict.TIED;
                return playerId.equals(winner) ? Verdict.BETTER : Verdict.WORSE;
            }
        };
    }

    /**
     * The owner's worked example of Average Score, as arithmetic: five counted games scoring
     * 45, 2, 64, 0 and -3 average to 108 / 5 = 21.6. A zero is a score, not an absence, and a
     * legal negative carries its sign into the sum.
     */
    @Test
    void averageScoreIsTheMeanOfEverySubmittedScore() {
        long scoreFor = 45 + 2 + 64 + 0 + -3;
        assertThat(scoreFor).isEqualTo(108L);
        assertThat(RankingEngine.averageScore(scoreFor, 5)).isEqualTo(21.6);
        assertThat(RankingEngine.averageScore(0, 0)).as("no games is 0, never NaN").isZero();
    }

    // ---- Dimension 1: win points, above everything ----
    @Test
    void winPointsOutrankBothDifferentialAndScore() {
        var ranked = RankingEngine.rank(List.of(
            row("1001", 6, -50, 900, 3),    // average 300.0
            row("1002", 4, 300, 1500, 3))); // average 500.0 and a far better differential
        assertThat(order(ranked)).containsExactly("1001", "1002");
        assertThat(ranked.get(0).diff()).isEqualTo(-50);
        assertThat(ranked.get(0).average()).isEqualTo(300.0);
        assertThat(ranked.get(1).average()).isEqualTo(500.0);
        assertThat(ranked).extracting(RankingEngine.Ranked::displayRank).containsExactly(1, 2);
    }

    // ---- Dimension 2: total differential, above score ----
    @Test
    void differentialOutranksScoreOnEqualWinPoints() {
        var ranked = RankingEngine.rank(List.of(
            row("1001", 4, 120, 900, 3),    // average 300.0
            row("1002", 4, 80, 1200, 3)));  // average 400.0
        assertThat(order(ranked)).containsExactly("1001", "1002");
        assertThat(ranked.get(0).diff()).isEqualTo(120);
        assertThat(ranked.get(1).diff()).isEqualTo(80);
        assertThat(ranked).extracting(RankingEngine.Ranked::displayRank).containsExactly(1, 2);
    }

    // ---- Dimension 3: head-to-head, inside a win-point + differential tie ----
    @Test
    void headToHeadPromotesTheWinnerPastABetterScore() {
        var rows = List.of(
            row("1001", 4, 100, 900, 3),    // average 300.0
            row("1002", 4, 100, 1200, 3));  // average 400.0
        assertThat(order(RankingEngine.rank(rows)))
            .as("without head-to-head the better average leads")
            .containsExactly("1002", "1001");
        assertThat(order(RankingEngine.rank(rows, beat("1001", "1002"))))
            .as("1001 beat 1002, so it rises past the better average")
            .containsExactly("1001", "1002");
    }

    @Test
    void headToHeadCannotLeapfrogSomeoneTheyDidNotBeat() {
        var rows = List.of(
            row("1001", 4, 100, 1500, 3),   // average 500.0 — never beaten by 1003
            row("1002", 4, 100, 1200, 3),   // average 400.0
            row("1003", 4, 100, 900, 3));   // average 300.0 — beat 1002 only
        assertThat(order(RankingEngine.rank(rows, beat("1003", "1002"))))
            .as("the walk stops at the first player 1003 did not beat")
            .containsExactly("1001", "1003", "1002");
    }


    /**
     * The owner's worked example, as a fixture.
     *
     * <p>Four players share a win-point and differential group. Their baseline order comes from
     * average score: A, D, C, B. C beat A and B beat A; nothing else in the group has met. The
     * confirmed rule is that A moves below BOTH of the players who beat it, while every pair the
     * head-to-head evidence does not resolve keeps the order the baseline gave it — so D stays above
     * C, C stays above B, and D keeps its position relative to them.
     *
     * <p>This is the case an adjacency-only walk cannot express: D sits between A and C with no
     * head-to-head relationship to either, so a pass that stops at the first unbeaten neighbour
     * never lets C's win over A count at all.
     */
    @Test
    void headToHeadMovesALoserBelowEveryoneWhoBeatThem() {
        var rows = List.of(
            row("A", 4, 100, 400, 1),    // average 400 — baseline first
            row("D", 4, 100, 390, 1),    // average 390 — has met nobody in the group
            row("C", 4, 100, 380, 1),    // average 380 — beat A
            row("B", 4, 100, 370, 1));   // average 370 — beat A
        assertThat(order(RankingEngine.rank(rows)))
            .as("baseline ordering, before any head-to-head correction")
            .containsExactly("A", "D", "C", "B");

        var ranked = RankingEngine.rank(rows, beatenBy("A", "C", "B"));
        assertThat(order(ranked))
            .as("A falls below both C and B; every unresolved pair keeps its baseline order")
            .containsExactly("D", "C", "B", "A");
        assertThat(ranked).extracting(RankingEngine.Ranked::displayRank).containsExactly(1, 2, 3, 4);
    }

    /**
     * A head-to-head cycle cannot be satisfied, and must not hang or throw. The group falls back to
     * the baseline ordering for the members the cycle cannot decide.
     */
    @Test
    void aHeadToHeadCycleFallsBackToTheBaselineOrdering() {
        var rows = List.of(
            row("1001", 4, 100, 400, 1),
            row("1002", 4, 100, 390, 1),
            row("1003", 4, 100, 380, 1));
        H2HProvider cycle = new H2HProvider() {
            public boolean hasMet(String playerId, String opponentId) { return true; }
            public Verdict verdict(String playerId, String opponentId) {
                // 1001 beats 1002 beats 1003 beats 1001
                String[] ring = { "1001", "1002", "1003" };
                int me = List.of(ring).indexOf(playerId), them = List.of(ring).indexOf(opponentId);
                return (me + 1) % 3 == them ? Verdict.BETTER : Verdict.WORSE;
            }
        };
        assertThat(order(RankingEngine.rank(rows, cycle))).containsExactly("1001", "1002", "1003");
    }

    // ---- Dimension 4: score, when the three above cannot separate ----
    @Test
    void scoreSeparatesPlayersWhoNeverMet() {
        var ranked = RankingEngine.rank(List.of(
            row("1001", 4, 100, 900, 3),     // average 300.0
            row("1002", 4, 100, 1200, 3)));  // average 400.0
        assertThat(order(ranked)).containsExactly("1002", "1001");
        assertThat(ranked).extracting(RankingEngine.Ranked::displayRank).containsExactly(1, 2);
    }

    /**
     * Owner-confirmed: the fourth dimension IS average score ({@code scoreFor / games}), not total
     * points scored. The two agree whenever the players have played the same number of games and
     * disagree otherwise, as here: 1001 has scored 1200 points to 1002's 1000, yet 1002 ranks first
     * on an average of 333.33 against 300.0. That is the intended rule, not a defect.
     */
    @Test
    void theFourthDimensionIsAverageScoreRatherThanTotalPointsScored() {
        var ranked = RankingEngine.rank(List.of(
            row("1001", 4, 100, 1200, 4),
            row("1002", 4, 100, 1000, 3)));
        assertThat(ranked.get(0).playerId()).isEqualTo("1002");
        assertThat(ranked.get(0).average()).isEqualTo(1000d / 3);
        assertThat(ranked.get(1).average()).isEqualTo(300.0);
        assertThat(Map.of("1001", 1200L, "1002", 1000L).get(ranked.get(1).playerId()))
            .as("the player with MORE total points is the one placed second")
            .isEqualTo(1200L);
    }

    /**
     * Owner-confirmed priority: within an equal WinPoint / equal Diff group, an available
     * head-to-head result outranks Average Score — however far apart the averages are, and even
     * when they are identical. Average Score decides a pair only where head-to-head is silent.
     * (Owner cases 1, 2 and 3; the same three are pinned for both languages in
     * {@code docs/ranking-vectors.json}.)
     */
    @Test
    void headToHeadOutranksAverageScoreInsideAWinPointAndDiffGroup() {
        // Case 1 — a far better average loses to the head-to-head result.
        var lopsided = List.of(row("A", 6, 100, 200, 1), row("B", 6, 100, 500, 1));
        var beaten = RankingEngine.rank(lopsided, beatenBy("B", "A"));
        assertThat(order(beaten)).as("A beat B, so A leads on 200 against 500").containsExactly("A", "B");
        assertThat(beaten).extracting(RankingEngine.Ranked::displayRank).containsExactly(1, 2);

        // Case 2 — identical figures are still separated by the head-to-head result.
        var level = List.of(row("A", 6, 100, 300, 1), row("B", 6, 100, 300, 1));
        var separated = RankingEngine.rank(level, beatenBy("B", "A"));
        assertThat(order(separated)).containsExactly("A", "B");
        assertThat(separated).extracting(RankingEngine.Ranked::displayRank)
            .as("a pair head-to-head separated cannot share a rank").containsExactly(1, 2);

        // Case 3 — with no head-to-head, the baseline average decides and nothing is separated.
        var unplayed = RankingEngine.rank(lopsided);
        assertThat(order(unplayed)).as("never met, so the higher average leads").containsExactly("B", "A");
        assertThat(unplayed).extracting(RankingEngine.Ranked::displayRank).containsExactly(1, 2);
    }

    /**
     * Head-to-head is the THIRD dimension, not the first. It never reaches across a difference in
     * WinPoint or Diff, because those are decided before any group is formed. (Owner cases 4 and 5.)
     */
    @Test
    void headToHeadNeverOverridesWinPointsOrDifferential() {
        // Case 4 — A beat B, but B's differential is higher, so they never share a group.
        var byDiff = RankingEngine.rank(
            List.of(row("A", 6, 90, 500, 1), row("B", 6, 100, 200, 1)), beatenBy("B", "A"));
        assertThat(order(byDiff)).as("differential is decided above head-to-head").containsExactly("B", "A");

        // Case 5 — A beat B and leads on every other figure, and still ranks second on win points.
        var byWinPoints = RankingEngine.rank(
            List.of(row("A", 4, 500, 500, 1), row("B", 6, -100, 100, 1)), beatenBy("B", "A"));
        assertThat(order(byWinPoints)).as("win points are decided above everything").containsExactly("B", "A");
    }

    /**
     * Genuinely unresolved players still share a displayed rank: equal on every figure AND with no
     * head-to-head between them. Only an actual result breaks a tie.
     */
    @Test
    void playersTheRulesCannotSeparateStillShareADisplayedRank() {
        var ranked = RankingEngine.rank(List.of(
            row("1001", 4, 100, 1200, 3),
            row("1002", 4, 100, 1200, 3)));
        assertThat(ranked).extracting(RankingEngine.Ranked::displayRank).containsExactly(1, 1);
    }
}
