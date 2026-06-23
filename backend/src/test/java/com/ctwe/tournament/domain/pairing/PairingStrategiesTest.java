package com.ctwe.tournament.domain.pairing;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class PairingStrategiesTest {
    private static final PairingStrategy.PairingContext CONTEXT = new PairingStrategy.PairingContext(2, List.of());

    @Test
    void kingOfTheHillPairsAdjacentPlayersAfterRankingByWinPointsAndDiff() {
        var players = List.of(
            score("D", 2, 10), score("B", 4, 20), score("A", 4, 40), score("C", 2, 30)
        );

        assertThat(new KingOfTheHillStrategy().generate(players, CONTEXT)).containsExactly(
            pair("A", "B"), pair("C", "D")
        );
    }

    @Test
    void swissPairsTopHalfAgainstBottomHalfInsideEachScoreGroup() {
        var players = List.of(
            score("D", 4, 10), score("B", 4, 30), score("H", 2, 10), score("F", 2, 30),
            score("A", 4, 40), score("C", 4, 20), score("E", 2, 40), score("G", 2, 20)
        );

        assertThat(new SwissStrategy().generate(players, CONTEXT)).containsExactly(
            pair("A", "C"), pair("B", "D"), pair("E", "G"), pair("F", "H")
        );
    }

    @Test
    void swissPullsBestRankedPlayerFromNextLowerGroupWhenUpperGroupIsOdd() {
        var players = List.of(
            score("A", 4, 30), score("B", 4, 20), score("C", 4, 10),
            score("D", 2, 50), score("E", 2, 40), score("F", 2, 30),
            score("G", 0, 20), score("H", 0, 10)
        );

        assertThat(new SwissStrategy().generate(players, CONTEXT)).containsExactly(
            pair("A", "C"), pair("B", "D"), pair("E", "F"), pair("G", "H")
        );
    }

    private static PairingStrategy.PlayerScore score(String id, int winPoints, int diff) {
        return new PairingStrategy.PlayerScore(id, "school", winPoints, diff);
    }

    private static PairingStrategy.Pair pair(String one, String two) {
        return new PairingStrategy.Pair(one, two);
    }
}
